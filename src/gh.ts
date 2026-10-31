import { KanbanDb, type GhLinkKind, type GhStatus } from "./db";

/** Author of gh-sync lane moves and comments — the audit trail for auto-advance. */
export const GH_SYNC_AUTHOR = "gh-sync";

/** Runs one `gh` invocation, returning its parsed stdout JSON; throws on non-zero exit. */
export type GhJsonRunner = (args: string[]) => Promise<unknown>;

/**
 * Spawn gh (git.ts pattern: args array, never a shell) and parse stdout.
 * The binary comes from KANBAN_GH_BIN when set — the test seam — else `gh`.
 */
export function defaultGhRunner(args: string[]): Promise<unknown> {
  const bin = process.env.KANBAN_GH_BIN ?? "gh";
  const proc = Bun.spawn({ cmd: [bin, ...args], stdout: "pipe", stderr: "pipe" });
  return (async () => {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if ((await proc.exited) !== 0) {
      throw new Error(err.trim() || `${bin} ${args[0]} failed`);
    }
    try {
      return JSON.parse(out);
    } catch {
      throw new Error(`${bin} ${args[0]} printed invalid JSON`);
    }
  })();
}

const REPO = "([A-Za-z0-9_.-]+)";
const PR_RE = new RegExp(`^https://github\\.com/${REPO}/${REPO}/pull/(\\d+)/?$`);
const ISSUE_RE = new RegExp(`^https://github\\.com/${REPO}/${REPO}/issues/(\\d+)/?$`);
const SHORTHAND_RE = new RegExp(`^gh:${REPO}/${REPO}#(\\d+)$`);

/**
 * The one ref grammar (anchored, case-sensitive; a trailing `/` is allowed on urls):
 * `https://github.com/{o}/{r}/pull/{n}`, `.../issues/{n}`, or `gh:{o}/{r}#{n}`.
 * Shorthand canonicalizes to `https://github.com/{o}/{r}/issues/{n}` (GitHub serves
 * prs at /issues/{n} too) with kind "unknown" until the first sync resolves it.
 * Anything else → null; a ref can never collide with a file path.
 */
export function parseGhRef(input: string): { url: string; kind: GhLinkKind; repo: string; number: number } | null {
  const pr = PR_RE.exec(input);
  if (pr) return { url: `https://github.com/${pr[1]}/${pr[2]}/pull/${pr[3]}`, kind: "pr", repo: `${pr[1]}/${pr[2]}`, number: Number(pr[3]) };
  const issue = ISSUE_RE.exec(input);
  if (issue) return { url: `https://github.com/${issue[1]}/${issue[2]}/issues/${issue[3]}`, kind: "issue", repo: `${issue[1]}/${issue[2]}`, number: Number(issue[3]) };
  const short = SHORTHAND_RE.exec(input);
  if (short) return { url: `https://github.com/${short[1]}/${short[2]}/issues/${short[3]}`, kind: "unknown", repo: `${short[1]}/${short[2]}`, number: Number(short[3]) };
  return null;
}

interface GhView {
  state: string;
  mergedAt?: string | null;
  title?: string;
}

/** Last line(s) of an error message — error columns and CLI messages stay one-line short. */
function tail(message: string, max = 200): string {
  const one = message.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(-max) : one;
}

/**
 * Live state of one pr/issue via `gh pr view` (falls back to `gh issue view`).
 * mergedAt is epoch ms. Both views fail → Error("gh failed: …") with the stderr tails.
 */
