import { homedir } from "node:os";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { durationFor, runAgentChild } from "./agent-child";
import { stampSessionLog } from "./session-log";
import { MAX_SKILL_CHARS, skillActivationPrompt } from "./skill-activation";
import { BUILDER_AUTHOR, KanbanDb, PLAN_REVIEWER_AUTHOR, defaultLaneContext, epicPlanContext, epicPlanContextFor, PLAN_SECTIONS, PLAN_TEMPLATE, type AgentConfig, type AgentRole, type AgentThinking, type BuiltinAgentRole, type LaneActor, type LaneCapRule, type LaneContext, type Engine, type LeaseOwner, type Task } from "./db";
import { claudeFlags, isClaudeSessionId, spawnClaude } from "./claude";
import { DEFAULT_ENGINE_ID, effectiveThinking, engineLabel, resolveLineup } from "./engines";
import {
  classifySpawnFailure,
  DEFAULT_COOLDOWN_MS,
  PROVIDER_LEVEL_CAUSES,
  RETRYABLE_CAUSES,
  EngineHealth,
  type EngineHealthSummary,
  type EngineIncident,
  type IncidentCause,
} from "./incidents";

export const RETRY_LIMIT = 2;
export const RETRY_MARKER = "— auto-retry ";
export const DEFAULT_RETRY_DELAY_MS = 30_000;

export type { AgentRole, BuiltinAgentRole, LaneActor, LaneContext };
export { PLAN_REVIEWER_AUTHOR };
export { BUILDER_AUTHOR };
export { PLAN_SECTIONS, PLAN_TEMPLATE };

/**
 * Auto-agents loop, hosted by the serve process (`KANBAN_AGENTS=1`).
 *
 * Agents over the lanes, all state derived from the board: a card in the
 * plan lane whose thread's last comment is not from the planner gets a
 * headless `pi` planning session that writes and attaches a plan against the
 * shared plan template, then hands off (kind handoff) to a plan reviewer that
 * checks the plan against the template's review checklist — a block bounces
 * back to the planner (max 2 rounds per human comment), a pass leaves the
 * card at the gate; the human owns it (`kanban approve` / `reject`). An
 * approval (comment kind "approval", never agent-authored) moves the card to
 * implement and arms a builder session that builds the attached plan. A card
 * in the review lane whose last comment is not from the reviewer gets a review
 * session; a block arms the findings builder, max 3 cycles. Nothing survives a
 * restart, and nothing needs to: each agent's own last comment disarms it.
 */

export const PLANNER_AUTHOR = "pi-planner";
export const REVIEWER_AUTHOR = "pi-reviewer";
export const ELABORATOR_AUTHOR = "pi-elaborator";

export const AUTHOR_BY_ROLE: Record<AgentRole, string> = {
  planner: PLANNER_AUTHOR,
  reviewer: REVIEWER_AUTHOR,
  builder: BUILDER_AUTHOR,
  "plan-reviewer": PLAN_REVIEWER_AUTHOR,
  elaborator: ELABORATOR_AUTHOR,
};

export interface AgentJob {
  task: Task;
  role: AgentRole;
  prompt: string;
  /** Builder jobs come in two flavors: working review findings or building an approved plan. */
  mode?: "findings" | "plan" | "resume" | "elaborate";
  /** The workflow lane the job came from (context lookups for the gate and afterJob). */
  laneId?: string;
  sessionId?: string;
}

export interface SpawnContext {
  cwd: string;
  timeoutMs: number;
  stallMs: number;
  config: AgentConfig | null;
  /** The engine the allocator picked for this spawn — decides harness, model, and flags. */
  engine: Engine;
  log: (message: string) => void;
  /** Streams one formatted output line from the running session. */
  emit: (line: string) => void;
  /** Registers the child's kill handle so shutdown can terminate in-flight sessions; returns an untrack cleanup function. */
  track: (kill: () => void) => () => void;
  /** Signals raw child output — bytes count even when the formatter drops them, proving a quiet session alive. */
  touch?: () => void;
}

/** How a spawned session ended: code plus the diagnostics a number can't carry. */
export interface SpawnResult {
  /** Child exit code; non-zero = failure. */
  code: number;
  /** True when the timeout killer fired (quota exits masquerade as 0, but timeouts masquerade as 1). */
  timedOut?: boolean;
  /** True when the stall watchdog fired (no output for stallMs). */
  stalled?: boolean;
  /** The stall window that fired, in milliseconds. */
  stalledAfterMs?: number;
  /** Trailing stderr text if the child wrote any — the diagnostic tail, ≤1500 chars. */
  stderrTail?: string;
}

export type SpawnFn = (job: AgentJob, ctx: SpawnContext) => Promise<SpawnResult>;

