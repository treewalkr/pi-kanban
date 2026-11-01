/**
 * Lane workers: short-lived headless pi sessions with a charter over one lane,
 * dispatched by the board manager (or a human) through `kanban worker run` and
 * drained by this serve-process runner — a sibling of the auto-review loop,
 * never inside it (plan d26pe, Decision 2/4).
 *
 * Contract shape: the CLI and the manager only enqueue rows (`lane_workers`,
 * the resume_requests queue-as-rows pattern); the runner claims and spawns.
 * Workers act only through kanban CLI verbs with a `pi-worker-<lane>` author,
 * so every write lands in the affected card's thread and the builder-arming
 * scan ignores them (`pi-*` approvals never arm). Report-only charters keep
 * workers off the loop-owned lanes' threads entirely.
 */
import { DEFAULT_STALL_MS, deathReason, skillActivationPrompt, spawnPi, type SpawnPiInput, type SpawnResult } from "./autoreview";
import { chatSkillPath } from "./chat";
import type { AgentConfig, KanbanDb, LaneWorkerRun, LaneSnapshot } from "./db";
import { registerShutdown } from "./shutdown";

export const WORKER_AUTHOR_PREFIX = "pi-worker-";

export type WorkerLaneId = "waiting" | "backlog" | "plan" | "implement" | "review";

export const WORKER_LANES: readonly WorkerLaneId[] = ["waiting", "backlog", "plan", "implement", "review"];

/** The worker prompt's allowed verbs — every one must exist in the CLI help (pinned by test). */
export const WORKER_ALLOWED_VERBS = ["ls", "search", "show", "brief", "stats", "comment", "edit", "mv", "handoff", "link"] as const;

/** The charter-lane list in the CLI's no-charter error, pinned by test. */
export const CHARTER_LANE_SUFFIX = "waiting, backlog, plan, implement, review";

/** Display names for prompt identity — the fixed lanes' board names. */
const LANE_NAMES: Record<WorkerLaneId, string> = {
  waiting: "Waiting on you",
  backlog: "Backlog",
  plan: "Plan",
  implement: "Test + Implement",
  review: "Review",
};

const CHARTERS: Record<WorkerLaneId, { charter: string[]; writable: boolean }> = {
  backlog: {
    writable: true,
    charter: [
      "Groom: tighten vague titles and notes (`kanban edit`), tag and set priority",
      "Rank within Backlog with `mv --next`/`--prev` so the most valuable cards sit on top",
      'Ask clarifying questions on vague cards: `kanban comment <id> "<question + recommended default>" --kind question --author pi-worker-backlog` (the card parks in Waiting on you)',
      "Promote at most 3 clearly-ready cards to Plan per run: `kanban handoff <id> plan --message <why ready> --author pi-worker-backlog`",
      "Never delete cards; never invent scope",
    ],
  },
  waiting: {
    writable: false,
    charter: [
      "For each card parked in Waiting on you: what it waits for (question, plan gate, or review cap — `kanban brief <id>`), how many days parked, and what the human should do next",
      "Write nothing — your summary is the deliverable",
    ],
  },
  plan: {
    writable: false,
    charter: [
      "Report Plan cards that are stalled: no attached plan after 3+ days, gate-parked 3+ days, or plan-review capped out",
      "The planner/plan-reviewer loop owns this lane — never comment on these cards",
      "Write nothing — your summary is the deliverable",
    ],
  },
  implement: {
    writable: false,
    charter: [
      "Report Test + Implement cards: age, stale builders (`session-died` comments), lanes over their WIP limit",
      "The builder loop owns this lane — never comment on these cards",
      "Write nothing — your summary is the deliverable",
    ],
  },
  review: {
    writable: false,
    charter: [
      "Report Review cards: which await a reviewer, block cycles used against the cap of 3, and cap-outs that need the human",
      "The reviewer loop owns this lane — never comment on these cards",
      "Write nothing — your summary is the deliverable",
    ],
  },
};

/** The lane's charter, or null for any lane without a worker (done/archive/custom lanes). */
export function charterFor(laneId: string): { charter: string[]; writable: boolean } | null {
  const entry = (CHARTERS as Record<string, { charter: string[]; writable: boolean } | undefined>)[laneId];
  return entry ? { charter: [...entry.charter], writable: entry.writable } : null;
}

/** The CLI's no-charter error for a resolved lane id (the pinned message, interpolated). */
export function charterError(laneId: string): string {
  return `no worker charter for lane '${laneId}' — charter lanes: ${CHARTER_LANE_SUFFIX}`;
}

export function workerAuthor(laneId: WorkerLaneId): string {
  return WORKER_AUTHOR_PREFIX + laneId;
}

