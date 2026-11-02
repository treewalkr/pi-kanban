import { homedir } from "node:os";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { BUILDER_AUTHOR, KanbanDb, PLAN_REVIEWER_AUTHOR, defaultLaneContext, PLAN_SECTIONS, PLAN_TEMPLATE, type AgentConfig, type AgentRole, type AgentThinking, type BuiltinAgentRole, type LaneActor, type LaneCapRule, type LaneContext, type LeaseOwner, type PoolSlot, type Task, type WorkerPool } from "./db";

export type { AgentRole, BuiltinAgentRole, LaneActor, LaneContext };
export { PLAN_REVIEWER_AUTHOR };
export { BUILDER_AUTHOR };
export { PLAN_SECTIONS, PLAN_TEMPLATE };

/**
 * Auto-agents loop, hosted by the serve process (`KANBAN_AUTO_REVIEW=1`).
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
  log: (message: string) => void;
  /** Streams one formatted output line from the running session. */
  emit: (line: string) => void;
  /** Registers the child's kill handle so shutdown can terminate in-flight sessions; returns an untrack cleanup function. */
  track: (kill: () => void) => () => void;
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
  /** Pre-spawn test gate for reviewer jobs; null disables. Default: defaultGate, unless KANBAN_AUTOREVIEW_GATE=0. */
  gate?: GateFn | null;
  gateTimeoutMs?: number;
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

/** Fast checks run before a reviewer session is spent; ok=false means red tests. */
export type GateFn = (cwd: string, timeoutMs: number) => Promise<GateResult>;

// gate runs are serialized process-wide: two cards entering Review together used to run two
// full suites concurrently, and their repro.sh port-pin tests raced each other onto 4615 —
// the loser hung to its timeout and parked its card on a flake (zfe3f, 2026-11-01)
let gateChain: Promise<unknown> = Promise.resolve();

export const defaultGate: GateFn = (cwd, timeoutMs) => {
  const run = () => gateRun(cwd, timeoutMs);
  const next = gateChain.then(run, run);
  gateChain = next.catch(() => {});
  return next;
};

