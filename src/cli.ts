#!/usr/bin/env bun
import { closeSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { KanbanDb, KanbanError, RESERVED_FILE_NAMES, UNBLOCKED_LANES, defaultDbPath, type Priority, type Task, type TaskPatch } from "./db";
import { charterError, charterFor } from "./lane-workers";
import { c, colorizePatch, commentLine, commentThread, fileSize, laneList, listLanes, ownedLines, overviewLine, searchResults, statsBoard, statsCard, taskDetail, taskLine } from "./render";
import { importIssues, parseGhRef, refreshGhUrl } from "./gh";
import { searchBoard, HARD_RESULT_LIMIT, MAX_RESULTS } from "./search";
import { cardFileDiff } from "./diff";
import { VERSION, headState } from "./version";

export const HELP = `kanban ${VERSION} — task board for the pi agent

usage:
  kanban add <title…> [--note <text>] [--lane <ref>] [--project <tag>] [--tag <tag>]… [--parent <id>]
                      [--priority <high|normal|low>] [--blocked-by <id>]… [--top] [--elaborate]
  kanban ls [lane] [--project <tag>] [--tag <tag>]… [--owner <name>] [--json]
  kanban next [--project <tag>] [--json]  (what's next: lane priority, then card priority, then oldest; skips blocked)
  kanban search <query…> [--project <tag>] [--tag <tag>]… [--limit <n>] [--json]   (default 20 rows, --limit up to 50)
  kanban show <id>
  kanban link <id> <other>                (relate two cards; visible from both)
  kanban unlink <id> <other>
  kanban elaborate <id>                     (queue AI note elaboration; runs on the auto-agent loop)
  kanban attach <id> <file|gh-ref> [--as <name>]  (files: default name plan, re-attach versions; GitHub refs: <pr-url|issue-url|gh:owner/repo#n>)
  kanban gh unlink <id> <ref>                (remove a GitHub link; ref: url, gh:owner/repo#n, or #n)
  kanban import gh:<owner>/<repo> [--limit <n>]  (seed Backlog from the repo's open GitHub issues)
  kanban files <id> [--json]                  (card files: name · vN · size · source)
  kanban cat <id> <name> [--v <n>]            (print a file's content, latest or a given version)
  kanban diff <id> <name> [--from <n>] [--to <n>]  (unified diff between versions; default: the latest pair)
  kanban ws <id> <branch>                    (record/clear where the card's implementation lives)
  kanban comment <id> <text…> [--author <name>] [--kind <comment|review|handoff|question>]
  kanban comments <id>
  kanban handoff <id> <lane> --message <text> [--author <name>]   (atomic move + thread record)
  kanban review <id> (--approve | --block --message <text> [--finding <text>]…)
  kanban approve <id>                       (plan gate: approve the attached plan → Implement)
  kanban reject <id> --message <feedback>   (plan gate: reject with feedback; planner re-plans)
  kanban plan-review <id> (--pass | --block --message <text> [--finding <text>]…)  (plan reviewer's verdict; --pass parks the card in "Waiting on you")
  kanban claim <id> [--author <name>] [--force]  (record who's building it; --force takes over)
  kanban overview [--json]                  (board shape: lane counts, WIP limits, owned cards)
  kanban brief <id>                         (pickup context: note, plan, thread)
  kanban mv <id> <lane> [--pos <1-based> | --before <id>]   kanban mv <id> --next | --prev
                          (--before <anchorId> places the card directly before the anchor)
  kanban edit <id> [--title <t>] [--note <text>] [--project <tag>] [--tag <tag>]… [--lane <ref>]
                          [--parent <id>] [--priority <high|normal|low>] [--blocked-by <id>…]
                          [--clear-note] [--clear-parent] [--clear-blocked-by] [--clear-tags]
  kanban done <id>
  kanban archive <id> | auto [<n>|off]        (card → Archive; auto: done cards archive after N days — off disables, default 7; undo: kanban undo, or mv <id> <lane>)
  kanban undo [id]                           (revert the last lane move on the board, or on one card)
  kanban check [--json] [--port <n>]        (board-health lint: done parents w/ active children, children behind parent, planless build cards, lanes over WIP limit, stale/down serve; advisory, exit 0)
  kanban stats [id]                     (board summary, or one card's lane times / cycle / gate metrics)
  kanban rm <id> [--force]                   (deleting a parent needs --force)
  kanban lane ls | add <name> | rename <ref> <name> | rm <ref> [--force] | limit <ref> <n|off>
  kanban worker run <lane> [--focus <text>] [--author <name>]   (queue a lane worker run; drained by serve --agents)
  kanban worker ls [--lane <ref>] [--json]     (lane worker runs: id · lane · status · age · summary)
  kanban serve [--port <n>] [--open] [--agents] [--fg]  (backgrounds itself by default: kanban ps to check, kanban stop to stop; --fg stays foreground)
  kanban stop [--port <n>]                     (SIGTERM the kanban server; graceful — traces in-flight agents)
  kanban ps [--json]                           (running serves on any port + their live agent sessions + abandoned leases)
  kanban help | version

lane refs: slug (backlog), prefix (imp), name prefix (Rev), or ordinal (1..n)
task ids: any unique prefix works. add --json for machine-readable output.
search: ranks titles, checklist lines, note text, then plans — same results as the web dropdown.
hierarchy: --parent nests a card (epic → story → subtask, max depth 3).
threads: comment/handoff/review append to the card thread; brief prints full pickup context.
waiting: kind-question comments and plan-review passes park the card in the fixed first lane
"Waiting on you"; any human reply returns it, and the plan gate (approve/reject) works on cards parked from Plan.
agents: serve --agents (deprecated alias: --auto-review) runs the pi agent loop — a reviewer for cards
in Review (thinking max; block → pi-builder works the findings, max 3 cycles), a planner for cards in
Plan — it writes the plan from the shared template, asks open questions (kind question) when an answer
would change the plan, then hands off to a pi plan-reviewer that checks the plan against the template
checklist (max 2 block rounds per human comment); a passing review parks the card in "Waiting on you",
where the human gate is kanban approve (arms a plan-build pi-builder) or kanban reject --message
(re-plans with the feedback); the same loop elaborates newly added cards on request
(add --elaborate / the ✨ composer toggle). Agents configurable in the web ui → ≡.`;

export interface Parsed {
  flags: Record<string, string | true | string[]>;
  positional: string[];
}

const VALUE_FLAGS = new Set(["note", "lane", "project", "pos", "title", "port", "parent", "author", "kind", "message", "priority", "as", "v", "from", "to", "limit", "before", "owner", "focus"]);
const BOOL_FLAGS = new Set(["json", "force", "next", "prev", "open", "fg", "top", "clear-note", "clear-parent", "approve", "block", "auto-review", "agents", "pass", "clear-blocked-by", "clear-tags", "elaborate", "clear"]);
const MULTI_FLAGS = new Set(["finding", "blocked-by", "tag"]); // repeatable: each occurrence appends one value

export function parse(argv: string[]): Parsed {
  const flags: Record<string, string | true | string[]> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (BOOL_FLAGS.has(key)) flags[key] = true;
      else if (MULTI_FLAGS.has(key)) {
        const v = flags[key];
        const next = argv[++i] ?? "";
        if (Array.isArray(v)) v.push(next);
        else flags[key] = [next];
      } else if (VALUE_FLAGS.has(key)) flags[key] = argv[++i] ?? "";
      else throw new KanbanError(`unknown flag '${a}' (see: kanban help)`, "invalid");
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

export function applyServeEnv(flags: Parsed["flags"]): void {
  if (flags.agents || flags["auto-review"]) process.env.KANBAN_AUTO_REVIEW = "1";
  // stderr directly: serve never returns from boot(), so outBuf never flushes
  if (flags["auto-review"] && !flags.agents)
    console.error("kanban: --auto-review is deprecated — use --agents (identical behavior)");
}

const str = (flags: Parsed["flags"], key: string): string | undefined => {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
};

const arr = (flags: Parsed["flags"], key: string): string[] => {
  const v = flags[key];
  return Array.isArray(v) ? v : [];
};

function jsonOut(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}

/** All CLI stdout funnels through here: importing render.ts touches process.stdout
 * (isTTY/columns), which in Bun 1.4.2 flips console.log onto a buffered stream that
 * is not flushed at process exit — piped output past 64 KiB is dropped (oven-sh/bun#36419).
 * Buffering and flushing once via an awaited process.stdout.write delivers the full
 * payload; the write callback fires only after the flush. */
const outBuf: string[] = [];
function out(s: string): void {
  outBuf.push(s);
}

async function flushOut(): Promise<void> {
  if (outBuf.length === 0) return;
  const payload = outBuf.join("\n") + "\n";
  outBuf.length = 0;
  process.stdout.on("error", (e) => {
    if ((e as NodeJS.ErrnoException).code !== "EPIPE") throw e; // reader closed early: exit code already decided
  });
  await new Promise<void>((resolve) => {
    process.stdout.write(payload, () => resolve());
  });
}

/** Relative lane for --next / --prev. */
function stepLane(db: KanbanDb, task: Task, delta: number): string {
  const lanes = db.lanes();
  const i = lanes.findIndex((l) => l.id === task.laneId);
  const next = i + delta;
  if (next < 0 || next >= lanes.length) {
    throw new KanbanError(delta < 0 ? "already in the first lane" : "already in the last lane", "conflict");
  }
  return lanes[next].id;
}

/** Fixed target lane for done/archive — no silent fallback to another lane. */
function laneById(db: KanbanDb, id: string): string {
  const lane = db.lanes().find((l) => l.id === id);
  if (!lane) throw new KanbanError(`no '${id}' lane on this board`, "not-found");
  return lane.id;
}

/** Soft done-warning: children still in active lanes after their parent reached Done — advisory only. */
function warnActiveChildren(db: KanbanDb, task: Task): void {
  const active = db.activeChildren(task.id);
  if (active.length > 0) {
    out(
      c.hex(
        "#d29922",
        `warning: ${active.length} children still active (${active.map((t) => t.id).join(", ")}) — advance or archive them if the work is done`,
      ),
    );
  }
}

/** PIDs with a TCP listener on `port` (lsof — the same probe repro.sh uses). pid 0 must be
 * dropped: lsof's trailing empty line becomes Number("") === 0, and kill(0) signals the
 * caller's whole process group — suicide. */
function listenerPids(port: number): number[] {
  const out = Bun.spawnSync(["lsof", "-t", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  return out.stdout
    .toString()
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Compact age for worker-ls rows: 42s · 8m · 3h · 5d. */
function ageShort(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export interface ServeWarning {
  kind: "serve-down" | "serve-stale" | "serve-dirty" | "serve-version-split" | "serve-head-split";
  message: string;
}

const short = (sha: string): string => sha.slice(0, 7);

interface Health {
  ok?: boolean;
  version?: string;
  pid?: number;
  booted?: number;
  git?: { commit: string | null; head: string | null; dirty: boolean } | null;
}

/** Loopback TCP listener ports on this machine (lsof, like listenerPids but every
 * port — a serve may run anywhere: default 4600, repro scratch ports, --port). */
function listenPorts(): number[] {
  const res = Bun.spawnSync(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"]);
  const ports = new Set<number>();
  for (const line of res.stdout.toString().split("\n")) {
    const m = line.match(/\bTCP\s+(\S+)\s+\(LISTEN\)/i);
    if (!m) continue;
    const name = m[1]; // "127.0.0.1:4600", "[::1]:4600", "*:5174"
    const idx = name.lastIndexOf(":");
    if (idx === -1) continue;
    const host = name.slice(0, idx).replace(/^\[/, "").replace(/\]$/, "");
    const port = Number(name.slice(idx + 1));
    if (!Number.isInteger(port) || port <= 0) continue;
    if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost" && host !== "*") continue;
    ports.add(port);
  }
  return [...ports];
}

export interface ServeInstance {
  port: number;
  pid: number | null;
  version: string | null;
  booted: number | null;
  git: Health["git"];
}

interface ActivitySession {
  taskId: string;
  role: string;
  startedAt: number;
  model?: string;
  modelLabel?: string;
  pool?: string;
}
interface ActivityQueued {
  taskId: string;
  role: string;
  enqueuedAt: number;
}
interface ActivitySnapshot {
  sessions: ActivitySession[];
  queued: ActivityQueued[];
}

/** pid liveness via signal 0 — EPERM (alive but not ours) still counts; ESRCH means gone. */
function pidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code !== "ESRCH";
  }
}

/** /health vouched as kanban: ok:true with a numeric pid and string version.
 * Kanban's /health always carries both; look-alikes (a docker program-tracker
 * answering {"ok":true} on :4000) do not. */
async function vouchedHealth(port: number, timeoutMs = 1000): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json().catch(() => null)) as Health | null;
    if (body && body.ok === true && typeof body.pid === "number" && typeof body.version === "string") {
      return body;
    }
  } catch {
    /* down */
  }
  return null;
}

/** Every kanban serve on this machine, any port: loopback listeners probed with
 * a vouched /health (see vouchedHealth). */
export async function scanServes(): Promise<ServeInstance[]> {
  const found = await Promise.all(
    listenPorts().map(async (port): Promise<ServeInstance | null> => {
      const body = await vouchedHealth(port, 500);
      if (!body) return null;
      return { port, pid: body.pid!, version: body.version!, booted: body.booted ?? null, git: body.git ?? null };
    }),
  );
  return found
    .filter((s): s is ServeInstance => s !== null)
    .sort((a, b) => a.port - b.port);
}

/**
 * Serve-side health for `kanban check`: is the board's server up, current, and
 * the same build as this CLI? /health reports its boot commit, live HEAD, and
 * version — compare against this checkout to catch a stale serve (src changed,
 * no restart), a version split (symlinked CLI ahead of an old serve), and a
 * head split (serve running from a different tree, e.g. a worktree).
 */
export async function serveWarnings(port: number): Promise<ServeWarning[]> {
  let health: Health | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json().catch(() => null)) as Health | null;
    if (body && body.ok === true) health = body;
  } catch {
    /* down — reported below */
  }
  if (!health) {
    return [{ kind: "serve-down", message: `no kanban server on port ${port} — kanban serve` }];
  }
  const out: ServeWarning[] = [];
  const git = health.git ?? null;
  if (git?.commit && git.head) {
    if (git.commit !== git.head) {
      out.push({
        kind: "serve-stale",
        message: `serve booted at ${short(git.commit)}, HEAD is ${short(git.head)} — restart it (board header ⟳ stale chip or settings → restart service)`,
      });
    }
    const local = headState();
    if (local?.head && local.head !== git.head) {
      out.push({
        kind: "serve-head-split",
        message: `serve HEAD ${short(git.head)} ≠ this checkout ${short(local.head)} — serve runs a different tree`,
      });
    }
  }
  if (git?.dirty) {
    out.push({ kind: "serve-dirty", message: "serve tree has uncommitted edits — running code may not match HEAD" });
  }
  if (health.version && health.version !== VERSION) {
    out.push({
      kind: "serve-version-split",
      message: `serve ${health.version} ≠ cli ${VERSION} — restart serve (symlinked cli runs new code against an old server)`,
    });
  }
  return out;
}