export interface AutoReviewOptions {
  db: KanbanDb;
  cwd: string;
  spawnFn?: SpawnFn;
  timeoutMs?: number;
  stallMs?: number;
  maxBlocks?: number;
  /** Plan-review blocks allowed since the last human comment before the card goes to the human (default 2). */
  maxPlanBlocks?: number;
  watchIntervalMs?: number;
  log?: (message: string) => void;
  /** Pre-spawn test gate for reviewer jobs; null disables. Default: defaultGate, unless KANBAN_AGENTS_GATE=0 (deprecated alias KANBAN_AUTOREVIEW_GATE). */
  gate?: GateFn | null;
  gateTimeoutMs?: number;
  cooldownMs?: number;
  retryDelayMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 2 * 60 * 60_000;
export const DEFAULT_STALL_MS = 10 * 60_000;
const DEFAULT_MAX_BLOCKS = 3;
const DEFAULT_MAX_PLAN_BLOCKS = 2;
const MAX_LOG_LINES = 150;

export const DEFAULT_GATE_TIMEOUT_MS = 3 * 60_000;

export interface GateResult {
  ok: boolean;
  output: string;
}

/** Fast checks run before a reviewer session is spent; ok=false means red tests. The project's test command runs via `sh -c` when set. */
export type GateFn = (cwd: string, timeoutMs: number, command?: string) => Promise<GateResult>;

// gate runs are serialized process-wide: two cards entering Review together used to run two
// full suites concurrently, and their repro.sh port-pin tests raced each other onto 4615 —
// the loser hung to its timeout and parked its card on a flake (zfe3f, 2026-11-01)
let gateChain: Promise<unknown> = Promise.resolve();

export const defaultGate: GateFn = (cwd, timeoutMs, command) => {
  const run = () => gateRun(cwd, timeoutMs, command);
  const next = gateChain.then(run, run);
  gateChain = next.catch(() => {});
  return next;
};

const gateRun = async (cwd: string, timeoutMs: number, command?: string): Promise<GateResult> => {
  // a project's test command runs through sh -c (human-owned, bounded at 500 chars by
  // setProjectTestCmd); the board default stays bun's 30s per-test timeout: spawn-heavy
  // tests (cli.ts subprocesses, repro server boots) legitimately exceed bun's 5s default
  // under full-suite parallel load and park cards on flakes (30s keeps genuinely red
  // tests failing fast while tolerating load)
  const proc = Bun.spawn({ cmd: command ? ["sh", "-c", command] : ["bun", "test", "--timeout", "30000"], cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  timer.unref?.();
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  clearTimeout(timer);
  const output = `${out}\n${err}`.trim().slice(-1500);
  return timedOut
    ? { ok: false, output: `${command ?? "bun test"} timed out after ${durationFor(Math.round(timeoutMs / 1000))}\n${output}` }
    : { ok: code === 0, output };
};

export interface AgentSessionInfo {
  taskId: string;
  role: AgentRole;
  startedAt: number;
  /** Last child output (raw bytes or a formatted line) — separates a working session from a wedged one; starts at startedAt. */
  lastActivityAt: number;
  log: string[];
  /** Arrival time (epoch ms) of each `log` entry — same length, trimmed in lockstep. */
  logAt: number[];
  model?: string;
  modelLabel?: string;
  /** Name of the engine the session runs on. */
  engine?: string;
}

/** A job waiting in the serial drain queue (no session yet), for /activity. */
export interface QueuedJobInfo {
  taskId: string;
  role: AgentRole;
  enqueuedAt: number;
}

/** What one autoreview instance exposes to /activity: live sessions plus queued jobs. */
export interface ActivityReport {
  sessions: AgentSessionInfo[];
  queued: QueuedJobInfo[];
  incidents: EngineIncident[];
  engines: EngineHealthSummary[];
}

const activityProviders = new Set<() => ActivityReport>();

/** In-flight agent sessions across all autoreview instances, for the /activity endpoint. */
export function activitySnapshot(): ActivityReport {
  const sessions: AgentSessionInfo[] = [];
  const queued: QueuedJobInfo[] = [];
  const incidents: EngineIncident[] = [];
  const engines: EngineHealthSummary[] = [];
  for (const provide of activityProviders) {
    const report = provide();
    sessions.push(...report.sessions);
    queued.push(...report.queued);
    incidents.push(...report.incidents);
    engines.push(...report.engines);
  }
  return { sessions, queued, incidents, engines };
}

const pauseKillers = new Set<() => number>();

/**
 * Kill every in-flight agent session in this process (the pause action). The
 * board-level paused flag (db.agentsPaused) is what stops new spawns — in every
 * process, restarts included — this only ends sessions already running here.
 * Returns how many were killed. In-flight sessions in other processes run to
 * completion; their loops then refuse the next spawn.
 */
export function killAgentSessions(): number {
  let killed = 0;
  for (const kill of pauseKillers) {
    try {
      killed += kill();
    } catch {
      /* already gone */
    }
  }
  return killed;
}

/** Per-card kill handles for live sessions — one entry per running job, for the per-session stop verb. */
const sessionKillers = new Map<string, () => void>();

/**
 * Kill one in-flight agent session (the per-session stop verb). The death flows
 * through the normal finally/afterJob path — death comment, transcript, lease
 * release — exactly like a stall or pause kill. Returns false when no live
 * session runs under that task id.
 */
export function killAgentSession(taskId: string): boolean {
  const kill = sessionKillers.get(taskId);
  if (!kill) return false;
  try {
    kill();
  } catch {
    /* already gone */
  }
  return true;
}

/**
 * One pi JSONL event (`--mode json`) → one short log line, or null for noise
 * (usage churn, text deltas). Unknown events carrying errorMessage render as
 * warnings; the rest are dropped.
 */
export function formatPiEvent(line: string): string | null {
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  const compact = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);
  switch (ev.type) {
    case "session":
      return "session started";
    case "message_end": {
      if (ev.message?.role !== "assistant") return null;
      if (ev.message?.stopReason === "error") {
        return `✗ model error: ${compact(String(ev.message.errorMessage ?? "unknown error"))}`;
      }
      const text = (ev.message.content ?? [])
        .filter((b: any) => b?.type === "text")
        .map((b: any) => b.text ?? "")
        .join(" ")
        .trim();
      return text ? `text: ${compact(text)}` : null;
    }
    case "tool_execution_start": {
      const args = ev.args?.command ?? JSON.stringify(ev.args ?? {});
      return `→ ${ev.toolName}: ${compact(String(args))}`;
    }
    case "tool_execution_end": {
      const ms = typeof ev.durationMs === "number" ? ` ${ev.durationMs}ms` : "";
      return ev.isError ? `✗ ${ev.toolName}${ms}` : `✓ ${ev.toolName}${ms}`;
    }
    case "auto_retry_start":
      return `retry ${ev.attempt}/${ev.maxAttempts}: ${compact(String(ev.errorMessage ?? ""))}`;
    case "auto_retry_end":
      return ev.success === false ? `retries exhausted: ${compact(String(ev.finalError ?? "unknown error"))}` : null;
    case "compaction_start":
      return `compacting (${ev.reason})`;
    case "compaction_end":
      return ev.errorMessage ? `✗ compaction failed: ${compact(String(ev.errorMessage))}` : null;
    case "agent_settled":
      return ev.aborted ? "settled (aborted)" : "settled";
    default:
      return typeof ev.errorMessage === "string" && ev.errorMessage.trim()
        ? `⚠ ${ev.type}: ${compact(ev.errorMessage)}`
        : null;
  }
}

/**
 * Render one lane actor's prompt (card 3n96c): interpolate {id} / {title} /
 * {tmpFile} / {template} into the actor's instructions (the plan-build
 * approvalInstructions flavor when mode is "plan"), then append the lane's
 * artifact template and review checklist unless the instructions embedded it
 * via {template}.
 */
export function renderActorPrompt(
  task: Task,
  laneId: string,
  context: LaneContext,
  actor: LaneActor,
  mode?: "plan" | "findings",
  now: number = Date.now(),
): string {
  const source = mode === "plan" && actor.approvalInstructions ? actor.approvalInstructions : actor.instructions;
  const embedsTemplate = source.includes("{template}");
  const raw = source
    .replaceAll("{id}", task.id)
    .replaceAll("{title}", task.title)
    .replaceAll("{tmpFile}", `/tmp/${context.artifact ?? laneId}-${task.id}-${now.toString(36)}.md`)
    .replaceAll("{template}", (context.template ?? "").trim());
  const template = (context.template ?? "").trim();
  if (template && !embedsTemplate) {
    return `${raw}\n\n--- ${context.artifact ?? laneId} template and review checklist ---\n${template}`;
  }
  return raw;
}

export function resumePrompt(task: Task, role: AgentRole, reason: string, actor?: LaneActor): string {
  // the seeded lane actors' endings, plus the elaborator (request-driven, no lane)
  const endings: Record<string, string> = {
    elaborator: `; then finish: kanban edit ${task.id} --note "<the elaborated note>" (--title "<the corrected title>" too, if the title still needs its fix) and kanban comment ${task.id} "elaborated — note now carries intent + acceptance criteria" --author pi-elaborator`,
  };
  for (const laneId of ["plan", "implement", "review"]) {
    const ctx = defaultLaneContext(laneId)!;
    for (const a of ctx.actors) {
      if (a.resumeEnding) endings[a.id] = a.resumeEnding.replaceAll("{id}", task.id);
    }
  }
  const ending = actor?.resumeEnding?.replaceAll("{id}", task.id) ?? endings[role] ?? "";
  const author = actor?.author ?? authorForRole(role);
  return `You are ${author}. Your previous session on kanban card ${task.id} "${task.title}" died before finishing (${reason}) — this spawn continues that same session, so your earlier context is intact: pick up where you left off, do not restart from scratch.

1. Re-orient: run kanban brief ${task.id} — the thread may have moved while you were down; check your own progress (git status, git log, the files you touched) before redoing work.
2. Finish what you were doing${ending}
3. Run the full test suite (e.g. bun test) before recording anything if you touched code.
4. Never move the card with mv and never run kanban approve/reject — the human owns the gate.

Your last line: one-sentence progress summary.`;
}

export function elaboratorPrompt(task: Task): string {
  return `You are pi-elaborator. Kanban card ${task.id} "${task.title}" was just captured with a terse title — elaborate its note so humans and the planner can act on it.

1. Run: kanban show ${task.id} --json — the title, current note, lane, and project.
2. Write the elaborated note with exactly two sections, markdown:
   Intent: one or two sentences on what this card wants and why — the title's plain meaning, no invented scope.
   Acceptance criteria: 2-6 numbered lines starting AC1, AC2, … each concrete and observable from the outside.
   If the card already has a note, it is the seed: preserve every fact it states inside the elaborated note. Do not invent file paths, APIs, or features.
3. Fix the title only if it is obviously broken — typos, speech-to-text garble, mangled words. Correct it to what was clearly meant: same meaning, same scope, no rewording for style. A title that reads fine stays untouched.
4. Save it: kanban edit ${task.id} --note "<the elaborated note>" — add --title "<the corrected title>" to the same edit when you fixed the title
5. Record it: kanban comment ${task.id} "elaborated — note now carries intent + acceptance criteria" --author pi-elaborator

Never move the card (no mv/handoff) and never run kanban approve/reject — the human owns the gate.
Your last line: one sentence on what the note now covers (and the title fix, if you made one).`;
}

/** The seeded lane actor for a role id, or null (board-level roles like elaborator have none). */
export function seededActorFor(role: string): LaneActor | null {
  for (const laneId of ["plan", "implement", "review"]) {
    const hit = defaultLaneContext(laneId)!.actors.find((a) => a.id === role);
    if (hit) return hit;
  }
  return null;
}

/** The thread author a role speaks as: the lane actor's author, or the built-in map. */
export function authorForRole(role: string): string {
  return seededActorFor(role)?.author ?? AUTHOR_BY_ROLE[role] ?? `pi-${role}`;
}

export function plannerPrompt(task: Task, now: number = Date.now(), hasChildren = false): string {
  const ctx = hasChildren ? epicPlanContext() : defaultLaneContext("plan")!;
  return renderActorPrompt(task, "plan", ctx, ctx.actors[0]!, undefined, now);
}

export function planReviewerPrompt(task: Task, hasChildren = false): string {
  const ctx = hasChildren ? epicPlanContext() : defaultLaneContext("plan")!;
  return renderActorPrompt(task, "plan", ctx, ctx.actors[1]!);
}

export function builderPlanPrompt(task: Task): string {
  const ctx = defaultLaneContext("implement")!;
  return renderActorPrompt(task, "implement", ctx, ctx.actors[0]!, "plan");
}

export function builderPrompt(task: Task): string {
  const ctx = defaultLaneContext("implement")!;
  return renderActorPrompt(task, "implement", ctx, ctx.actors[0]!, "findings");
}

export function reviewerPrompt(task: Task): string {
  const ctx = defaultLaneContext("review")!;
  return renderActorPrompt(task, "review", ctx, ctx.actors[0]!);
}

/** What a lane's context says a card needs right now — the generic loop's decision. */
export interface LaneEvaluation {
  /** The actor to arm, or null when the lane is disarmed for this card. */
  actor: LaneActor | null;
  /** Builder flavor when the armed actor carries approvalInstructions. */
  mode?: "plan" | "findings";
  /** Set when the cap blocked the arm: the loop posts the rule's one-shot question. */
  capped?: LaneCapRule;
  /** The effective cap max ({max} interpolation) when capped. */
  capMax?: number;
  /** Exit-rule transition: move the card to this lane id. */
  moveTo?: string;
  /** Exit-rule transition: park the card in Waiting on you. */
  park?: boolean;
}

/** Comment matches an exit/cap "on" selector: every set field must match. */
function matchesOn(on: { author?: string; kind?: string; prefix?: string }, c: { author: string; kind: string; body: string }): boolean {
  if (on.author !== undefined && c.author !== on.author) return false;
  if (on.kind !== undefined && c.kind !== on.kind) return false;
  if (on.prefix !== undefined && !c.body.startsWith(on.prefix)) return false;
  return true;
}

/**
 * The generic lane interpreter (card 3n96c): evaluate a lane's context against a
 * card's thread and say what the loop should do — arm an actor (with the
 * plan-build flavor when approvalInstructions apply), post a cap question,
 * transition the card, or nothing (or blocked, card j2kpq). Replaces roleFor's hardcoded plan/implement/
 * review branches; the seeded contexts reproduce those branches exactly.
 */
export function evaluateLaneContext(
  db: KanbanDb,
  task: Task,
  context: LaneContext,
  opts?: { maxBlocks?: number; maxPlanBlocks?: number; now?: number },
): LaneEvaluation {
  // a blocked card is paused by the human: no actor, no cap question, no
  // transition until its blockers land — then the unchanged thread re-arms it
  // (card j2kpq)
  if (db.isBlocked(task.id)) return { actor: null };

  // pi-elaborator comments are a side-channel note edit: invisible to every
  // lane's state machine — a plan-review pass stays at the gate, an open
  // planner question stays open, a reviewer/builder disarm stays disarmed
  const thread = db.comments(task.id).filter((c) => c.author !== ELABORATOR_AUTHOR);
  const last = thread.at(-1);
  const actors = context.actors;
  const actorById = new Map(actors.map((a) => [a.id, a]));
  const actorByAuthor = new Map(actors.map((a) => [a.author, a]));

  // the loop's cap options still tune the seeded caps: since-human ↔ plan blocks, thread ↔ review blocks
  const capMax = (cap: LaneCapRule): number =>
    cap.scope === "since-human" ? (opts?.maxPlanBlocks ?? cap.max) : (opts?.maxBlocks ?? cap.max);
  const capCount = (cap: LaneCapRule): number => {
    let from = 0;
    if (cap.scope === "since-human") {
      for (let i = thread.length - 1; i >= 0; i--) {
        if (!thread[i]!.author.startsWith("pi-")) {
          from = i + 1;
          break;
        }
      }
    }
    return thread.slice(from).filter((c) => matchesOn(cap.match, c)).length;
  };

  // 1. exit rules against the latest comment — verdict comments route before anything else
  if (last) {
    for (const exit of context.exits ?? []) {
      if (!matchesOn(exit.on, last)) continue;
      switch (exit.action) {
        case "disarm":
          return { actor: null };
        case "move":
          return { actor: null, moveTo: exit.target ?? "" };
        case "park":
          return { actor: null, park: true };
        case "next-actor": {
          const target = (exit.target && actorById.get(exit.target)) || actors[0]!;
          return { actor: target };
        }
        case "rerun-first": {
          const target = (exit.target && actorById.get(exit.target)) || actors[0]!;
          const cap = context.cap;
          if (cap && capCount(cap) >= capMax(cap)) return { actor: null, capped: cap, capMax: capMax(cap) };
          return { actor: target };
        }
      }
    }
    // 2. self-disarm: an actor's own comment (no exit matched) stops its turn —
    // each agent's last comment disarms it, zero tokens spent
    if (actorByAuthor.has(last.author)) return { actor: null };
  }

  // 3. triggers: first match arms the lane. Only a "comment" trigger (an agent
  // verdict cycle) is cap-gated — a human's reply never counts against the cap.
  let armed: LaneActor | null = null;
  let armedByAgent = false;
  for (const trigger of context.triggers) {
    if (trigger.kind === "on-enter") {
      armed = actors[0]!;
      break;
    }
    if (trigger.kind === "human-comment") {
      if (last && !last.author.startsWith("pi-")) {
        armed = actors[0]!;
        break;
      }
      continue;
    }
    if (last && matchesOn({ author: trigger.author, kind: trigger.commentKind, prefix: trigger.prefix }, last)) {
      armed = (trigger.targetActor && actorById.get(trigger.targetActor)) || actors[0]!;
      armedByAgent = last.author.startsWith("pi-");
      break;
    }
  }
  if (!armed) return { actor: null };

  // 4. multi-actor lanes route a human reply / fresh entry by *why* the card is
  // waiting, not just by the trigger: scan back to the most recent decidedBy
  // comment (a newer human rejection outranks it). A non-verdict comment or
  // question from a downstream actor, or an artifact attached after that
  // deciding event (authored outside the loop), re-arms the reviewer on the
  // existing artifact as-is; anything else re-arms the first actor.
  if (actors.length > 1 && !armedByAgent) {
    let decidedBy: (typeof thread)[number] | null = null;
    for (let i = thread.length - 1; i >= 0; i--) {
      const c = thread[i]!;
      if (c.kind === "rejection" || c.author.startsWith("pi-")) {
        decidedBy = c;
        break;
      }
    }
    const downstream = decidedBy !== null && actors.findIndex((a) => a.author === decidedBy!.author) > 0;
    const nonVerdict = downstream && (decidedBy!.kind === "comment" || decidedBy!.kind === "question");
    const artifact = context.artifact ? db.attachment(task.id, context.artifact) : null;
    if (nonVerdict || (artifact && artifact.createdAt > (decidedBy?.createdAt ?? 0))) {
      armed = actors[1]!;
    } else {
      armed = actors[0]!;
    }
  }

  // 5. agent-verdict cycles hit the cap before another spawn is spent
  if (context.cap && armedByAgent && capCount(context.cap) >= capMax(context.cap)) {
    return { actor: null, capped: context.cap, capMax: capMax(context.cap) };
  }

  // 6. the plan-build flavor: when the actor distinguishes approvals from findings,
  // scan back for the latest human approval vs a reviewer verdict comment
  if (armed.approvalInstructions) {
    const verdictAuthors = new Set(
      context.triggers.flatMap((t) => (t.kind === "comment" && t.commentKind === "review" && t.author ? [t.author] : [])),
    );
    let mode: "plan" | "findings" = "findings";
    for (let i = thread.length - 1; i >= 0; i--) {
      const c = thread[i]!;
      if (c.kind === "approval" && !c.author.startsWith("pi-")) {
        mode = "plan";
        break;
      }
      if (c.kind === "review" && verdictAuthors.has(c.author)) {
        mode = "findings";
        break;
      }
    }
    return { actor: armed, mode };
  }

  return { actor: armed };
}

// shared with the claude harness; re-exported so existing importers (lane
// workers, chat, tests) keep importing the helpers from here
export { MAX_SKILL_CHARS, skillActivationPrompt };

/**
 * Merges a project's stored actor override over the actor's config.
 * Present-key semantics: `runsOn` replaces the whole lineup when non-empty
 * (lineups never merge); context/tools replace only when present and
 * non-empty after trim; timeoutMs replaces whenever present; skills/extraArgs
 * replace wholesale when the key is present (a present [] means none) and an
 * absent key inherits. Returns null only when the merged config is empty.
 */
export function applyProjectOverride(cfg: AgentConfig | null, override: AgentConfig | null): AgentConfig | null {
  const result: AgentConfig = { ...(cfg ?? {}) };
  if (override?.runsOn && override.runsOn.length > 0) result.runsOn = override.runsOn;
  if (override?.context?.trim()) result.context = override.context.trim();
  if (override?.tools?.trim()) result.tools = override.tools.trim();
  if (override?.skills !== undefined) result.skills = override.skills;
  if (override?.extraArgs !== undefined) result.extraArgs = override.extraArgs;
  if (override?.timeoutMs !== undefined) result.timeoutMs = override.timeoutMs;
  return Object.keys(result).length > 0 ? result : null;
}

/** The resolved model config of one spawn — what actually ran, read off its engine. */
export interface ModelConfig {
  harness: "pi" | "claude";
  provider?: string;
  model?: string; // absent = the harness's default model
  thinking?: AgentThinking; // pi only: the engine's, else the role default
}

/** An engine's spawn-time model config: thinking falls back to the role default (max for reviewer/planner/plan-reviewer). */
export function resolvedModelConfig(role: AgentRole, engine: Engine): ModelConfig {
  const mc: ModelConfig = { harness: engine.harness };
  if (engine.harness === "pi" && engine.provider) mc.provider = engine.provider;
  if (engine.model) mc.model = engine.model;
  const thinking = effectiveThinking(role, engine);
  if (thinking) mc.thinking = thinking;
  return mc;
}

/** "anthropic · claude-x · high" / "claude · sonnet" — unset parts dropped, model falls back to "default model". */
export function modelConfigLabel(mc: Partial<ModelConfig>): string {
  if (mc.harness === "claude") return ["claude", mc.model ?? "default model", mc.thinking ?? ""].filter(Boolean).join(" · ");
  return [mc.provider, mc.model ?? "default model", mc.thinking ?? ""].filter(Boolean).join(" · ");
}

/**
 * pi flags for one spawn: provider/model/thinking from the engine (thinking
 * falls back to the role default), configured skills activated by injecting
 * their SKILL.md into the appended system prompt (skillActivationPrompt;
 * warnings go to onWarn), the actor's pi tool filter and extra flags, then the
 * engine's raw flags.
 */
export function agentFlags(role: AgentRole, engine: Engine, cfg: AgentConfig | null, onWarn?: (message: string) => void): string[] {
  const mc = resolvedModelConfig(role, engine);
  const args: string[] = [];
  if (mc.provider) args.push("--provider", mc.provider);
  if (mc.model) args.push("--model", mc.model);
  if (mc.thinking) args.push("--thinking", mc.thinking);
  for (const skill of cfg?.skills ?? []) args.push("--skill", skill);
  const activated = skillActivationPrompt(cfg?.skills ?? [], onWarn);
  const appended = [cfg?.context, activated].filter(Boolean).join("\n\n");
  if (appended) args.push("--append-system-prompt", appended);
  if (cfg?.tools) args.push("--tools", cfg.tools);
  args.push(...(cfg?.extraArgs ?? []));
  args.push(...engine.flags);
  return args;
}

/**
 * A fresh pi session per spawn: `--session-id` resumes an existing session, so a
 * per-card id would let every role inherit every earlier transcript (the builder
 * would see the planner's reasoning, hiding plan gaps). The card thread
 * (`kanban brief`) is the only shared context.
 */
export function sessionIdFor(job: AgentJob, now: number = Date.now()): string {
  return `kanban-${job.task.id}-${job.role}-${now.toString(36)}`;
}

// moved to agent-child.ts with the shared runner; re-exported for existing importers
export { durationFor };

/** The "why" for a death comment, from the spawn result plus what the session actually emitted. */
export function deathReason(result: SpawnResult, secs: number, sessionLog: string[]): string {
  const dur = durationFor(secs);
  if (result.stalled) return `stalled after ${dur} — no output for ${durationFor((result.stalledAfterMs ?? 0) / 1000)}`;
  if (result.timedOut) return `timed out after ${dur}`;
  const lines = (result.stderrTail ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const compact = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);
  const last = lines.length > 0 ? compact(lines.at(-1)!) : "";
  if (result.code !== 0) return `failed (exit ${result.code}${last ? ` — ${last}` : ""}) after ${dur}`;
  if (!sessionLog.some((l) => l.startsWith("text: "))) {
    return `ended without a verdict after ${dur} — model returned no output`;
  }
  return `ended without a verdict after ${dur}`;
}

/** What one headless `pi --mode json` child needs; shared by the loop and the lane-worker runner. */
export interface SpawnPiInput {
  cwd: string;
  sessionId: string;
  prompt: string;
  /** pi flags between --session-id and the prompt (agentFlags / workerArgs). */
  args: string[];
  timeoutMs: number;
  stallMs: number;
  log: (message: string) => void;
  /** Streams one formatted output line from the running session. */
  emit: (line: string) => void;
  /** Registers the child's kill handle so shutdown can terminate in-flight sessions; returns an untrack cleanup function. */
  track: (kill: () => void) => () => void;
  /** Signals raw child output — bytes count even when the formatter drops them, proving a quiet session alive. */
  touch?: () => void;
}

/** The one pi spawn: the shared agent-child runner over pi's `--mode json` JSONL. */
export function spawnPi(input: SpawnPiInput): Promise<SpawnResult> {
  const { cwd, sessionId, prompt, args, timeoutMs, stallMs, log, emit, track, touch } = input;
  // json mode streams JSONL events while the session runs (--print waits for the end)
  return runAgentChild({
    cmd: ["pi", "--mode", "json", "--session-id", sessionId, ...args, prompt],
    cwd,
    timeoutMs,
    stallMs,
    log,
    emit,
    track,
    touch,
    formatEvent: formatPiEvent,
  });
}

export const defaultSpawn: SpawnFn = (job, { cwd, timeoutMs, stallMs, config, engine, log, emit, track, touch }) => {
  // the loop's log lines stay job-prefixed ("reviewer <id>: stalled — …"); the harness logs bare
  const shared = {
    cwd,
    sessionId: job.sessionId ?? sessionIdFor(job),
    prompt: job.prompt,
    timeoutMs,
    stallMs,
    log: (message: string) => log(`${job.role} ${job.task.id}: ${message}`),
    emit,
    track,
    touch,
  };
  if (engine.harness === "claude") {
    return spawnClaude({ ...shared, args: claudeFlags(job.role, engine, config, log), resume: job.mode === "resume" });
  }
  return spawnPi({ ...shared, args: agentFlags(job.role, engine, config, log) });
};

export const LEASE_TTL_MS = 60_000;

export function startAutoReview(opts: AutoReviewOptions): { stop(): void } {
  const db = opts.db;
  const log = opts.log ?? (() => {});
  const spawnFn = opts.spawnFn ?? defaultSpawn;

  // ---------- cross-process session leases ----------
  // One agent per card across every server: the lease is taken before spawn,
  // heartbeated while the session runs, released on finish/shutdown. A lease
  // whose heartbeat went stale (owner killed hard) is reclaimable.
  const owner: LeaseOwner = { pid: process.pid, bootId: Date.now() };
  const LEASE_HEARTBEAT_MS = 15_000;
  const kills = new Set<() => void>();
  const track = (kill: () => void): (() => void) => {
    kills.add(kill);
    return () => {
      kills.delete(kill);
    };
  };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
  const maxBlocks = opts.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const maxPlanBlocks = opts.maxPlanBlocks ?? DEFAULT_MAX_PLAN_BLOCKS;
  const gateOff = (name: string) => process.env[name] === "0";
  const gate = opts.gate !== undefined ? opts.gate : gateOff("KANBAN_AGENTS_GATE") || gateOff("KANBAN_AUTOREVIEW_GATE") ? null : defaultGate;
  const gateTimeoutMs = opts.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;

  const queue: Array<AgentJob & { enqueuedAt: number }> = [];
  const inFlight = new Set<string>();
  const sessions = new Map<string, AgentSessionInfo>();
  const health = new EngineHealth(opts.cooldownMs ?? DEFAULT_COOLDOWN_MS);
  const provide = (): ActivityReport => ({
    sessions: [...sessions.values()],
    queued: queue.map(({ task, role, enqueuedAt }) => ({ taskId: task.id, role, enqueuedAt })),
    incidents: health.incidents(),
    engines: health.summaries(db.engines()),
  });
  activityProviders.add(provide);
  // kills holds cleanup handles (spawn kills *and* heartbeat clears), so the
  // session count comes from `sessions` — the in-flight map
  const killInFlight = (): number => {
    for (const kill of kills) {
      try {
        kill();
      } catch {
        /* already gone */
      }
    }
    return sessions.size;
  };
  pauseKillers.add(killInFlight);
  const busySlots = new Set<string>();
  let draining = false;
  let stopped = false;

  interface AllocatedSlot {
    /** Seat key `${engineId}:${seat}` — held in busySlots while the session runs. */
    key: string;
    engine: Engine;
    /** 0 = the lineup's first choice; > 0 = a fallback. */
    rank: number;
    source: ReturnType<typeof resolveLineup>["source"];
  }

  /** Busy seats on an engine (seat keys are `${engineId}:${i}`). */
  const busyOn = (engine: Engine): number => {
    let n = 0;
    for (const key of busySlots) if (key.startsWith(`${engine.id}:`)) n++;
    return n;
  };

  /**
   * The lineup allocator: resolve the actor's lineup (env pin → project
   * override → actor → board default), take the first enabled, non-cooling
   * engine with a free seat. Null = every engine in the lineup is full,
   * cooling, or disabled — the job waits.
   */
  function allocate(role: AgentRole, project: string | undefined): AllocatedSlot | null {
    health.syncEngines(db.engines());
    const lineup = resolveLineup(db, role, project);
    for (const [rank, engine] of lineup.engines.entries()) {
      if (!engine.enabled || health.isCooling(engine)) continue;
      for (let i = 0; i < engine.seats; i++) {
        const key = `${engine.id}:${i}`;
        if (!busySlots.has(key)) return { key, engine, rank, source: lineup.source };
      }
    }
    return null;
  }

  // a cooled engine requalifies at expiry — wake the loop then (nothing else would)
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const armExpiryRescan = (): void => {
    const at = health.nextExpiry();
    if (at === null) return;
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined;
      if (!stopped) scan();
    }, Math.max(0, at - Date.now()) + 50);
    expiryTimer.unref?.();
  };