/** The pinned allowed-verb sentence — names only verbs that exist in the CLI help (v1's defect, Decision 12). */
export function workerRules(author: string): string {
  return (
    "Act only through the kanban CLI. Allowed verbs: `ls`, `search`, `show`, `brief`, `stats`, `comment`, `edit`, " +
    "`mv` (within your lane), `handoff`, `link` — questions are `kanban comment <id> \"<question + recommended default>\" --kind question`. " +
    `Every card write lands in that card's thread; always pass \`--author ${author}\`. ` +
    "Never run `approve`, `reject`, `review`, `plan-review`, `elaborate`, `rm`, `lane rm`, `attach`, `ws`, `serve`, or `stop` — " +
    "gates, deletions, and loop-owned artifacts are out of your hands. Never touch cards outside your lane."
  );
}

/** The worker's one-shot prompt: identity, skill, charter, budget, rules, summary rule, snapshot, focus. */
export function workerPrompt(input: { laneId: WorkerLaneId; snapshot: string; focus?: string }): string {
  const laneId = input.laneId;
  const charter = charterFor(laneId);
  if (!charter) throw new Error(`no worker charter for lane '${laneId}'`);
  const author = workerAuthor(laneId);

  const budget: string[] = [
    "Budget:",
    "- Start from the lane snapshot below. Read at most 12 cards (`kanban brief <id>`) — only where the snapshot is not enough.",
  ];
  if (charter.writable) {
    budget.push("- Write at most 10 card changes and promote at most 3 cards to Plan.");
  }

  const parts: string[] = [
    `You are the \`${LANE_NAMES[laneId]}\` lane worker (author \`${author}\`) on this kanban board. One short run: do the charter below, then stop.`,
    skillActivationPrompt([chatSkillPath], (message) => console.warn(`[workers] ${message}`)),
    `Charter:\n${charter.charter.map((b) => `- ${b}`).join("\n")}`,
    budget.join("\n"),
    `Rules:\n${workerRules(author)}`,
    "Summary: Finish with a summary of at most 10 lines — what you did or found, with card ids. The board manager reads it; the human reads the manager.",
    `Lane snapshot:\n${input.snapshot}`,
  ];
  const focus = input.focus?.trim();
  if (focus) parts.push(`Focus for this run: ${focus}`);
  return parts.join("\n\n");
}

/** One line per card: `id · title · <n>d · priority` plus ` · ⊘blocked` when soft-blocked; truncation tail. */
export function formatSnapshot(snap: LaneSnapshot): string {
  const lines = snap.cards.map(
    (c) => `${c.id} · ${c.title} · ${c.ageDays}d · ${c.priority}${c.blocked ? " · ⊘blocked" : ""}`,
  );
  if (snap.truncated) lines.push(`…and ${snap.total - snap.cards.length} more`);
  return lines.join("\n");
}

/**
 * pi flags for a worker: mirrors agentFlags minus the role-based thinking
 * default and minus env overrides — provider/model/thinking/skills/context/
 * tools/extraArgs come from the "worker" agent config only. Configured skills
 * are activated by injecting their SKILL.md into the appended system prompt.
 */
export function workerArgs(cfg: AgentConfig | null): string[] {
  const args: string[] = [];
  if (cfg?.provider) args.push("--provider", cfg.provider);
  if (cfg?.model) args.push("--model", cfg.model);
  if (cfg?.thinking) args.push("--thinking", cfg.thinking);
  for (const skill of cfg?.skills ?? []) args.push("--skill", skill);
  const activated = skillActivationPrompt(cfg?.skills ?? [], (message) => console.warn(`[workers] ${message}`));
  const appended = [cfg?.context, activated].filter(Boolean).join("\n\n");
  if (appended) args.push("--append-system-prompt", appended);
  if (cfg?.tools) args.push("--tools", cfg.tools);
  args.push(...(cfg?.extraArgs ?? []));
  return args;
}

export const DEFAULT_WORKER_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_WORKER_MAX_CONCURRENT = 2;

/** Env knob: invalid → default + console.warn (the resolveChatIdleTimeoutMs pattern). */
export function resolveWorkerTimeoutMs(env: string | undefined = process.env.KANBAN_WORKER_TIMEOUT_MS): number {
  if (env === undefined || env === "") return DEFAULT_WORKER_TIMEOUT_MS;
  const raw = Number(env);
  if (Number.isFinite(raw) && raw > 0) return raw;
  console.warn(
    `[workers] invalid KANBAN_WORKER_TIMEOUT_MS '${env}' — using default ${DEFAULT_WORKER_TIMEOUT_MS}ms`,
  );
  return DEFAULT_WORKER_TIMEOUT_MS;
}

/** Env knob: invalid → default + console.warn. */
export function resolveWorkerMaxConcurrent(env: string | undefined = process.env.KANBAN_WORKER_MAX_CONCURRENT): number {
  if (env === undefined || env === "") return DEFAULT_WORKER_MAX_CONCURRENT;
  const raw = Number(env);
  if (Number.isInteger(raw) && raw >= 1 && raw <= 10) return raw;
  console.warn(
    `[workers] invalid KANBAN_WORKER_MAX_CONCURRENT '${env}' — using default ${DEFAULT_WORKER_MAX_CONCURRENT}`,
  );
  return DEFAULT_WORKER_MAX_CONCURRENT;
}

const MAX_WORKER_LOG_LINES = 150;
const SUMMARY_MAX_CHARS = 4_000;
const REAP_REASON = "server restarted — run lost; re-dispatch if needed";