const gateRun = async (cwd: string, timeoutMs: number): Promise<GateResult> => {
  // per-test timeout raised from bun's 5s default: spawn-heavy tests (cli.ts subprocesses,
  // repro server boots) legitimately exceed it under full-suite parallel load and park cards
  // on flakes — 30s keeps genuinely red tests failing fast while tolerating load
  const proc = Bun.spawn({ cmd: ["bun", "test", "--timeout", "30000"], cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
    ? { ok: false, output: `bun test timed out after ${durationFor(Math.round(timeoutMs / 1000))}\n${output}` }
    : { ok: code === 0, output };
};

export interface AgentSessionInfo {
  taskId: string;
  role: AgentRole;
  startedAt: number;
  log: string[];
  model?: string;
  modelLabel?: string;
  pool?: string;
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
}

const activityProviders = new Set<() => ActivityReport>();

/** In-flight agent sessions across all autoreview instances, for the /activity endpoint. */
export function activitySnapshot(): ActivityReport {
  const sessions: AgentSessionInfo[] = [];
  const queued: QueuedJobInfo[] = [];
  for (const provide of activityProviders) {
    const report = provide();
    sessions.push(...report.sessions);
    queued.push(...report.queued);
  }
  return { sessions, queued };
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

export function plannerPrompt(task: Task, now: number = Date.now()): string {
  const ctx = defaultLaneContext("plan")!;
  return renderActorPrompt(task, "plan", ctx, ctx.actors[0]!, undefined, now);
}

export function planReviewerPrompt(task: Task): string {
  const ctx = defaultLaneContext("plan")!;
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
 * transition the card, or nothing. Replaces roleFor's hardcoded plan/implement/
 * review branches; the seeded contexts reproduce those branches exactly.
 */
export function evaluateLaneContext(
  db: KanbanDb,
  task: Task,
  context: LaneContext,
  opts?: { maxBlocks?: number; maxPlanBlocks?: number; now?: number },
): LaneEvaluation {
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

/** Max characters of a SKILL.md body injected into the system prompt (argv safety). */
export const MAX_SKILL_CHARS = 64 * 1024;

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

/**
 * Reads every configured skill path (directory → its SKILL.md, or the file
 * itself; `~` expanded), strips YAML frontmatter, and wraps the body in pi's
 * own <skill> block shape — the format `/skill:name` expands to, mirroring
 * pi's _expandSkillCommand — so the skill is active from the first token
 * instead of waiting for the model to open it. Unreadable paths warn via
 * onWarn and are skipped; a spawn never dies on a skill.
 */
export function skillActivationPrompt(skills: string[], onWarn?: (message: string) => void): string {
  const blocks: string[] = [];
  for (const raw of skills) {
    const base = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
    let filePath = base;
    try {
      if (statSync(base).isDirectory()) filePath = join(base, "SKILL.md");
    } catch {
      onWarn?.(`skill ${raw} not found — skipped`);
      continue;
    }
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (err) {
      onWarn?.(`skill ${raw} unreadable (${(err as Error).message}) — skipped`);
      continue;
    }
    const stripped = stripFrontmatter(content).trim();
    const body = stripped.slice(0, MAX_SKILL_CHARS);
    if (body.length < stripped.length) onWarn?.(`skill ${raw} truncated at ${MAX_SKILL_CHARS} chars`);
    const name = /^name:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? basename(dirname(filePath));
    blocks.push(`<skill name="${name}" location="${filePath}">\nReferences are relative to ${dirname(filePath)}.\n\n${body}\n</skill>`);
  }
  return blocks.join("\n\n");
}

/**
 * Merges a pool slot's set fields over the role's agent config.
 * Unset slot fields inherit from the role config; skills/context/tools/timeout
 * pass through untouched (a slot structurally cannot set them).
 * Returns null only when the merged config is empty.
 */
export function mergeSlotConfig(cfg: AgentConfig | null, slot: PoolSlot | undefined): AgentConfig | null {
  if (!cfg && !slot) return null;
  const result: AgentConfig = cfg ? { ...cfg } : {};
  if (slot?.provider?.trim()) result.provider = slot.provider.trim();
  if (slot?.model?.trim()) result.model = slot.model.trim();
  if (slot?.thinking) result.thinking = slot.thinking;
  return Object.keys(result).length > 0 ? result : null;
}

/** The resolved model config of one spawn — what actually ran. */
export interface ModelConfig {
  provider?: string;
  model?: string; // absent = pi's default model
  thinking?: AgentThinking; // AgentThinking imported (type-only) from ./db
}

/** Env > config > role-default resolution — the same one agentFlags applies. */
export function resolvedModelConfig(role: AgentRole, cfg: AgentConfig | null): ModelConfig {
  const envModel = process.env.KANBAN_AUTOREVIEW_MODEL?.trim();
  const envThinking = process.env.KANBAN_AUTOREVIEW_THINKING;
  let thinking: AgentThinking | undefined =
    (envThinking !== undefined && envThinking.trim() !== "" ? (envThinking.trim() as AgentThinking) : undefined) ||
    (cfg?.thinking ? cfg.thinking : undefined) ||
    (role === "reviewer" || role === "planner" || role === "plan-reviewer" ? "max" : undefined);
  if (envThinking === "") thinking = undefined;
  const mc: ModelConfig = {};
  if (cfg?.provider) mc.provider = cfg.provider;
  const model = envModel || cfg?.model;
  if (model) mc.model = model;
  if (thinking) mc.thinking = thinking;
  return mc;
}

/** "anthropic · claude-x · high" — unset parts dropped, model falls back to "default model". */
export function modelConfigLabel(mc: Partial<ModelConfig>): string {
  return [mc.provider, mc.model ?? "default model", mc.thinking ?? ""].filter(Boolean).join(" · ");
}

/**
 * pi flags for a role: env (KANBAN_AUTOREVIEW_MODEL / KANBAN_AUTOREVIEW_THINKING)
 * beats the board config, which beats the built-in default (reviewer thinks max;
 * setting the thinking env var to "" disables thinking entirely). Configured
 * skills are activated by injecting their SKILL.md into the appended system
 * prompt (skillActivationPrompt); warnings from that go to onWarn.
 */
export function agentFlags(role: AgentRole, cfg: AgentConfig | null, onWarn?: (message: string) => void): string[] {
  const mc = resolvedModelConfig(role, cfg);
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

/** "8s" / "59s" / "1 min" / "20 min" */
export function durationFor(secs: number): string {
  return secs < 60 ? `${secs}s` : `${Math.round(secs / 60)} min`;
}

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
}

/** The one spawn implementation: kill/timeout/stall timers, JSONL streaming, stderr tail. */
export function spawnPi(input: SpawnPiInput): Promise<SpawnResult> {
  const { cwd, sessionId, prompt, args, timeoutMs, stallMs, log, emit, track } = input;
  const proc = Bun.spawn({
    // json mode streams JSONL events while the session runs (--print waits for the end)
    cmd: ["pi", "--mode", "json", "--session-id", sessionId, ...args, prompt],
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const untrack = track(() => proc.kill());
  const stderr = new Response(proc.stderr).text();
  let timedOut = false;
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = () => {
    clearTimeout(timer);
    if (stallTimer) clearTimeout(stallTimer);
  };

  const timer = setTimeout(() => {
    timedOut = true;
    if (stallTimer) clearTimeout(stallTimer);
    proc.kill();
  }, timeoutMs);
  timer.unref?.();

  const resetStallTimer = () => {
    if (timedOut || stalled) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      clearTimeout(timer);
      proc.kill();
    }, stallMs);
    stallTimer.unref?.();
  };

  resetStallTimer();

  // stream events as they arrive: manual LF split (readline mis-splits unicode)
  void (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          resetStallTimer();
        }
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = formatPiEvent(buf.slice(0, nl));
          if (line) emit(line);
          buf = buf.slice(nl + 1);
        }
      }
    } catch {
      // stream torn down (timeout kill / early exit) — exit handling below covers it
    }
  })();

  return proc.exited.finally(untrack).then(async (code) => {
    clearTimers();
    const tail = (await stderr).trim();
    if (stalled) log(`stalled — no output for ${durationFor(stallMs / 1000)}, killed`);
    else if (timedOut) log(`timed out after ${Math.round(timeoutMs / 60_000)} min, killed`);
    else if (code !== 0) {
      if (tail) log(`exited ${code}, stderr tail:\n${tail.slice(-1500)}`);
    }
    return {
      code: (timedOut || stalled) ? 1 : (code ?? 1),
      stalled: stalled || undefined,
      stalledAfterMs: stalled ? stallMs : undefined,
      timedOut: timedOut || undefined,
      stderrTail: tail ? tail.slice(-1500) : undefined,
    };
  });
}