  /**
   * What the card needs right now: its lane's context interpreted, or nothing
   * (plain lane, disarmed, capped, or transitioned). No lane ids here — the
   * seeded contexts (defaultLaneContext) carry the whole pipeline.
   */
  // explicit loop options tune matching caps; absent options leave every cap rule
  // (seeded 2/3 = the old defaults, or custom) at its own max (card 3n96c)
  const capOpts: { maxBlocks?: number; maxPlanBlocks?: number } = {};
  if (opts.maxBlocks !== undefined) capOpts.maxBlocks = maxBlocks;
  if (opts.maxPlanBlocks !== undefined) capOpts.maxPlanBlocks = maxPlanBlocks;
  const roleFor = (task: Task): { context: LaneContext; evaluation: LaneEvaluation } | null => {
    const context = db.laneContext(task.laneId); // unknown lane reads as context-free
    if (!context) return null;
    return { context, evaluation: evaluateLaneContext(db, task, context, capOpts) };
  };

  const enqueue = (job: AgentJob): void => {
    if (stopped || inFlight.has(job.task.id) || queue.some((j) => j.task.id === job.task.id)) return;
    queue.push({ ...job, enqueuedAt: Date.now() });
    if (sessions.size > 0 || busySlots.size > 0 || draining) {
      const head = [...sessions.values()][0];
      log(head ? `${job.role} queued ${job.task.id} — behind ${head.role} ${head.taskId}` : `${job.role} queued ${job.task.id}`);
    }
  };