export async function fetchGhStatus(
  ref: { repo: string; number: number },
  run: GhJsonRunner = defaultGhRunner,
): Promise<{ kind: "pr" | "issue"; state: string; title: string; mergedAt: number | null }> {
  let prError: unknown;
  try {
    const json = (await run(["pr", "view", `${ref.repo}#${ref.number}`, "--json", "state,mergedAt,title"])) as GhView;
    return {
      kind: "pr",
      state: json.state,
      title: json.title ?? "",
      mergedAt: json.mergedAt ? Date.parse(json.mergedAt) : null,
    };
  } catch (err) {
    prError = err;
  }
  try {
    const json = (await run(["issue", "view", `${ref.repo}#${ref.number}`, "--json", "state,title"])) as GhView;
    return { kind: "issue", state: json.state, title: json.title ?? "", mergedAt: null };
  } catch (issueError) {
    throw new Error(`gh failed: ${tail(String((prError as Error)?.message ?? prError))} · ${tail(String((issueError as Error)?.message ?? issueError))}`);
  }
}

export interface GhIssue {
  number: number;
  title: string;
  body: string;
  url: string;
}

/** Open issues of one repo, capped at `limit` — the import seeder's only gh call. */
export async function listOpenIssues(repo: string, limit: number, run: GhJsonRunner = defaultGhRunner): Promise<GhIssue[]> {
  const json = (await run(["issue", "list", "--repo", repo, "--state", "open", "--json", "number,title,body,url", "--limit", String(limit)])) as Array<{
    number?: number;
    title?: string;
    body?: string;
    url?: string;
  }>;
  if (!Array.isArray(json)) throw new Error("gh issue list printed invalid JSON");
  return json
    .filter((i) => typeof i?.number === "number" && typeof i?.url === "string")
    .map((i) => ({ number: i.number as number, title: i.title ?? "", body: i.body ?? "", url: i.url as string }));
}

/**
 * Fetch one url's live state and cache it (kind resolves "unknown" links).
 * Failure: a prior cache row is rewritten with the new fetchedAt + error (backoff
 * by TTL); no prior row writes nothing. Returns the fresh row, or null on failure.
 */
export async function refreshGhUrl(
  db: KanbanDb,
  url: string,
  opts: { run?: GhJsonRunner; now?: () => number } = {},
): Promise<GhStatus | null> {
  const now = opts.now ?? Date.now;
  const ref = parseGhRef(url);
  if (!ref || ref.kind === "unknown") return null;
  try {
    const status = await fetchGhStatus({ repo: ref.repo, number: ref.number }, opts.run);
    const row: GhStatus = {
      url,
      kind: status.kind,
      state: status.state,
      title: status.title,
      mergedAt: status.mergedAt,
      fetchedAt: now(),
      error: "",
    };
    db.setGhState(row);
    db.setGhLinkKind(url, status.kind);
    return row;
  } catch (err) {
    const prior = db.ghState(url);
    if (!prior) return null;
    db.setGhState({ ...prior, fetchedAt: now(), error: tail(String((err as Error)?.message ?? err)) });
    return null;
  }
}

export interface GhSyncStats {
  /** Stale urls refreshed this pass. */
  checked: number;
  /** Refreshes that produced a fresh row. */
  updated: number;
  /** Refreshes that failed (with or without a prior row). */
  failed: number;
  /** Cards auto-advanced to Done by a merged pr, with the url that caused it. */
  advanced: Array<{ cardId: string; url: string }>;
}

/** Lanes the gh sync must never touch — parked-for-a-human and finished work. */
const GH_EXEMPT_LANES = new Set(["done", "archive", "waiting"]);

/**
 * One sync pass: refresh stale urls (TTL cache in gh_state), then auto-advance —
 * every card linked to a MERGED pr outside the exempt lanes moves to done with a
 * gh-sync comment. Once per (card, url): a gh-sync comment already naming the
 * pr (url or repo#n) means the card was advanced by that pr before and is never
 * touched again, even after a human moves it back out.
 */