async function main(): Promise<number> {
  const argv = Bun.argv.slice(2);
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    out(HELP);
    return 0;
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    out(VERSION);
    return 0;
  }

  const { flags, positional } = parse(rest);
  if (flags.finding !== undefined && cmd !== "review" && cmd !== "plan-review") {
    throw new KanbanError("--finding is only valid with 'review --block' or 'plan-review --block'", "invalid");
  }

  if (cmd === "serve") {
    const port = Number(str(flags, "port") ?? process.env.PORT ?? 4600);
    if (flags.fg) {
      // --fg: run in-process — the daemon child's body and the restart respawn
      // target. One process, one cmdline: killing it kills the server and its
      // agent loop, no orphaned wrapper children.
      if (flags.open) setTimeout(() => Bun.spawn(["open", `http://127.0.0.1:${port}`]), 800);
      process.env.PORT = String(port);
      applyServeEnv(flags);
      const { boot } = await import("./index");
      await boot(); // resolves after listen; the listener keeps the process alive
      return 0;
    }
    // background by default: detach an --fg child and report. Idempotent — a
    // serve already on the port is success, not an error.
    if (listenerPids(port).length > 0) {
      const health = await vouchedHealth(port);
      if (health) {
        out(`serve already running — pid ${health.pid} :${port}  (kanban ps | kanban stop)`);
        return 0;
      }
      throw new KanbanError(
        `port ${port} is held by a non-kanban server — stop it yourself (lsof -nP -iTCP:${port} -sTCP:LISTEN)`,
        "conflict",
      );
    }
    const log = `/tmp/kanban-serve-${port}.log`;
    const logFd = openSync(log, "a");
    // --open stays with the wrapper: it opens only after /health is up, not on a
    // blind 800ms timer
    const childArgs = ["serve", "--fg", ...rest.filter((a) => a !== "--open")];
    const child = Bun.spawn([process.execPath, import.meta.path, ...childArgs], {
      detached: true,
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
      env: { ...process.env, PORT: String(port) },
    });
    child.unref();
    closeSync(logFd);
    const childPid = child.pid ?? 0;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const health = await vouchedHealth(port, 400);
      if (health) {
        if (flags.open) Bun.spawn(["open", `http://127.0.0.1:${port}`]);
        out(`${c.green("✓")} serve running in background — pid ${health.pid} :${port}`);
        out(c.dim(`  log ${log} · kanban ps · kanban stop`));
        return 0;
      }
      if (!pidAlive(childPid)) break; // child died — report from its log below
    }
    out(c.red(`serve failed to boot on :${port} — last log lines (${log}):`));
    const tail = readFileSync(log, "utf8").split("\n").filter(Boolean).slice(-5);
    for (const line of tail) out(c.dim(line));
    return 1;
  }

  if (cmd === "stop") {
    const port = Number(str(flags, "port") ?? process.env.PORT ?? 4600);
    const pids = listenerPids(port);
    if (pids.length === 0) {
      out(`no server listening on port ${port}`);
      return 0;
    }
    // never signal something we cannot vouch for (same spirit as the boot guard)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!body || body.ok !== true) throw new Error("not kanban");
    } catch {
      throw new KanbanError(
        `port ${port} is held by a non-kanban server — stop it yourself (lsof -nP -iTCP:${port} -sTCP:LISTEN)`,
        "conflict",
      );
    }
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    for (let i = 0; i < 50 && listenerPids(port).length > 0; i++) await new Promise((r) => setTimeout(r, 100));
    const stopped = listenerPids(port).length === 0;
    out(
      stopped
        ? `stopped the kanban server on port ${port}`
        : `signaled port ${port}; still listening — it may be draining, retry in a moment`,
    );
    return stopped ? 0 : 1;
  }

  const db = new KanbanDb(defaultDbPath());
  try {
    const json = !!flags.json;
    const project = str(flags, "project");

    switch (cmd) {
      case "add": {
        const title = positional.join(" ");
        if (!title) throw new KanbanError("usage: kanban add <title…>", "invalid");
        const blockedBy = Array.isArray(flags["blocked-by"]) ? flags["blocked-by"] : undefined;
        const task = db.createTask({
          title,
          note: str(flags, "note"),
          lane: str(flags, "lane"),
          project,
          tags: arr(flags, "tag").length > 0 ? arr(flags, "tag") : undefined,
          parent: str(flags, "parent"),
          priority: str(flags, "priority"),
          blockedBy,
          index: flags.top ? 0 : (str(flags, "pos") ? Number(str(flags, "pos")) - 1 : undefined),
        });
        if (flags["elaborate"]) db.queueElaboration(task.id);
        if (json) jsonOut(task);
        else {
          out(taskLine(db, task));
          if (flags["elaborate"]) {
            out(c.dim("✨ elaboration queued — the auto-agent loop (kanban serve --agents) will expand the note"));
          }
        }
        return 0;
      }

      case "ls": {
        const laneRef = positional[0];
        if (laneRef) db.resolveLane(laneRef); // validate before filtering
        const tagFilter = arr(flags, "tag");
        const ownerFilter = str(flags, "owner");
        const tasks = db
          .tasks()
          .filter((t) => (laneRef ? t.laneId === db.resolveLane(laneRef).id : true))
          .filter((t) => (project ? t.project === project : true))
          .filter((t) => (tagFilter.length > 0 ? tagFilter.every((tag) => t.tags.includes(tag)) : true))
          .filter((t) => (ownerFilter ? t.owner === ownerFilter : true));
        if (json) {
          const map = db.blockedByMap();
          jsonOut(tasks.map((t) => ({ ...t, blockedBy: map[t.id] ?? [] })));
        } else if (ownerFilter) {
          for (const t of tasks) out(taskLine(db, t)); // flat: one line per owned card
        } else {
          out(listLanes(db, laneRef, project, tagFilter));
        }
        return 0;
      }

      case "overview": {
        if (json) {
          const o = db.overview();
          jsonOut({
            lanes: o.lanes,
            owned: o.owned.map((t) => ({ id: t.id, title: t.title, laneId: t.laneId, owner: t.owner })),
          });
        } else {
          out(overviewLine(db));
          for (const line of ownedLines(db)) out(line);
        }
        return 0;
      }

      case "next": {
        const { task, blocked } = db.nextTask(project);
        const waiting = db.waitingCount(project);
        if (json) {
          jsonOut(
            task
              ? { ...task, blocked, waiting }
              : blocked > 0 || waiting > 0
                ? { task: null, blocked, waiting }
                : null,
          );
        } else {
          const warn = blocked > 0 ? `  ${c.hex("#d29922", `⚠ ${blocked} blocked card(s) skipped`)}` : "";
          const waitLine = waiting > 0 ? `  ${c.hex("#bc8cff", `☉ ${waiting} waiting on you`)}` : "";
          if (task) {
            out(`${taskLine(db, task)}${warn}${waitLine}`);
          } else {
            out(`${c.dim("nothing to pull forward")}${warn}${waitLine}`);
          }
        }
        return 0;
      }

      case "search": {
        const query = positional.join(" ").trim();
        if (!query)
          throw new KanbanError("usage: kanban search <query…> [--project <tag>] [--tag <tag>]… [--limit <n>] [--json]", "invalid");
        const tagFilter = arr(flags, "tag");
        const rawLimit = str(flags, "limit");
        let limit = MAX_RESULTS;
        if (rawLimit !== undefined) {
          if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > HARD_RESULT_LIMIT) {
            throw new KanbanError("--limit must be between 1 and 50", "invalid");
          }
          limit = Number(rawLimit);
        }
        const all = searchBoard(
          db
            .tasks()
            .filter((t) => (project ? t.project === project : true))
            .filter((t) => (tagFilter.length > 0 ? tagFilter.every((tag) => t.tags.includes(tag)) : true)),
          query,
          db.latestPlans(),
        );
        const results = all.slice(0, limit);
        const hidden = all.length - results.length;
        if (json) {
          jsonOut({
            results: results.map((r) => ({
              id: r.task.id,
              title: r.task.title,
              laneId: r.task.laneId,
              kind: r.kind,
              text: r.text,
              ...(r.checked !== undefined ? { checked: r.checked } : {}),
            })),
            matched: all.length,
            hasMore: hidden > 0,
            ...(hidden > 0
              ? { hint: `…+${hidden} more matches — narrow the query, or pass --limit up to ${HARD_RESULT_LIMIT}` }
              : {}),
          });
        } else {
          out(searchResults(db, query, results));
          if (hidden > 0) {
            out(c.dim(`…+${hidden} more matches — narrow the query, or pass --limit up to ${HARD_RESULT_LIMIT}`));
          }
        }
        return 0;
      }

      case "claim": {
        const idRef = positional[0];
        if (!idRef) throw new KanbanError("usage: kanban claim <id> [--author <name>] [--force]", "invalid");
        const task = db.claimTask(idRef, { author: str(flags, "author"), force: !!flags.force });
        if (json) jsonOut(task);
        else {
          out(taskLine(db, task));
          out(c.dim(`claimed by ${task.owner}`));
        }
        return 0;
      }

      case "show": {
        const task = db.resolveTask(positional[0] ?? "");
        if (json) {
          const map = db.blockedByMap();
          const linksMap = db.linksMap();
          jsonOut({
            ...task,
            blockedBy: map[task.id] ?? [],
            blocking: db.blocking(task.id).map((t) => t.id),
            links: linksMap[task.id] ?? [],
            ghLinks: db.ghLinksOf(task.id),
          });
        } else {
          out(taskDetail(db, task));
        }
        return 0;
      }

      case "link": {
        const aRef = positional[0];
        const bRef = positional[1];
        if (!aRef || !bRef) throw new KanbanError("usage: kanban link <id> <other-id>", "invalid");
        const a = db.resolveTask(aRef);
        const b = db.resolveTask(bRef);
        const links = db.linkCards(a.id, b.id);
        if (json) {
          jsonOut({ linked: links.map((t) => t.id) });
        } else {
          out(`${c.green("✓")} linked ${c.dim(a.id)} ↔ ${c.dim(b.id)}`);
        }
        return 0;
      }

      case "unlink": {
        const aRef = positional[0];
        const bRef = positional[1];
        if (!aRef || !bRef) throw new KanbanError("usage: kanban unlink <id> <other-id>", "invalid");
        const a = db.resolveTask(aRef);
        const b = db.resolveTask(bRef);
        const removed = db.unlinkCards(a.id, b.id);
        if (json) {
          jsonOut({ removed });
        } else {
          if (removed) {
            out(`${c.green("✓")} unlinked ${c.dim(a.id)} ↔ ${c.dim(b.id)}`);
          } else {
            out(`${c.green("✓")} ${c.dim(a.id)} and ${c.dim(b.id)} were not linked`);
          }
        }
        return 0;
      }

      case "gh": {
        const [ghSub, ghId, ghRef] = positional;
        if (ghSub !== "unlink" || !ghId || !ghRef) {
          throw new KanbanError("usage: kanban gh unlink <id> <ref>  (ref: url, gh:owner/repo#n, or #n)", "invalid");
        }
        const task = db.resolveTask(ghId);
        const links = db.ghLinksOf(task.id);
        let link = links.find((l) => l.url === ghRef);
        if (!link) {
          const parsed = parseGhRef(ghRef);
          if (parsed) link = links.find((l) => l.url === parsed.url);
        }
        if (!link) {
          const bare = /^#(\d+)$/.exec(ghRef);
          if (bare) {
            const matches = links.filter((l) => l.number === Number(bare[1]));
            if (matches.length === 1) link = matches[0];
            else if (matches.length > 1) {
              throw new KanbanError(
                `ambiguous GitHub link '${ghRef}' on card '${task.id}': ${matches.map((m) => `${m.repo}#${m.number} (${m.kind})`).join(", ")}`,
                "conflict",
              );
            }
          }
        }
        if (!link) throw new KanbanError(`no GitHub link matching '${ghRef}' on card '${task.id}'`, "not-found");
        db.unlinkGhLinkById(task.id, link.id);
        if (json) jsonOut({ removed: true });
        else out(`${c.green("✓")} unlinked ${c.bold(`${link.repo}#${link.number}`)} from ${c.dim(task.id)}`);
        return 0;
      }

      case "brief": {
        const idRef = positional[0];
        if (!idRef) throw new KanbanError("usage: kanban brief <id>", "invalid");
        const task = db.resolveTask(idRef);
        if (json)
          jsonOut({
            task,
            plan: db.attachment(task.id, "plan"),
            files: db.latestFiles(task.id),
            comments: db.comments(task.id),
          });
        else out(taskDetail(db, task)); // thread-aware: note, plan, files, and comments in one read
        return 0;
      }

      case "elaborate": {
        const idRef = positional[0];
        if (!idRef) throw new KanbanError("usage: kanban elaborate <id>", "invalid");
        const task = db.resolveTask(idRef);
        db.queueElaboration(task.id);
        if (json) jsonOut(task);
        else {
          out(`${c.green("✓")} elaboration queued for ${c.dim(task.id)} — runs on the auto-agent loop (kanban serve --agents)`);
        }
        return 0;
      }

      case "attach": {
        const [idRef, file] = positional;
        if (!idRef || !file) throw new KanbanError("usage: kanban attach <id> <file> [--as <name>]", "invalid");
        const ghRef = parseGhRef(file);
        if (ghRef) {
          if (typeof flags.as === "string" && flags.as) {
            throw new KanbanError("--as is for file attachments — GitHub links take no --as", "invalid");
          }
          const link = db.attachGhLink(idRef, ghRef);
          if (json) jsonOut(link);
          else {
            out(`${c.green("✓")} linked ${c.bold(`${link.repo}#${link.number}`)} ${c.dim(`(${link.kind})`)} to ${c.dim(link.cardId)}`);
            if (process.env.KANBAN_GH_SYNC_MS !== "0") {
              // best-effort: fill the state cache right away; failure prints nothing extra
              try {
                const st = await refreshGhUrl(db, link.url);
                if (st) out(c.dim(`  state: ${st.state}`));
              } catch {
                // offline or unauthenticated gh — the sync loop retries within the ttl
              }
            }
          }
          return 0;
        }
        // url-shaped input that is not a valid GitHub ref must never fall through to readFileSync
        if (file.startsWith("https://") || file.startsWith("gh:")) {
          throw new KanbanError(
            `not a GitHub pr/issue ref: '${file}' (expected https://github.com/{owner}/{repo}/pull/{n} or /issues/{n}, or gh:{owner}/{repo}#{n})`,
            "invalid",
          );
        }
        const name = typeof flags.as === "string" && flags.as ? flags.as : "plan";
        if (RESERVED_FILE_NAMES.has(name)) throw new KanbanError(`'${name}' is reserved for the agent loop`, "invalid");
        let content: string;
        try {
          content = readFileSync(file, "utf8");
        } catch (err) {
          throw new KanbanError(`cannot read file '${file}': ${(err as Error).message}`, "invalid");
        }
        const stored = db.attach(idRef, name, content, resolve(file));
        if (json) jsonOut(stored);
        else out(`${c.green("✓")} attached ${c.bold(name)} ${c.dim(`v${stored.version}`)} to ${c.dim(stored.taskId)}`);
        return 0;
      }

      case "import": {
        const [target] = positional;
        if (!target || !/^gh:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target)) {
          throw new KanbanError("usage: kanban import gh:<owner>/<repo> [--limit <n>]", "invalid");
        }
        const repo = target.slice("gh:".length);
        const rawLimit = str(flags, "limit");
        let limit = 50;
        if (rawLimit !== undefined) {
          if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) {
            throw new KanbanError(`--limit must be a positive integer (got '${rawLimit}')`, "invalid");
          }
          limit = Math.min(Number(rawLimit), 200);
        }
        let result;
        try {
          result = await importIssues(db, repo, { limit });
        } catch (err) {
          const detail = String((err as Error)?.message ?? err).replace(/\s+/g, " ").trim();
          throw new KanbanError(`gh issue list failed: ${detail.slice(-200)}`, "invalid");
        }
        if (json) jsonOut(result);
        else {
          out(`${c.green("✓")} imported ${c.bold(String(result.created))} issues from ${c.bold(repo)} ${c.dim(`(${result.skipped} skipped)`)}`);
          for (const card of result.cards) out(c.dim(`  #${card.number} → ${card.cardId}`));
        }
        return 0;
      }

      case "files": {
        const [idRef] = positional;
        if (!idRef) throw new KanbanError("usage: kanban files <id> [--json]", "invalid");
        const files = db.latestFiles(idRef);
        if (json) jsonOut(files);
        else if (files.length === 0) out(c.dim("no files"));
        else
          for (const f of files) {
            const size = fileSize(f.content.length);
            out(`${c.bold(f.kind)}  ${c.dim(`v${f.version} · ${size}${f.source ? ` · ${f.source}` : ""}`)}`);
          }
        return 0;
      }

      case "cat": {
        const [idRef, name] = positional;
        if (!idRef || !name) throw new KanbanError("usage: kanban cat <id> <name> [--v <n>]", "invalid");
        const versions = db.attachments(idRef, name);
        if (versions.length === 0) {
          const names = db.latestFiles(idRef).map((f) => f.kind);
          throw new KanbanError(`no file '${name}' on card — files: ${names.join(", ") || "(none)"}`, "not-found");
        }
        const want = typeof flags.v === "string" && flags.v !== "" ? Number(flags.v) : null;
        const pick = want === null ? versions.at(-1) : versions.find((x) => x.version === want);
        if (!pick)
          throw new KanbanError(
            `no v${want} of '${name}' — versions v1–v${versions.at(-1)!.version}`,
            "not-found",
          );
        out(pick.content); // raw content, pipeable
        return 0;
      }

      case "diff": {
        const [idRef, name] = positional;
        if (!idRef || !name)
          throw new KanbanError("usage: kanban diff <id> <name> [--from <n>] [--to <n>]", "invalid");
        const parseFlag = (key: string): number | undefined => {
          const raw = str(flags, key);
          if (raw === undefined) return undefined;
          if (!/^\d+$/.test(raw))
            throw new KanbanError(`--${key} must be a positive integer (got '${raw}')`, "invalid");
          return Number(raw);
        };
        const d = cardFileDiff(db, idRef, name, parseFlag("from"), parseFlag("to"));
        if (json) jsonOut(d);
        else if (d.patch === "")
          out(`${c.bold(d.name)} ${c.dim(`v${d.from.version} → v${d.to.version} — no changes`)}`);
        else {
          out(
            `${c.bold(d.name)} ${c.dim(`v${d.from.version} → v${d.to.version}`)}${d.to.source ? c.dim(` · ${d.to.source}`) : ""}`,
          );
          out(colorizePatch(d.patch));
        }
        return 0;
      }

      case "ws": {
        const [idRef, branch, ...extra] = positional;
        const clear = !!flags.clear;
        if (!idRef || extra.length > 0 || (clear && branch) || (!clear && !branch)) {
          throw new KanbanError("usage: kanban ws <id> <branch> | kanban ws <id> --clear", "invalid");
        }
        const task = db.updateTask(idRef, { workspace: clear ? null : branch });
        if (json) jsonOut(task);
        else if (clear) out(`${c.green("✓")} workspace cleared on ${c.dim(task.id)}`);
        else out(`${c.green("✓")} workspace ${c.dim(branch)} recorded on ${c.dim(task.id)}`);
        return 0;
      }

      case "comment": {
        const [idRef, ...text] = positional;
        const body = text.join(" ");
        if (!idRef || !body) {
          throw new KanbanError("usage: kanban comment <id> <text…> [--author <name>] [--kind <comment|review|handoff|question>]", "invalid");
        }
        const { comment, task, moved } = db.comment(idRef, { body, author: str(flags, "author"), kind: str(flags, "kind") });
        if (json) jsonOut(comment);
        else {
          out(commentLine(comment));
          if (moved === "parked") {
            out(c.hex("#bc8cff", "☉ parked in Waiting on you — reply to return it"));
          } else if (moved === "returned") {
            const lane = db.resolveLane(task.laneId);
            out(c.hex("#bc8cff", `↩ returned to ${lane.name}`));
          }
        }
        return 0;
      }

      case "comments": {
        const idRef = positional[0];
        if (!idRef) throw new KanbanError("usage: kanban comments <id>", "invalid");
        const comments = db.comments(idRef);
        if (json) jsonOut(comments);
        else out(commentThread(comments));
        return 0;
      }

      case "handoff": {
        const [idRef, laneRef] = positional;
        const message = str(flags, "message");
        if (!idRef || !laneRef || !message) {
          throw new KanbanError("usage: kanban handoff <id> <lane> --message <text> [--author <name>]", "invalid");
        }
        const result = db.handoff(idRef, laneRef, { message, author: str(flags, "author") });
        if (json) jsonOut(result);
        else {
          out(`${taskLine(db, result.task)}\n${commentLine(result.comment)}`);
          if (result.task.laneId === "done") warnActiveChildren(db, result.task);
        }
        return 0;
      }

      case "review": {
        const idRef = positional[0];
        const message = str(flags, "message");
        const approve = !!flags.approve;
        const block = !!flags.block;
        if (!idRef || approve === block) {
          throw new KanbanError(
            "usage: kanban review <id> (--approve | --block --message <text> [--finding <text>]…)",
            "invalid",
          );
        }
        if (block && !message) throw new KanbanError("--block needs --message <text>", "invalid");
        const findings = arr(flags, "finding");
        if (!block && findings.length > 0) throw new KanbanError("--finding is only valid with 'review --block'", "invalid");
        const result = approve
          ? db.handoff(idRef, laneById(db, "done"), { message: message ?? "approved", author: str(flags, "author"), kind: "review" })
          : db.handoff(idRef, laneById(db, "implement"), { message: message!, author: str(flags, "author"), kind: "review", findings });
        if (json) jsonOut(result);
        else {
          out(`${taskLine(db, result.task)}\n${commentLine(result.comment)}`);
          if (result.task.laneId === "done") warnActiveChildren(db, result.task);
        }
        return 0;
      }

      case "plan-review": {
        const idRef = positional[0];
        const message = str(flags, "message");
        const pass = !!flags.pass;
        const block = !!flags.block;
        if (!idRef || pass === block) {
          throw new KanbanError(
            "usage: kanban plan-review <id> (--pass | --block --message <text> [--finding <text>]…)",
            "invalid",
          );
        }
        const findings = arr(flags, "finding");
        if (!block && findings.length > 0) throw new KanbanError("--finding is only valid with 'plan-review --block'", "invalid");
        const { comment, task } = db.planReview(idRef, {
          verdict: pass ? "pass" : "block",
          message: message ?? (pass ? "plan meets the checklist" : undefined),
          findings,
          author: str(flags, "author"),
        });
        if (json) jsonOut({ comment, task });
        else {
          out(commentLine(comment));
          if (task.laneId === "waiting") out(c.hex("#bc8cff", "☉ parked in Waiting on you — approve or reject it"));
        }
        return 0;
      }

      case "approve": {
        const idRef = positional[0];
        if (!idRef) throw new KanbanError("usage: kanban approve <id> [--message <text>]", "invalid");
        const result = db.approveTask(idRef, { author: str(flags, "author"), message: str(flags, "message") });
        if (json) jsonOut(result);
        else out(`${taskLine(db, result.task)}\n${commentLine(result.comment)}`);
        return 0;
      }

      case "reject": {
        const [idRef, ...feedback] = positional;
        const message = str(flags, "message") ?? feedback.join(" ");
        if (!idRef || !message) {
          throw new KanbanError("usage: kanban reject <id> --message <feedback>", "invalid");
        }
        const { task, comment, returned } = db.rejectTask(idRef, message, { author: str(flags, "author") });
        if (json) jsonOut({ task, comment, returned });
        else {
          out(commentLine(comment));
          if (returned) out(c.hex("#bc8cff", "↩ returned to Plan — the planner re-arms with this feedback"));
        }
        return 0;
      }

      case "mv": {
        const task = db.resolveTask(positional[0] ?? "");
        const beforeRef = str(flags, "before");
        const pos = str(flags, "pos");
        if (pos && beforeRef) throw new KanbanError("cannot combine --pos and --before", "invalid");
        if (beforeRef && (flags.next || flags.prev))
          throw new KanbanError("cannot combine --next/--prev with --before", "invalid");
        let laneRef = positional[1];
        if (flags.next) laneRef = stepLane(db, task, 1);
        else if (flags.prev) laneRef = stepLane(db, task, -1);
        if (!laneRef && !beforeRef)
          throw new KanbanError("usage: kanban mv <id> <lane | --next | --prev> [--pos <1-based> | --before <id>]", "invalid");
        const moved = beforeRef
          ? db.moveTaskBefore(task.id, laneRef, beforeRef)
          : db.moveTask(task.id, laneRef!, pos ? Number(pos) - 1 : undefined);
        if (json) jsonOut(moved);
        else {
          out(taskLine(db, moved));
          if (moved.laneId === "done") warnActiveChildren(db, moved);
          if (moved.laneId === "plan" || moved.laneId === "implement") {
            const blockers = db.blockers(moved.id).filter((b) => !UNBLOCKED_LANES.includes(b.laneId as any));
            if (blockers.length > 0) {
              out(c.hex("#d29922", `⚠ blocked by: ${blockers.map((b) => b.id).join(", ")}`));
            }
          }
        }
        return 0;
      }

      case "edit": {
        const id = positional[0] ?? "";
        const patch: TaskPatch = {};
        if (str(flags, "title") !== undefined) patch.title = str(flags, "title");
        if (str(flags, "note") !== undefined) patch.note = str(flags, "note");
        if (flags["clear-note"]) patch.note = "";
        if (project !== undefined) patch.project = project;
        if (arr(flags, "tag").length > 0) patch.tags = arr(flags, "tag");
        if (flags["clear-tags"]) patch.tags = [];
        if (str(flags, "lane") !== undefined) patch.lane = str(flags, "lane");
        if (str(flags, "parent") !== undefined) patch.parent = str(flags, "parent");
        if (flags["clear-parent"]) patch.parent = null;
        if (str(flags, "priority") !== undefined) patch.priority = str(flags, "priority") as Priority;
        if (Array.isArray(flags["blocked-by"])) patch.blockedBy = flags["blocked-by"];
        if (flags["clear-blocked-by"]) patch.blockedBy = [];
        if (Object.keys(patch).length === 0) {
          throw new KanbanError(
            "nothing to edit — pass --title, --note, --project, --tag, --lane, --parent, --priority, --blocked-by or clear flags",
            "invalid",
          );
        }
        const updated = db.updateTask(id, patch);
        if (json) jsonOut(updated);
        else out(taskLine(db, updated));
        return 0;
      }

      case "done": {
        const task = db.resolveTask(positional[0] ?? "");
        const moved = db.moveTask(task.id, laneById(db, "done"), undefined, { cause: "done" });
        if (json) jsonOut(moved);
        else {
          out(taskLine(db, moved));
          warnActiveChildren(db, moved);
        }
        return 0;
      }

      case "archive": {
        if (positional[0] === "auto") {
          const arg = positional[1];
          if (arg !== undefined) {
            db.setAutoArchiveDays(arg === "off" ? 0 : Number(arg)); // validates: integer 0–365, else KanbanError
          }
          const days = db.autoArchiveDays();
          if (json) jsonOut({ autoArchiveDays: days });
          else out(days === 0 ? "auto-archive: off" : `auto-archive: ${days}d`);
          return 0;
        }
        const task = db.resolveTask(positional[0] ?? "");
        const moved = db.moveTask(task.id, laneById(db, "archive"), undefined, { cause: "archive" });
        if (json) jsonOut(moved);
        else out(taskLine(db, moved));
        return 0;
      }

      case "undo": {
        if (positional.length > 1) {
          throw new KanbanError("usage: kanban undo [id] [--json]", "invalid");
        }
        const result = db.undoTask(positional[0]);
        if (json) jsonOut(result);
        else {
          out(taskLine(db, result.task));
          if (result.task.laneId === "done") warnActiveChildren(db, result.task);
        }
        return 0;
      }

      case "check": {
        const port = Number(str(flags, "port") ?? process.env.PORT ?? 4600);
        const [violations, serve] = await Promise.all([db.boardViolations(), serveWarnings(port)]);
        if (json) {
          jsonOut([...violations, ...serve]);
          return 0;
        }
        for (const v of violations) {
          let line = "";
          if (v.kind === "done-parent-active-children") {
            line = `⚠ ${v.cardId} done with active children: ${v.childIds.join(", ")}`;
          } else if (v.kind === "child-behind-parent") {
            line = `⚠ ${v.cardId} in ${v.cardLaneId} behind parent ${v.parentId} (${v.parentLaneId})`;
          } else if (v.kind === "missing-plan") {
            line = `⚠ ${v.cardId} in ${v.laneId} with no attached plan`;
          } else if (v.kind === "wip-over-limit") {
            line = `⚠ ${v.laneId} over WIP limit: ${v.count}/${v.limit}`;
          }
          out(c.hex("#d29922", line));
        }
        for (const w of serve) {
          out(c.hex("#d29922", `⚠ ${w.message}`));
        }
        return 0;
      }

      case "ps": {
        const serves = await scanServes();
        const activity = await Promise.all(
          serves.map(async (s) => {
            try {
              const res = await fetch(`http://127.0.0.1:${s.port}/activity`, { signal: AbortSignal.timeout(1500) });
              const parsed = (await res.json().catch(() => null)) as Partial<ActivitySnapshot> | null;
              // look-alike servers answer /activity with their health body — arrays normalize to empty
              return parsed ? { sessions: parsed.sessions ?? [], queued: parsed.queued ?? [] } : null;
            } catch {
              return null; // serve gone mid-scan — treat as no sessions
            }
          }),
        );
        // abandoned mid-build: heartbeat is recent but its serve pid is gone
        const abandoned = db
          .listLeases()
          .filter((l) => Date.now() - l.heartbeatAt < 10 * 60_000)
          .filter((l) => !serves.some((s) => s.pid === l.ownerPid))
          .filter((l) => !pidAlive(l.ownerPid));
        const titleFor = (id: string): string => {
          try {
            const t = db.resolveTask(id);
            return t.id === id ? t.title : ""; // exact id only — a worker-run id must not resolve to some other card
          } catch {
            return "";
          }
        };
        if (json) {
          jsonOut({
            serves: serves.map((s, i) => ({
              ...s,
              versionSplit: !!s.version && s.version !== VERSION,
              sessions: activity[i]?.sessions ?? [],
              queued: activity[i]?.queued ?? [],
            })),
            abandonedLeases: abandoned,
          });
          return 0;
        }
        if (serves.length === 0) out(c.dim("no kanban serve running"));
        for (const [i, s] of serves.entries()) {
          const git = s.git?.commit ? short(s.git.commit) + (s.git.dirty ? "*" : "") : "n/a";
          const bits = [`pid ${s.pid ?? "?"}`, `:${s.port}`, `v${s.version ?? "?"}`, git];
          if (s.booted) bits.push(`up ${ageShort(Date.now() - s.booted)}`);
          let line = `serve  ${bits.join("  ")}`;
          if (s.version && s.version !== VERSION) line += c.red(`  ⟳ serve ${s.version} ≠ cli ${VERSION}`);
          out(line);
          const act = activity[i];
          for (const sess of act?.sessions ?? []) {
            const title = titleFor(sess.taskId);
            out(
              `  ${sess.taskId}  ${sess.role.padEnd(13)}  ${ageShort(Date.now() - sess.startedAt).padStart(4)}  ${(
                sess.modelLabel ?? sess.model ?? ""
              ).padEnd(16)}${title ? `  ${title}` : ""}`,
            );
          }
          for (const q of act?.queued ?? [])
            out(c.dim(`  queued  ${q.taskId}  ${q.role}  ${ageShort(Date.now() - q.enqueuedAt)}`));
          if (act && act.sessions.length === 0 && (act.queued?.length ?? 0) === 0)
            out(c.dim("  no live agent sessions"));
        }
        for (const l of abandoned)
          out(
            c.red(
              `abandoned lease  ${l.taskId}  ${l.role}  heartbeat ${ageShort(Date.now() - l.heartbeatAt)} ago  (owner pid ${l.ownerPid} dead) — resume manually, never respawn`,
            ),
          );
        return 0;
      }

      case "stats": {
        if (positional.length > 1) {
          throw new KanbanError("usage: kanban stats [id] [--json]", "invalid");
        }
        if (positional.length === 1) {
          const task = db.resolveTask(positional[0]);
          const stats = db.cardStats(task.id);
          if (json) jsonOut(stats);
          else out(statsCard(db, task, stats));
          return 0;
        }
        const payload = db.boardStats();
        if (json) jsonOut(payload);
        else out(statsBoard(db, payload));
        return 0;
      }

      case "rm": {
        const task = db.deleteTask(positional[0] ?? "", !!flags.force);
        if (json) jsonOut({ ok: true, removed: task });
        else out(`removed  ${task.id}  ${task.title}`);
        return 0;
      }

      case "lane": {
        const [sub, ...subRest] = positional;
        switch (sub) {
          case undefined:
          case "ls": {
            if (json) jsonOut(db.lanes());
            else out(laneList(db));
            return 0;
          }
          case "add": {
            const name = subRest.join(" ");
            if (!name) throw new KanbanError("usage: kanban lane add <name>", "invalid");
            const lane = db.createLane({ name });
            if (json) jsonOut(lane);
            else out(`${lane.id}  ${lane.name}  added`);
            return 0;
          }
          case "rename": {
            const ref = subRest[0] ?? "";
            const name = subRest.slice(1).join(" ");
            if (!ref || !name) throw new KanbanError("usage: kanban lane rename <ref> <name>", "invalid");
            const lane = db.updateLane(ref, { name });
            if (json) jsonOut(lane);
            else out(`${lane.id}  ${lane.name}  renamed`);
            return 0;
          }
          case "limit": {
            const ref = subRest[0] ?? "";
            const raw = subRest[1] ?? "";
            if (!ref || !raw) throw new KanbanError("usage: kanban lane limit <ref> <n|off>", "invalid");
            const n = raw === "off" ? null : Number(raw);
            if (n !== null && (!Number.isInteger(n) || n < 1 || n > 999)) {
              throw new KanbanError("wip limit must be an integer from 1 to 999 (or 'off' to clear)", "invalid");
            }
            const lane = db.updateLane(ref, { wipLimit: n });
            if (json) jsonOut(lane);
            else out(n === null ? `${lane.id}  wip limit cleared` : `${lane.id}  wip limit ${n}`);
            return 0;
          }
          case "rm": {
            const lane = db.deleteLane(subRest[0] ?? "", !!flags.force);
            if (json) jsonOut({ ok: true, removed: lane });
            else out(`${lane.id}  removed`);
            return 0;
          }
          default:
            throw new KanbanError(`unknown lane subcommand '${sub}' (ls | add | rename | rm | limit)`, "invalid");
        }
      }

      case "worker": {
        const [sub, ...subRest] = positional;
        if (sub === "run") {
          const ref = subRest[0] ?? "";
          if (!ref) throw new KanbanError("usage: kanban worker run <lane> [--focus <text>] [--author <name>]", "invalid");
          const lane = db.resolveLane(ref);
          if (charterFor(lane.id) === null) throw new KanbanError(charterError(lane.id), "invalid");
          const run = db.queueLaneWorker({ laneId: lane.id, focus: str(flags, "focus"), requestedBy: str(flags, "author") ?? "user" });
          if (json) {
            const { log: _log, ...row } = run;
            jsonOut(row);
          } else {
            out(`queued lane worker ${run.id} for ${lane.id} — drained by serve --agents (watch with kanban worker ls)`);
          }
          return 0;
        }
        if (sub === "ls") {
          const laneRef = str(flags, "lane");
          const laneId = laneRef ? db.resolveLane(laneRef).id : undefined;
          const rows = db.laneWorkers({ limit: 50, ...(laneId ? { laneId } : {}) });
          if (json) {
            jsonOut(
              rows.map((r) => ({
                ...r,
                ...(r.log !== undefined ? { log: r.log.split("\n").slice(-20).join("\n") } : {}),
              })),
            );
            return 0;
          }
          if (rows.length === 0) {
            out("no lane worker runs — dispatch one with kanban worker run <lane>");
            return 0;
          }
          const now = Date.now();
          for (const r of rows) {
            const age = ageShort(now - r.createdAt);
            const summaryLine = (r.summary ?? "").split("\n")[0] ?? "";
            out(
              `${r.id}  ${r.laneId.padEnd(10)}  ${r.status.padEnd(7)}  ${age.padStart(5)}  ${summaryLine.slice(0, 60)}` +
                (r.focus ? `  [${r.focus.slice(0, 40)}]` : ""),
            );
          }
          return 0;
        }
        throw new KanbanError(`unknown worker subcommand '${sub}' (run | ls)`, "invalid");
      }

      default:
        throw new KanbanError(`unknown command '${cmd}' (see: kanban help)`, "invalid");
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
    await flushOut();
  } catch (err) {
    const msg = err instanceof KanbanError ? err.message : (err as Error)?.message ?? String(err);
    console.error(`kanban: ${msg}`);
    await flushOut().catch(() => {});
    process.exitCode = 1;
  }
}