  /** A blocked card's resume is held as a persisted request — the row is the
   *  durable artifact, the queue is only a cache (card j2kpq). */
  const holdResume = (job: AgentJob): void => {
    db.queueResume(job.task.id);
    log(`${job.role} ${job.task.id}: blocked — resume held, request kept until its blockers land`);
  };

  function scan(): void {
    // the board-level pause gates every loop: no scan work, no capped-cap
    // comments, nothing — until the flag clears (the pause write itself wakes
    // the watcher on resume)
    if (stopped || db.agentsPaused()) return;
    for (const req of db.resumeRequests()) {
      const task = db.tasks().find((t) => t.id === req.taskId);
      if (!task) {
        db.clearResumeRequest(req.taskId);
        continue;
      }
      if (db.leaseFor(task.id, LEASE_TTL_MS)) continue;
      // a blocked card's resume waits with its request intact: the row is not
      // cleared, so the first scan after the blocker lands spawns it (card j2kpq)
      if (db.isBlocked(task.id)) continue;
      const session = db.cardSession(task.id);
      if (!session) {
        db.clearResumeRequest(task.id);
        continue;
      }
      const last = db.comments(task.id).at(-1);
      const lastBody = last?.body ?? "";
      const reason = lastBody.startsWith(KanbanDb.SESSION_DIED_PREFIX)
        ? lastBody.slice(KanbanDb.SESSION_DIED_PREFIX.length).trim()
        : "session died";
      const prompt = resumePrompt(task, session.role, reason, db.laneContexts()[task.laneId]?.actors.find((a) => a.id === session.role));
      const job: AgentJob = {
        task,
        role: session.role,
        laneId: task.laneId,
        sessionId: session.sessionId,
        prompt,
        mode: "resume",
      };
      db.clearResumeRequest(task.id);
      enqueue(job);
    }
    for (const req of db.elaborationRequests()) {
      const task = db.tasks().find((t) => t.id === req.taskId);
      if (!task) { db.clearElaboration(req.taskId); continue; }
      if (db.leaseFor(task.id, LEASE_TTL_MS)) continue;
      // request-driven, not lane-driven: hold the request while a job for this
      // card is already queued or running so it can never be lost
      if (inFlight.has(task.id) || queue.some((j) => j.task.id === task.id)) continue;
      db.clearElaboration(task.id); // safe: scan() is synchronous, not stopped, and enqueue's guards just passed
      enqueue({ task, role: "elaborator", mode: "elaborate", prompt: elaboratorPrompt(task) });
    }
    for (const task of db.tasks()) {
      if (db.leaseFor(task.id, LEASE_TTL_MS)) continue; // another process (or our own session) works this card
      const hit = roleFor(task);
      if (!hit) continue;
      const { context, evaluation: ev } = hit;
      if (ev.capped) {
        // posting flips the last comment away from the verdict, so this fires once
        db.comment(task.id, {
          author: ev.capped.author,
          kind: "question",
          body: ev.capped.message.replaceAll("{id}", task.id).replaceAll("{max}", String(ev.capMax ?? ev.capped.max)),
        });
        log(`${ev.capped.author} ${task.id}: cap reached — parked in waiting for a human`);
        continue;
      }
      if (ev.moveTo) {
        db.updateTask(task.id, { lane: ev.moveTo }, { cause: "mv", actor: "kanban" });
        log(`${task.laneId} ${task.id}: exit rule moved card → ${ev.moveTo}`);
        continue;
      }
      if (ev.park) {
        db.parkTask(task.id);
        log(`${task.laneId} ${task.id}: exit rule parked card in waiting for a human`);
        continue;
      }
      const actor = ev.actor;
      if (!actor) continue;
      // an epic gets the decomposition charter, not the build template, wherever
      // it plans (ceqfq) — keyed on the artifact template, not the 'plan' id,
      // so custom plan-like lanes charter their epics too
      const planCtx =
        db.childrenOf(task.id).length > 0 && context.template !== undefined
          ? epicPlanContextFor(context)
          : context;
      enqueue({
        task,
        role: actor.id,
        laneId: task.laneId,
        mode: ev.mode,
        prompt: renderActorPrompt(task, task.laneId, planCtx, actor, ev.mode),
      });
    }
    void drain();
  }