export async function syncGh(
  db: KanbanDb,
  opts: { run?: GhJsonRunner; now?: () => number; ttlMs?: number } = {},
): Promise<GhSyncStats> {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? 60_000;
  const stats: GhSyncStats = { checked: 0, updated: 0, failed: 0, advanced: [] };

  const urls = [...new Set(db.ghUrls())];
  const resolved = new Map<string, GhStatus | null>();
  for (const url of urls) {
    const prior = db.ghState(url);
    if (prior && now() - prior.fetchedAt < ttlMs) {
      resolved.set(url, prior);
      continue;
    }
    stats.checked++;
    const fresh = await refreshGhUrl(db, url, opts);
    if (fresh) stats.updated++;
    else stats.failed++;
    resolved.set(url, fresh ?? db.ghState(url));
  }

  for (const url of urls) {
    const status = resolved.get(url);
    if (!status || status.kind !== "pr" || status.state !== "MERGED") continue;
    const ref = parseGhRef(url)!;
    const marker = `${ref.repo}#${ref.number}`;
    for (const card of db.ghLinkCards(url)) {
      if (GH_EXEMPT_LANES.has(card.laneId)) continue;
      const already = db
        .comments(card.id)
        .some((c) => c.author === GH_SYNC_AUTHOR && (c.body.includes(url) || c.body.includes(marker)));
      if (already) continue;
      db.moveTask(card.id, "done", undefined, { cause: "gh", actor: GH_SYNC_AUTHOR });
      db.createComment(card.id, {
        author: GH_SYNC_AUTHOR,
        kind: "comment",
        body: `PR ${marker} merged — moved to Done`,
      });
      stats.advanced.push({ cardId: card.id, url });
    }
  }
  return stats;
}

export interface GhImportStats {
  created: number;
  skipped: number;
  /** The created cards, in gh's order — the CLI prints one dim line per card. */
  cards: Array<{ number: number; cardId: string }>;
}

/**
 * Seed the Backlog from a repo's open issues. Dedup by url: an issue whose url
 * already sits on any card (gh_links) is skipped, so re-runs are idempotent and
 * deleting an imported card lets a re-import recreate it. New cards carry the
 * link and a pre-seeded OPEN gh_state so badges render without another gh call.
 */
export async function importIssues(
  db: KanbanDb,
  repo: string,
  opts: { run?: GhJsonRunner; limit?: number; now?: () => number } = {},
): Promise<GhImportStats> {
  const now = opts.now ?? Date.now;
  const issues = await listOpenIssues(repo, opts.limit ?? 50, opts.run);
  const stats: GhImportStats = { created: 0, skipped: 0, cards: [] };
  for (const issue of issues) {
    if (db.ghLinkCards(issue.url).length > 0) {
      stats.skipped++;
      continue;
    }
    const card = db.createTask({
      title: `#${issue.number} ${issue.title}`.trim(),
      note: issue.body.slice(0, 4000),
      lane: "backlog",
    });
    db.attachGhLink(card.id, { url: issue.url, kind: "issue", repo, number: issue.number });
    db.setGhState({ url: issue.url, kind: "issue", state: "OPEN", title: issue.title, mergedAt: null, fetchedAt: now(), error: "" });
    stats.created++;
    stats.cards.push({ number: issue.number, cardId: card.id });
  }
  return stats;
}

/**
 * The serve process's gh sync loop: one immediate pass, then every intervalMs
 * (default 60s). Errors log and never leave the timer. The timer is unref()ed
 * so a boot-scoped loop cannot hold the process open; stop() clears it.
 */
export function startGhSync(opts: {
  db: KanbanDb;
  intervalMs?: number;
  run?: GhJsonRunner;
  log?: (message: string) => void;
}): { stop(): void } {
  const log = opts.log ?? ((message: string) => console.log(`[gh] ${message}`));
  const pass = (): void => {
    void syncGh(opts.db, { ...(opts.run ? { run: opts.run } : {}) }).catch((err: unknown) => {
      log(String((err as Error)?.message ?? err));
    });
  };
  pass();
  const timer = setInterval(pass, opts.intervalMs ?? 60_000);
  timer.unref?.();
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