/**
 * The serve-process runner: claims queued lane_workers rows (oldest first, one
 * worker per lane, a global concurrency cap) and spawns each as a headless
 * `pi --mode json` session via the shared spawnPi. Run rows carry the summary
 * (the session's text output) and a capped log; boot reaps orphaned running
 * rows. Pause stops new drains but never kills short-lived running workers.
 */
export function startWorkerRunner(opts: {
  db: KanbanDb;
  cwd: string;
  spawnFn?: typeof spawnPi;
  timeoutMs?: number;
  maxConcurrent?: number;
  watchIntervalMs?: number;
  log?: (message: string) => void;
}): { stop(): void } {
  const db = opts.db;
  const log = opts.log ?? ((message: string) => console.log(`[workers] ${message}`));
  const spawn = opts.spawnFn ?? spawnPi;
  const timeoutMs = opts.timeoutMs ?? resolveWorkerTimeoutMs();
  const maxConcurrent = opts.maxConcurrent ?? resolveWorkerMaxConcurrent();
  const stallMs = DEFAULT_STALL_MS;

  const reaped = db.failRunningLaneWorkers(REAP_REASON);
  if (reaped > 0) log(`reaped ${reaped} orphaned running run${reaped === 1 ? "" : "s"}`);

  const kills = new Set<() => void>();
  const track = (kill: () => void): (() => void) => {
    kills.add(kill);
    return () => {
      kills.delete(kill);
    };
  };

  let stopped = false;
  const inflight = new Set<Promise<void>>();

  const settle = (run: LaneWorkerRun, startedAt: number, lines: string[], result: SpawnResult): void => {
    const textLines = lines.filter((l) => l.startsWith("text: ")).map((l) => l.slice("text: ".length));
    let summary = textLines.join("\n").trim();
    if (summary.length > SUMMARY_MAX_CHARS) summary = summary.slice(0, SUMMARY_MAX_CHARS).trimEnd();
    const ok = result.code === 0 && textLines.length > 0;
    db.finishLaneWorker(
      run.id,
      {
        status: ok ? "done" : "failed",
        ...(summary ? { summary } : {}),
        ...(ok ? {} : { exitInfo: deathReason(result, Math.round((Date.now() - startedAt) / 1000), lines) }),
        log: lines.join("\n"),
      },
      Date.now(),
    );
    log(`${run.laneId} run ${run.id}: ${ok ? "done" : "failed"}`);
  };

  const drain = async (run: LaneWorkerRun): Promise<void> => {
    log(`${run.laneId} run ${run.id}: started`);
    const startedAt = Date.now();
    const lines: string[] = [];
    let result: SpawnResult;
    try {
      result = await spawn({
        cwd: opts.cwd,
        sessionId: run.sessionId!,
        prompt: workerPrompt({
          laneId: run.laneId as WorkerLaneId,
          snapshot: formatSnapshot(db.laneSnapshot(run.laneId)),
          ...(run.focus ? { focus: run.focus } : {}),
        }),
        args: workerArgs(db.agentConfig("worker")),
        timeoutMs,
        stallMs,
        log: (message) => log(`${run.laneId} run ${run.id}: ${message}`),
        emit: (line) => {
          if (lines.length < MAX_WORKER_LOG_LINES) lines.push(line);
        },
        track,
      });
    } catch (err) {
      db.finishLaneWorker(
        run.id,
        { status: "failed", exitInfo: `spawn failed: ${(err as Error).message}`, log: lines.join("\n") },
        Date.now(),
      );
      log(`${run.laneId} run ${run.id}: failed — ${(err as Error).message}`);
      return;
    }
    settle(run, startedAt, lines, result);
    tick(); // a finished run frees a slot/lane — drain what waited on it
  };

  const tick = (): void => {
    if (stopped || db.agentsPaused()) return;
    const queued = db.laneWorkers({ status: "queued" }).reverse(); // drain oldest-first
    const running = db.laneWorkers({ status: "running" });
    const busyLanes = new Set(running.map((r) => r.laneId));
    let slots = maxConcurrent - running.length;
    for (const run of queued) {
      if (slots <= 0) break;
      if (busyLanes.has(run.laneId)) continue; // one worker per lane
      const sessionId = `kanban-worker-${run.laneId}-${run.id}`;
      const claimed = db.claimLaneWorker(run.id, sessionId, Date.now());
      if (!claimed) continue; // another process won the race
      busyLanes.add(run.laneId);
      slots--;
      const pending = drain(claimed).finally(() => inflight.delete(pending));
      inflight.add(pending);
    }
  };

  const stopWatcher = db.watch(tick, opts.watchIntervalMs ?? 1000);
  tick(); // drain anything queued before start (same-process queues never fire the watcher)
  registerShutdown(() => stop());

  function stop(): void {
    if (stopped) return;
    stopped = true;
    stopWatcher();
    for (const kill of [...kills]) {
      try {
        kill();
      } catch {
        /* already gone */
      }
    }
  }

  return { stop };
}

export type { SpawnPiInput };