  async function runJob(job: AgentJob, allocated: AllocatedSlot): Promise<void> {
    const { engine, key: slotKey } = allocated;
    try {
      const fresh = db.tasks().find((t) => t.id === job.task.id);
      if (!fresh) return;
      // per-card repo routing (project route): every role and mode spawns where
      // the card's project points; un-routed tags fall back to the serve cwd
      const cwd = db.projectCwd(fresh.project) ?? opts.cwd;
      if (job.mode === "resume") {
        if (db.waiting(job.task.id) !== "dead") return;
      } else if (job.mode === "elaborate") {
        // request-driven: no roleFor precondition
      } else {
        if (roleFor(fresh)?.evaluation.actor?.id !== job.role) return; // state moved on while queued
      }
      // pre-spawn test gate: any lane whose context sets testGate (review today;
      // card 3n96c generalizes it to custom lanes), unless the project turned it off
      const gateCtx = db.laneContext(job.laneId ?? fresh.laneId);
      if (gate && gateCtx?.testGate) {
        if (db.getProject(fresh.project)?.testGate === false) {
          log(`${job.role} ${fresh.id}: test gate off for project '${fresh.project}' — skipping`);
        } else {
          inFlight.add(job.task.id); // hold the card so a scan mid-gate can't enqueue a duplicate
          const cmd = db.getProject(fresh.project)?.testCmd ?? null; // fresh per gate run: web edits apply to the next spawn
          log(`${job.role} ${job.task.id}: running pre-spawn test gate${cmd ? ` (${cmd})` : ""}`);
          let res: GateResult;
          try {
            res = await gate(cwd, gateTimeoutMs, cmd ?? undefined);
          } catch (err) {
            log(`${job.role} ${job.task.id}: gate could not run (${(err as Error).message}) — reviewing anyway`);
            res = { ok: true, output: "" }; // fail-open: the gate is best-effort
          }
          inFlight.delete(job.task.id);
          if (stopped) return;
          if (!res.ok) {
            db.comment(job.task.id, {
              author: gateCtx.actors[0]?.author ?? authorForRole(job.role),
              kind: "question",
              body: `pre-review gate: \`${cmd ?? "bun test"}\` failed — no reviewer session spawned.\n\n\`\`\`\n${res.output}\n\`\`\`\nFix the tests, then comment on this card to re-trigger review.`,
            });
            log(`${job.role} ${job.task.id}: gate red — no session spawned`);
            return; // the question parks the card in waiting — the lane change disarms it (roleFor ignores waiting)
          }
        }
      }
      // the gate can run for minutes: a card blocked meanwhile is held; a resume
      // job hands its request back because it was cleared at enqueue (card j2kpq)
      if (job.mode !== "elaborate" && db.isBlocked(job.task.id)) {
        if (job.mode === "resume") holdResume(job);
        return;
      }
      if (!db.tryTakeLease(job.task.id, job.role, owner, LEASE_TTL_MS)) {
        log(`${job.role} ${job.task.id}: lease held by another server — skipping`);
        return;
      }
      inFlight.add(job.task.id);
      // the harness decides the session-id shape (claude accepts only UUIDs);
      // a resume across harnesses keeps the old id and the harness starts fresh
      job.sessionId ??= engine.harness === "claude" ? crypto.randomUUID() : sessionIdFor(job);
      db.setCardSession(job.task.id, job.role, job.sessionId);
      if (job.mode === "resume") {
        db.createComment(job.task.id, {
          author: "kanban",
          kind: "comment",
          body: `${KanbanDb.SESSION_RESUMED_PREFIX}continuing ${authorForRole(job.role)} session ${job.sessionId} — the transcript picks up where it died.`,
        });
      }
      const roleConfig = db.agentConfig(job.role); // fresh per spawn: web edits apply to the next session
      const override = db.projectAgentConfig(fresh.project, job.role);
      const config = applyProjectOverride(roleConfig, override);
      const mc = resolvedModelConfig(job.role, engine);
      const label = modelConfigLabel(mc);
      const skills = config?.skills?.length ? `${config.skills.length} skill${config.skills.length === 1 ? "" : "s"}` : "";
      const via = `on engine ${engine.name}${allocated.rank > 0 ? ` (fallback #${allocated.rank})` : ""}`;
      const overrideNote = allocated.source === "project" ? ` — project '${fresh.project}' override` : allocated.source === "env" ? " — KANBAN_ENGINE pin" : "";
      log(`${job.role} start ${job.task.id} "${job.task.title}" (${[label, skills].filter(Boolean).join(" · ")}) ${via}${overrideNote}`);
      const startedAt = Date.now();
      const session: AgentSessionInfo = {
        taskId: job.task.id,
        role: job.role,
        startedAt,
        lastActivityAt: startedAt,
        log: [],
        logAt: [],
        modelLabel: label,
        ...(mc.model ? { model: mc.model } : {}),
        engine: engine.name,
      };
      // stop() must be able to silence the heartbeat even when the spawn
      // promise never settles (a stuck/fake child) — otherwise the 15s tick
      // lands on a closed db long after the test (or server) tore down
      const beat = setInterval(() => db.heartbeatLease(job.task.id, owner), LEASE_HEARTBEAT_MS);
      const stopBeat = track(() => clearInterval(beat));
      sessions.set(job.task.id, session);
      const emit = (line: string): void => {
        const at = Date.now();
        session.lastActivityAt = at;
        session.log.push(line);
        session.logAt.push(at);
        if (session.log.length > MAX_LOG_LINES) {
          session.log.shift();
          session.logAt.shift();
        }
        log(`${job.role} ${job.task.id} │ ${line}`);
      };
      emit(`model: ${label}`);
      const jobKills = new Set<() => void>();
      // the raw kill handles this spawn registered (jobKills holds their UNTRACKs —
      // calling those only detaches; the per-session stop verb wants the kills)
      const jobKillFns = new Set<() => void>();
      const jobTrack = (kill: () => void): (() => void) => {
        jobKillFns.add(kill);
        const untrack = track(kill);
        jobKills.add(untrack);
        return () => {
          jobKillFns.delete(kill);
          jobKills.delete(untrack);
          untrack();
        };
      };
      let result: SpawnResult = { code: 1 };
      sessionKillers.set(job.task.id, () => {
        for (const kill of [...jobKillFns]) kill();
      });
      try {
        result = await spawnFn(job, { cwd, timeoutMs: config?.timeoutMs ?? timeoutMs, stallMs, config, engine, log, emit, track: jobTrack, touch: () => { session.lastActivityAt = Date.now(); } });
        if (result.stalled) emit(`stalled — no output for ${durationFor((result.stalledAfterMs ?? 0) / 1000)}, killed`);
        if (result.timedOut) emit("timed out — killed");
        if (result.stderrTail) emit(`stderr tail:\n${result.stderrTail}`);
      } catch (err) {
        log(`${job.role} ${job.task.id}: spawn error ${(err as Error).message}`);
        result = { code: 1, stderrTail: `spawn error: ${(err as Error).message}` };
        if (result.stalled) emit(`stalled — no output for ${durationFor((result.stalledAfterMs ?? 0) / 1000)}, killed`);
        if (result.timedOut) emit("timed out — killed");
        if (result.stderrTail) emit(`stderr tail:\n${result.stderrTail}`);
      } finally {
        for (const untrack of jobKills) untrack();
        jobKills.clear();
        // keep the transcript on the card — the live view evaporates when the session ends
        if (!stopped && session.log.length > 0) {
          const secs = Math.max(1, Math.round((Date.now() - session.startedAt) / 1000));
          const header = `${authorForRole(job.role)} · ${label} · ${new Date(session.startedAt).toLocaleString()} · ${secs}s`;
          try {
            db.attach(job.task.id, "session", `${header}\n${stampSessionLog(session.log, session.logAt)}`, "autoreview");
          } catch (err) {
            log(`${job.role} ${job.task.id}: could not save the session log (${(err as Error).message})`);
          }
        }
        sessions.delete(job.task.id);
        sessionKillers.delete(job.task.id);
        stopBeat();
        clearInterval(beat);
        if (!stopped) {
          try {
            db.releaseLease(job.task.id, owner);
          } catch {
            /* db may be closed */
          }
        }
      }
      inFlight.delete(job.task.id);
      if (!stopped) {
        try {
          afterJob(job, result, session, allocated);
        } catch (err) {
          log(`${job.role} ${job.task.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
        scan(); // follow the verdict: block → builder, handoff → reviewer
      }
    } finally {
      busySlots.delete(slotKey);
      if (!stopped) drain();
    }
  }

  function drain(): void {
    if (stopped || db.agentsPaused() || draining) return;
    draining = true;
    try {
      const remaining: Array<AgentJob & { enqueuedAt: number }> = [];
      for (const job of queue) {
        if (stopped || db.agentsPaused()) {
          remaining.push(job);
          continue;
        }
        const fresh = db.tasks().find((t) => t.id === job.task.id);
        if (!fresh) continue;
        if (job.mode === "resume") {
          if (db.waiting(job.task.id) !== "dead") continue;
          if (db.isBlocked(job.task.id)) {
            holdResume(job); // persisted, then dropped: a restart re-reads the row
            continue;
          }
        } else if (job.mode === "elaborate") {
          // request-driven: no roleFor precondition
        } else {
          if (roleFor(fresh)?.evaluation.actor?.id !== job.role) continue;
        }
        if (db.leaseFor(job.task.id, LEASE_TTL_MS)) continue;

        if (busySlots.size >= db.maxWorkers()) {
          remaining.push(job);
          continue;
        }

        const allocated = allocate(job.role, fresh.project);
        if (!allocated) {
          remaining.push(job);
          continue;
        }

        busySlots.add(allocated.key);
        void runJob(job, allocated);
      }
      queue.length = 0;
      queue.push(...remaining);
    } finally {
      draining = false;
    }
  }

  /** Log the outcome; if the session died without leaving a trace, say so on the card. */
  /** Log the outcome; if the session died without leaving a trace, say so on the card.
   *  Shape comes from the job's lane context (card 3n96c): a gated lane's reviewer
   *  reports verdicts, any other actor reports where its handoff landed. */
  function afterJob(job: AgentJob, result: SpawnResult, session: AgentSessionInfo, allocated: AllocatedSlot): void {
    const task = db.tasks().find((t) => t.id === job.task.id);
    if (!task) return;
    const last = db.comments(task.id).at(-1);
    const secs = Math.max(1, Math.round((Date.now() - session.startedAt) / 1000));
    const reason = deathReason(result, secs, session.log);
    if (job.role === "elaborator") {
      if (last?.author === ELABORATOR_AUTHOR) log(`elaborator ${task.id}: note elaborated`);
      else {
        db.createComment(task.id, {
          author: ELABORATOR_AUTHOR,
          kind: "comment",
          body: `${KanbanDb.SESSION_DIED_PREFIX}elaboration ${reason} — retry with kanban elaborate ${task.id}`,
        });
      }
      return;
    }
    const actor =
      (job.laneId ? db.laneContext(job.laneId)?.actors.find((a) => a.id === job.role) : null) ?? seededActorFor(job.role);
    const author = actor?.author ?? authorForRole(job.role);
    const gated = (job.laneId ? db.laneContext(job.laneId)?.gate : undefined) !== undefined;
    const moved = job.laneId !== undefined && task.laneId !== job.laneId;
    if (!gated && !actor?.approvalInstructions && moved && (task.laneId === "done" || (last?.author === author && (last.kind === "handoff" || last.kind === "review")))) {
      // the card left the lane: the actor's verdict/handoff landed (or a human moved it)
      if (task.laneId === "done") log(`${job.role} ${task.id}: approved → done`);
      else if (job.mode === "plan") log(`${job.role} ${task.id}: built the plan → ${task.laneId}`);
      else log(`${job.role} ${task.id}: fixed → back to ${task.laneId}`);
    } else if (last?.author === author) {
      if (last.kind === "review" && last.body.startsWith(KanbanDb.PLAN_REVIEW_PASS)) {
        log(`${job.role} ${task.id}: pass — parked in Waiting on you at the human gate`);
      } else {
        log(`${job.role} ${task.id}: ${last.kind === "review" ? "verdict recorded" : "left a comment, no verdict"}`);
      }
    } else {
      const { cause, waitHintMs } = classifySpawnFailure(result, session.log);
      if (PROVIDER_LEVEL_CAUSES.has(cause)) {
        // the account is exhausted, not the seat: every engine on it cools together
        health.record(allocated.engine, cause, waitHintMs != null ? { waitHintMs } : undefined);
        armExpiryRescan();
      }

      // backward scan for retriesUsed:
      // Scan comments newest→oldest from the new death: count bodies that start with
      // SESSION_DIED_PREFIX and include RETRY_MARKER; continue over any SESSION_DIED_PREFIX
      // comment (marked or plain) and any SESSION_RESUMED_PREFIX comment; break at the first
      // comment that is neither.
      const taskComments = db.comments(task.id);
      let retriesUsed = 0;
      for (let i = taskComments.length - 1; i >= 0; i--) {
        const c = taskComments[i];
        const isDied = c.body.startsWith(KanbanDb.SESSION_DIED_PREFIX);
        const isResumed = c.body.startsWith(KanbanDb.SESSION_RESUMED_PREFIX);
        if (isDied) {
          if (c.body.includes(RETRY_MARKER)) {
            retriesUsed++;
          }
          continue;
        }
        if (isResumed) {
          continue;
        }
        break;
      }

      const lineup = resolveLineup(db, job.role, task.project).engines.filter((e) => e.enabled);
      const allCooling = lineup.length > 0 && lineup.every((e) => health.isCooling(e));
      const anyHealthy = lineup.length > 0 && !allCooling;

      const label = actor?.deathLabel ?? job.role;
      const tail =
        actor?.deathHint ??
        (job.mode === "plan"
          ? " — plan not built, needs a human. comment on this card to re-trigger."
          : " — findings unaddressed, needs a human. comment on this card to re-trigger.");

      if (PROVIDER_LEVEL_CAUSES.has(cause) && allCooling) {
        // Consolidated park when every engine in the lineup is cooling
        const desc = lineup
          .map((e) => {
            const inc = health.incident(e);
            return `'${e.name}'${inc ? ` ${inc.cause} ×${inc.count}` : ""}`;
          })
          .join(", ");
        db.createComment(task.id, {
          author,
          kind: "comment",
          body: `${KanbanDb.SESSION_DIED_PREFIX}${label} ${reason} — every engine in the lineup is cooling down: ${desc}${tail}`,
        });
      } else if (
        retriesUsed < RETRY_LIMIT &&
        (RETRYABLE_CAUSES.has(cause) ||
          (PROVIDER_LEVEL_CAUSES.has(cause) && anyHealthy))
      ) {
        // Retry
        const n = retriesUsed + 1;
        db.createComment(task.id, {
          author,
          kind: "comment",
          body: `${KanbanDb.SESSION_DIED_PREFIX}${label} ${reason} ${RETRY_MARKER}${n}/${RETRY_LIMIT} (${cause})`,
        });
        const delayMs = (opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS) * n;
        const timer = setTimeout(() => {
          try {
            db.queueResume(task.id);
            scan();
          } catch {
            /* db may be closed */
          }
        }, delayMs);
        timer.unref?.();
      } else {
        // Plain park
        db.createComment(task.id, {
          author,
          kind: "comment",
          body: `${KanbanDb.SESSION_DIED_PREFIX}${label} ${reason}${tail}`,
        });
      }
    }
  }

  const stopWatch = db.watch(() => scan(), opts.watchIntervalMs ?? 300);
  const routed = db.listProjects().filter((p) => p.repoPath).length;
  log(
    `enabled — agents run in ${opts.cwd}${routed > 0 ? ` +${routed} routed project${routed === 1 ? "" : "s"}` : ""}, ` +
      `stall ${Math.round(stallMs / 60_000)} min / cap ${Math.round(timeoutMs / 60_000)} min, block cap ${maxBlocks}, test gate ${gate ? "on" : "off"}`,
  );
  scan(); // cards already waiting get picked up right away

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      stopWatch();
      if (expiryTimer) clearTimeout(expiryTimer);
      activityProviders.delete(provide);
      pauseKillers.delete(killInFlight);
      // a restart/shutdown kill must not leave the board silent — trace it on
      // every in-flight card (the 10/29 incident: force-restart killed a
      // planner and the card looked untouched, "is it done?" was unanswerable)
      for (const session of sessions.values()) {
        try {
          db.createComment(session.taskId, {
            author: authorForRole(session.role),
            kind: "comment",
            body: `${KanbanDb.SESSION_DIED_PREFIX}session killed by server restart/shutdown — comment on this card to re-run.`,
          });
        } catch {
          /* db may already be closed */
        }
      }
      sessions.clear();
      queue.length = 0;
      // graceful shutdown: terminate in-flight children so they stop writing,
      // then drop our leases — no orphans outlive this server
      for (const kill of kills) {
        try {
          kill();
        } catch {
          /* already gone */
        }
      }
      kills.clear();
      db.releaseLeases(owner);
    },
  };
}