export const defaultSpawn: SpawnFn = (job, { cwd, timeoutMs, stallMs, config, log, emit, track }) =>
  // the loop's log lines stay job-prefixed ("reviewer <id>: stalled — …"); spawnPi logs bare
  spawnPi({
    cwd,
    sessionId: job.sessionId ?? sessionIdFor(job),
    prompt: job.prompt,
    args: agentFlags(job.role, config, log),
    timeoutMs,
    stallMs,
    log: (message) => log(`${job.role} ${job.task.id}: ${message}`),
    emit,
    track,
  });

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
  const gate = opts.gate !== undefined ? opts.gate : process.env.KANBAN_AUTOREVIEW_GATE === "0" ? null : defaultGate;
  const gateTimeoutMs = opts.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;

  const queue: Array<AgentJob & { enqueuedAt: number }> = [];
  const inFlight = new Set<string>();
  const sessions = new Map<string, AgentSessionInfo>();
  const provide = (): ActivityReport => ({
    sessions: [...sessions.values()],
    queued: queue.map(({ task, role, enqueuedAt }) => ({ taskId: task.id, role, enqueuedAt })),
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
    key: string;
    slot?: PoolSlot;
    pool?: WorkerPool;
    slotIndex?: number;
  }

  function freeSlotFor(role: AgentRole): AllocatedSlot | null {
    const pools = db.pools();
    // pools serve built-in loop roles only; a custom lane actor always takes the default slot
    const covering = pools.filter((p) => p.enabled && p.roles.includes(role as BuiltinAgentRole));
    if (covering.length > 0) {
      for (const pool of covering) {
        const cap = pool.maxWorkers ?? pool.slots.length;
        for (let i = 0; i < cap; i++) {
          const key = `${pool.id}:${i}`;
          if (!busySlots.has(key)) {
            return { key, slot: pool.slots[i], pool, slotIndex: i };
          }
        }
      }
      return null;
    }
    const key = "::default:0";
    if (!busySlots.has(key)) {
      return { key, slot: undefined, pool: undefined };
    }
    return null;
  }

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
      enqueue({
        task,
        role: actor.id,
        laneId: task.laneId,
        mode: ev.mode,
        prompt: renderActorPrompt(task, task.laneId, context, actor, ev.mode),
      });
    }
    void drain();
  }

  async function runJob(job: AgentJob, allocated: AllocatedSlot): Promise<void> {
    const { slot, pool, slotIndex, key: slotKey } = allocated;
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
          log(`${job.role} ${job.task.id}: running pre-spawn test gate`);
          let res: GateResult;
          try {
            res = await gate(cwd, gateTimeoutMs);
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
              body: `pre-review gate: \`bun test\` failed — no reviewer session spawned.\n\n\`\`\`\n${res.output}\n\`\`\`\nFix the tests, then comment on this card to re-trigger review.`,
            });
            log(`${job.role} ${job.task.id}: gate red — no session spawned`);
            return; // the question parks the card in waiting — the lane change disarms it (roleFor ignores waiting)
          }
        }
      }
      if (!db.tryTakeLease(job.task.id, job.role, owner, LEASE_TTL_MS)) {
        log(`${job.role} ${job.task.id}: lease held by another server — skipping`);
        return;
      }
      inFlight.add(job.task.id);
      job.sessionId ??= sessionIdFor(job);
      db.setCardSession(job.task.id, job.role, job.sessionId);
      if (job.mode === "resume") {
        db.createComment(job.task.id, {
          author: "kanban",
          kind: "comment",
          body: `${KanbanDb.SESSION_RESUMED_PREFIX}continuing ${authorForRole(job.role)} session ${job.sessionId} — the transcript picks up where it died.`,
        });
      }
      const roleConfig = db.agentConfig(job.role); // fresh per spawn: web edits apply to the next session
      const config = mergeSlotConfig(roleConfig, slot);
      const mc = resolvedModelConfig(job.role, config);
      const label = modelConfigLabel(mc);
      const skills = config?.skills?.length ? `${config.skills.length} skill${config.skills.length === 1 ? "" : "s"}` : "";
      const via = pool ? `via pool ${pool.name} slot ${slotIndex}` : "via default slot";
      log(`${job.role} start ${job.task.id} "${job.task.title}" (${[label, skills].filter(Boolean).join(" · ")}) ${via}`);
      const session: AgentSessionInfo = {
        taskId: job.task.id,
        role: job.role,
        startedAt: Date.now(),
        log: [],
        modelLabel: label,
        ...(mc.model ? { model: mc.model } : {}),
        ...(pool ? { pool: pool.name } : {}),
      };
      // stop() must be able to silence the heartbeat even when the spawn
      // promise never settles (a stuck/fake child) — otherwise the 15s tick
      // lands on a closed db long after the test (or server) tore down
      const beat = setInterval(() => db.heartbeatLease(job.task.id, owner), LEASE_HEARTBEAT_MS);
      const stopBeat = track(() => clearInterval(beat));
      sessions.set(job.task.id, session);
      const emit = (line: string): void => {
        session.log.push(line);
        if (session.log.length > MAX_LOG_LINES) session.log.shift();
        log(`${job.role} ${job.task.id} │ ${line}`);
      };
      emit(`model: ${label}`);
      const jobKills = new Set<() => void>();
      const jobTrack = (kill: () => void): (() => void) => {
        const untrack = track(kill);
        jobKills.add(untrack);
        return () => {
          jobKills.delete(untrack);
          untrack();
        };
      };
      let result: SpawnResult = { code: 1 };
      try {
        result = await spawnFn(job, { cwd, timeoutMs: config?.timeoutMs ?? timeoutMs, stallMs, config, log, emit, track: jobTrack });
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
            db.attach(job.task.id, "session", `${header}\n${session.log.join("\n")}`, "autoreview");
          } catch (err) {
            log(`${job.role} ${job.task.id}: could not save the session log (${(err as Error).message})`);
          }
        }
        sessions.delete(job.task.id);
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
          afterJob(job, result, session);
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

        const allocated = freeSlotFor(job.role);
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
  function afterJob(job: AgentJob, result: SpawnResult, session: AgentSessionInfo): void {
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
      // deathHint carries its own separator (the seeded voices differ: " — " vs "; ")
      const tail =
        actor?.deathHint ??
        (job.mode === "plan"
          ? " — plan not built, needs a human. comment on this card to re-trigger."
          : " — findings unaddressed, needs a human. comment on this card to re-trigger.");
      db.createComment(task.id, {
        author,
        kind: "comment",
        body: `${KanbanDb.SESSION_DIED_PREFIX}${actor?.deathLabel ?? job.role} ${reason}${tail}`,
      });
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
