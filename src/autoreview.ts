import { homedir } from "node:os";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { KanbanDb, PLAN_REVIEWER_AUTHOR, type AgentConfig, type AgentRole, type LeaseOwner, type PoolSlot, type Task, type WorkerPool } from "./db";

export type { AgentRole };
export { PLAN_REVIEWER_AUTHOR };

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
export const BUILDER_AUTHOR = "pi-builder";

export const AUTHOR_BY_ROLE: Record<AgentRole, string> = {
  planner: PLANNER_AUTHOR,
  reviewer: REVIEWER_AUTHOR,
  builder: BUILDER_AUTHOR,
  "plan-reviewer": PLAN_REVIEWER_AUTHOR,
};

export interface AgentJob {
  task: Task;
  role: AgentRole;
  prompt: string;
  /** Builder jobs come in two flavors: working review findings or building an approved plan. */
  mode?: "findings" | "plan" | "resume";
  sessionId?: string;
}

export interface SpawnContext {
  cwd: string;
  timeoutMs: number;
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
  /** Trailing stderr text if the child wrote any — the diagnostic tail, ≤1500 chars. */
  stderrTail?: string;
}

export type SpawnFn = (job: AgentJob, ctx: SpawnContext) => Promise<SpawnResult>;

export interface AutoReviewOptions {
  db: KanbanDb;
  cwd: string;
  spawnFn?: SpawnFn;
  timeoutMs?: number;
  maxBlocks?: number;
  /** Plan-review blocks allowed since the last human comment before the card goes to the human (default 2). */
  maxPlanBlocks?: number;
  watchIntervalMs?: number;
  log?: (message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 40 * 60_000;
const DEFAULT_MAX_BLOCKS = 3;
const DEFAULT_MAX_PLAN_BLOCKS = 2;
const MAX_LOG_LINES = 150;

export interface AgentSessionInfo {
  taskId: string;
  role: AgentRole;
  startedAt: number;
  log: string[];
  model?: string;
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
 * The plan contract shared by planner and plan reviewer: required sections plus
 * the review checklist. Read once and embedded in prompts, so agents running in
 * another repo (serve cwd) still get it.
 */
export const PLAN_TEMPLATE = readFileSync(join(import.meta.dir, "..", "skills", "pi-kanban", "plan-template.md"), "utf8");

/** The template's required section headings, in order (a test keeps the file in sync). */
export const PLAN_SECTIONS = [
  "Goal",
  "Context & constraints",
  "Decisions",
  "Interfaces & contracts",
  "Steps",
  "Test plan",
  "Architecture impact",
  "Stack & dependencies",
  "Data & migrations",
  "Security",
  "Performance",
  "Backward compatibility",
  "Observability",
  "Rollback",
  "Out of scope",
  "Risks",
  "Open questions",
] as const;

export function resumePrompt(task: Task, role: AgentRole, reason: string): string {
  const ending: Record<AgentRole, string> = {
    planner: `; then attach the plan file and hand off exactly: kanban attach ${task.id} <plan-file> and kanban comment ${task.id} "plan v<N> attached — over to pi-plan-reviewer" --kind handoff --author pi-planner`,
    "plan-reviewer": `; then record exactly one verdict: kanban plan-review ${task.id} (--pass | --block --message "<summary>" [--finding "<checklist hit>"]…) --author pi-plan-reviewer`,
    reviewer: `; then record exactly one verdict: kanban review ${task.id} (--approve | --block --message "<summary>" [--finding "<file:line — issue>"]…) --author pi-reviewer`,
    builder: `; then hand off: kanban handoff ${task.id} review --message "<what you built · test status>" --author pi-builder`,
  };
  return `You are ${AUTHOR_BY_ROLE[role]}. Your previous session on kanban card ${task.id} "${task.title}" died before finishing (${reason}) — this spawn continues that same session, so your earlier context is intact: pick up where you left off, do not restart from scratch.

1. Re-orient: run kanban brief ${task.id} — the thread may have moved while you were down; check your own progress (git status, git log, the files you touched) before redoing work.
2. Finish what you were doing${ending[role]}
3. Run the full test suite (e.g. bun test) before recording anything if you touched code.
4. Never move the card with mv and never run kanban approve/reject — the human owns the gate.

Your last line: one-sentence progress summary.`;
}

export function plannerPrompt(task: Task, now: number = Date.now()): string {
  return `You are pi-planner. Kanban card ${task.id} "${task.title}" is in the Plan lane in this repo — write its implementation plan. The plan is the builder's contract: two builders following it should produce the same behavior.

1. Run: kanban brief ${task.id} — the note (intent, acceptance criteria), any earlier plan version, and the full thread. If the last comment is a rejection or a plan-review block, its feedback and findings are direction for this revision: address every point in v-next.
2. Ground the plan in the repo: read AGENTS.md, then the files and tests the work touches. Cite real file paths; no invented APIs.
3. Write the plan to a markdown file — use exactly /tmp/plan-${task.id}-${now.toString(36)}.md so concurrent runs never clobber each other — using the plan template below: every section filled or "N/A — reason", every acceptance criterion mapped to concrete tests.
4. Self-check the plan against the review checklist below and fix every hit before attaching.
5. Attach it: kanban attach ${task.id} <plan-file>
6. Hand off with exactly: kanban comment ${task.id} "plan v<N> attached — over to pi-plan-reviewer" --kind handoff --author pi-planner

Never move the card (no mv/handoff) and never run kanban approve/reject — the human owns the gate.
Questions first: after reading the repo, ask only if an answer would genuinely change the plan — post every question with its recommended default as one comment: kanban comment ${task.id} "<Q1…? default: …>" --kind question --author pi-planner, then stop without attaching a plan; the human's answer re-arms you and its "use the defaults" counts as an answer. When the repo can decide, decide and record it under Decisions instead of asking.
Your last line: one sentence on the plan's shape.

--- plan template and review checklist ---
${PLAN_TEMPLATE.trim()}`;
}

export function planReviewerPrompt(task: Task): string {
  return `You are pi-plan-reviewer. Kanban card ${task.id} "${task.title}" has a fresh plan in the Plan lane in this repo — critique it before the human gate. You are the second pair of eyes: assume the planner was convincing but lazy.

1. Run: kanban brief ${task.id} — the note (acceptance criteria), the latest plan, and the full thread (rejections and earlier feedback are context).
2. Check the plan against the review checklist below, and verify its claims: every cited path exists, every named function/API matches the code (read AGENTS.md and the named files), every acceptance criterion maps to a concrete test.

Then record exactly one verdict (never move the card with mv/handoff, never run kanban approve/reject — the human owns the gate):
- Pass: kanban plan-review ${task.id} --pass --message "<1-3 sentences on why it is executable>" --author pi-plan-reviewer
- Block: kanban plan-review ${task.id} --block --message "<summary>" --finding "<checklist hit>" [--finding "<…>" …] --author pi-plan-reviewer

Block only for checklist hits, never taste; up to 2 rounds happen automatically, then a human steps in. If you cannot evaluate the plan at all (files missing, repo unreadable), post kanban comment ${task.id} "cannot evaluate the plan — <why>" --author pi-plan-reviewer and stop.
Never move the card (no mv/handoff) and never run kanban approve/reject — the human owns the gate.
Your last line: a one-sentence verdict.

--- plan template and review checklist ---
${PLAN_TEMPLATE.trim()}`;
}

export function builderPlanPrompt(task: Task): string {
  return `You are pi-builder. Kanban card ${task.id} "${task.title}" had its plan approved; build it in this repo.

1. Run: kanban brief ${task.id} — the note, the approved plan, and the full thread. Follow the plan; older rejections in the thread are already addressed by it.
2. Implement the plan exactly: numbered steps, target files. Test as you go; add or adjust the tests the plan calls for.
3. Run the full test suite (e.g. bun test) — everything green before handoff.
4. Hand off: kanban handoff ${task.id} review --message "<what you built · test status>" --author pi-builder

Never move the card with mv and never run kanban approve/reject. If a plan step turns out wrong, stop and comment instead of improvising: kanban comment ${task.id} "<the problem>" --author pi-builder.
Your last line: one-sentence build summary.`;
}

export function reviewerPrompt(task: Task): string {
  return `You are pi-reviewer, an expert code reviewer. Kanban card ${task.id} "${task.title}" was just handed off to Review in this repo.

1. Run: kanban brief ${task.id} --json — the note, latest plan, and full thread (what the builder claims).
2. Locate the work: the last handoff message says what changed; use git log, git diff, and the files named in the plan.
3. Review like a senior engineer: correctness, edge cases, error handling, tests, adherence to the plan and repo conventions (read AGENTS.md if present).
4. Verify cheaply: run the test suite if it is fast (e.g. bun test).
5. Prove every finding: each --finding must include the failing repro (command + observed output) or quote the exact code path that breaks. A concern you cannot verify is NOT a finding — post it as a comment instead: kanban comment ${task.id} "<concern>" --author pi-reviewer.

Then record exactly one verdict (never move the card with mv):
- Pass: kanban review ${task.id} --approve --message "<1-3 sentence summary>" --author pi-reviewer
- Fail: kanban review ${task.id} --block --message "<summary>" --finding "<file:line — issue>" [--finding "<…>" …] --author pi-reviewer

If you cannot locate the work in this repo, do NOT block — post kanban comment ${task.id} "could not locate the work in this repo — needs manual review" --author pi-reviewer, and stop.
Your last line: a one-sentence verdict.`;
}

export function builderPrompt(task: Task): string {
  return `You are pi-builder. Kanban card ${task.id} "${task.title}" was blocked in review; its note now carries "- [ ]" findings from pi-reviewer.

1. Run: kanban brief ${task.id} — note (with the findings checklist), latest plan, full thread.
2. Fix every finding in this repo; run the tests.
3. Rewrite the note with the findings checked off: kanban edit ${task.id} --note "<full updated note with '- [x]' lines>".
4. Hand the card back: kanban handoff ${task.id} review --message "<what you fixed · test status>" --author pi-builder

Never move the card with mv. If a finding looks wrong, say so in the handoff message instead of silently skipping it.`;
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

/**
 * pi flags for a role: env (KANBAN_AUTOREVIEW_MODEL / KANBAN_AUTOREVIEW_THINKING)
 * beats the board config, which beats the built-in default (reviewer thinks max;
 * setting the thinking env var to "" disables thinking entirely). Configured
 * skills are activated by injecting their SKILL.md into the appended system
 * prompt (skillActivationPrompt); warnings from that go to onWarn.
 */
export function agentFlags(role: AgentRole, cfg: AgentConfig | null, onWarn?: (message: string) => void): string[] {
  const envModel = process.env.KANBAN_AUTOREVIEW_MODEL?.trim();
  const envThinking = process.env.KANBAN_AUTOREVIEW_THINKING;
  let thinking =
    envThinking?.trim() || cfg?.thinking || (role === "reviewer" || role === "planner" || role === "plan-reviewer" ? "max" : "");
  if (envThinking === "") thinking = ""; // explicitly disabled via env
  const args: string[] = [];
  if (cfg?.provider) args.push("--provider", cfg.provider);
  const model = envModel || cfg?.model;
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
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

const defaultSpawn: SpawnFn = (job, { cwd, timeoutMs, config, log, emit, track }) => {
  const proc = Bun.spawn({
    // json mode streams JSONL events while the session runs (--print waits for the end)
    cmd: ["pi", "--mode", "json", "--session-id", job.sessionId ?? sessionIdFor(job), ...agentFlags(job.role, config, log), job.prompt],
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const untrack = track(() => proc.kill());
  const stderr = new Response(proc.stderr).text();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  timer.unref?.();

  // stream events as they arrive: manual LF split (readline mis-splits unicode)
  void (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
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
    clearTimeout(timer);
    const tail = (await stderr).trim();
    if (timedOut) log(`${job.role} ${job.task.id}: timed out after ${Math.round(timeoutMs / 60_000)} min, killed`);
    else if (code !== 0) {
      if (tail) log(`${job.role} ${job.task.id}: exited ${code}, stderr tail:\n${tail.slice(-1500)}`);
    }
    return {
      code: timedOut ? 1 : (code ?? 1),
      timedOut: timedOut || undefined,
      stderrTail: tail ? tail.slice(-1500) : undefined,
    };
  });
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
  const maxBlocks = opts.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const maxPlanBlocks = opts.maxPlanBlocks ?? DEFAULT_MAX_PLAN_BLOCKS;
  const maxParallel = Math.min(8, Math.max(1, parseInt(process.env.KANBAN_AUTOREVIEW_MAX_PARALLEL ?? "", 10) || 1));

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
    const covering = pools.filter((p) => p.enabled && p.roles.includes(role));
    if (covering.length > 0) {
      for (const pool of covering) {
        for (let i = 0; i < pool.slots.length; i++) {
          const key = `${pool.id}:${i}`;
          if (!busySlots.has(key)) {
            return { key, slot: pool.slots[i], pool, slotIndex: i };
          }
        }
      }
      return null;
    }
    for (let i = 0; i < maxParallel; i++) {
      const key = `::default:${i}`;
      if (!busySlots.has(key)) {
        return { key, slot: undefined, pool: undefined };
      }
    }
    return null;
  }

  /** What the card needs right now: a planner, a plan reviewer, a reviewer, a builder (two flavors), or nothing. */
  const roleFor = (task: Task): AgentRole | "capped" | "plan-capped" | null => {
    const thread = db.comments(task.id);
    const last = thread.at(-1);
    if (task.laneId === "plan") {
      if (last?.author === PLANNER_AUTHOR) return last.kind === "handoff" ? "plan-reviewer" : null;
      if (last?.author === PLAN_REVIEWER_AUTHOR) {
        const blocked = last.kind === "review" && last.body.startsWith(KanbanDb.PLAN_REVIEW_BLOCK);
        if (!blocked) return null; // pass, question, failure or cap comment — waiting on a human
        // blocks since the last human (non-agent) comment: their reply resets the budget
        let humanAt = -1;
        for (let i = thread.length - 1; i >= 0; i--) {
          if (!thread[i]!.author.startsWith("pi-")) {
            humanAt = i;
            break;
          }
        }
        const blocks = thread.slice(humanAt + 1).filter(
          (c) => c.author === PLAN_REVIEWER_AUTHOR && c.kind === "review" && c.body.startsWith(KanbanDb.PLAN_REVIEW_BLOCK),
        ).length;
        return blocks < maxPlanBlocks ? "planner" : "plan-capped";
      }
      // last is a human comment, a rejection, or the thread is empty — route by
      // *why* the card is waiting, not just by last author: scan back to the
      // most recent agent comment (a newer human rejection outranks it). A
      // non-verdict plan-reviewer comment (session failed, cannot-evaluate, or
      // cap) means the plan itself never failed, so the human comment re-runs
      // the reviewer on the attached plan as-is; anything else re-arms the planner.
      let decidedBy: (typeof thread)[number] | null = null;
      for (let i = thread.length - 1; i >= 0; i--) {
        const c = thread[i]!;
        if (c.kind === "rejection" || c.author.startsWith("pi-")) {
          decidedBy = c;
          break;
        }
      }
      if (decidedBy?.author === PLAN_REVIEWER_AUTHOR && decidedBy.kind === "comment") return "plan-reviewer";
      // a plan attached after that deciding event was authored outside the
      // loop (a chat session attaching it at the human's direction): it is
      // fresh and unreviewed — review it, don't re-plan over it
      const plan = db.attachment(task.id, "plan");
      if (plan && plan.createdAt > (decidedBy?.createdAt ?? 0)) return "plan-reviewer";
      return "planner"; // fresh card, or only human comments so far
    }
    if (task.laneId === "review" && last?.author !== REVIEWER_AUTHOR) return "reviewer";
    if (task.laneId === "implement") {
      if (last?.author === BUILDER_AUTHOR) return null; // builder died or left a comment — disarmed
      if (last?.kind === "review" && last?.author === REVIEWER_AUTHOR) {
        const blocks = thread.filter((c) => c.kind === "review" && c.author === REVIEWER_AUTHOR).length;
        return blocks < maxBlocks ? "builder" : "capped";
      }
      // a human approval or human comment re-arms the builder
      if (last && !last.author.startsWith("pi-")) return "builder";
    }
    return null;
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
      const prompt = resumePrompt(task, session.role, reason);
      const job: AgentJob = {
        task,
        role: session.role,
        sessionId: session.sessionId,
        prompt,
        mode: "resume",
      };
      db.clearResumeRequest(task.id);
      enqueue(job);
    }
    const lanes = new Set(db.lanes().map((l) => l.id));
    if (!lanes.has("review") || !lanes.has("implement")) return;
    for (const task of db.tasks()) {
      if (db.leaseFor(task.id, LEASE_TTL_MS)) continue; // another process (or our own session) works this card
      const role = roleFor(task);
      if (role === "planner") enqueue({ task, role, prompt: plannerPrompt(task) });
      else if (role === "plan-reviewer") enqueue({ task, role, prompt: planReviewerPrompt(task) });
      else if (role === "reviewer") enqueue({ task, role, prompt: reviewerPrompt(task) });
      else if (role === "builder") {
        const thread = db.comments(task.id);
        let isPlan = false;
        for (let i = thread.length - 1; i >= 0; i--) {
          const c = thread[i]!;
          if (c.kind === "approval" && !c.author.startsWith("pi-")) {
            isPlan = true;
            break;
          }
          if (c.kind === "review" && c.author === REVIEWER_AUTHOR) {
            isPlan = false;
            break;
          }
        }
        enqueue({ task, role, mode: isPlan ? "plan" : "findings", prompt: isPlan ? builderPlanPrompt(task) : builderPrompt(task) });
      } else if (role === "capped") {
        // posting flips the last comment away from the verdict, so this fires once
        db.createComment(task.id, {
          author: REVIEWER_AUTHOR,
          kind: "comment",
          body: `auto-review stopped: block cycles reached the cap of ${maxBlocks} — needs a human. Findings are on the note.`,
        });
        log(`cap reached on ${task.id} — leaving it for a human`);
      } else if (role === "plan-capped") {
        // same one-shot disarm: the comment flips the last author, so this fires once
        db.createComment(task.id, {
          author: PLAN_REVIEWER_AUTHOR,
          kind: "comment",
          body: `${KanbanDb.PLAN_REVIEW_CAP}: blocked ${maxPlanBlocks}× since the last human comment — the latest plan waits at the gate with open findings. kanban reject ${task.id} --message <feedback> to re-plan, or comment to re-run the review.`,
        });
        log(`plan-review cap reached on ${task.id} — leaving it for a human`);
      }
    }
    void drain();
  }

  async function runJob(job: AgentJob, allocated: AllocatedSlot): Promise<void> {
    const { slot, pool, slotIndex, key: slotKey } = allocated;
    try {
      const fresh = db.tasks().find((t) => t.id === job.task.id);
      if (!fresh) return;
      if (job.mode === "resume") {
        if (db.waiting(job.task.id) !== "dead") return;
      } else {
        if (roleFor(fresh) !== job.role) return; // state moved on while queued
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
          body: `${KanbanDb.SESSION_RESUMED_PREFIX}continuing ${AUTHOR_BY_ROLE[job.role]} session ${job.sessionId} — the transcript picks up where it died.`,
        });
      }
      const roleConfig = db.agentConfig(job.role); // fresh per spawn: web edits apply to the next session
      const config = mergeSlotConfig(roleConfig, slot);
      const flags = agentFlags(job.role, config);
      const model = flags.includes("--model") ? flags[flags.indexOf("--model") + 1] : "default model";
      const thinking = flags.includes("--thinking") ? `thinking ${flags[flags.indexOf("--thinking") + 1]}` : "";
      const skills = config?.skills?.length ? `${config.skills.length} skill${config.skills.length === 1 ? "" : "s"}` : "";
      const via = pool ? `via pool ${pool.name} slot ${slotIndex}` : "via default slot";
      log(`${job.role} start ${job.task.id} "${job.task.title}" (${[model, thinking, skills].filter(Boolean).join(" · ")}) ${via}`);
      const modelIndex = flags.indexOf("--model");
      const resolvedModel = modelIndex !== -1 ? flags[modelIndex + 1] : undefined;
      const session: AgentSessionInfo = {
        taskId: job.task.id,
        role: job.role,
        startedAt: Date.now(),
        log: [],
        ...(resolvedModel ? { model: resolvedModel } : {}),
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
        result = await spawnFn(job, { cwd: opts.cwd, timeoutMs: config?.timeoutMs ?? timeoutMs, config, log, emit, track: jobTrack });
        if (result.timedOut) emit("timed out — killed");
        if (result.stderrTail) emit(`stderr tail:\n${result.stderrTail}`);
      } catch (err) {
        log(`${job.role} ${job.task.id}: spawn error ${(err as Error).message}`);
        result = { code: 1, stderrTail: `spawn error: ${(err as Error).message}` };
        if (result.timedOut) emit("timed out — killed");
        if (result.stderrTail) emit(`stderr tail:\n${result.stderrTail}`);
      } finally {
        for (const untrack of jobKills) untrack();
        jobKills.clear();
        // keep the transcript on the card — the live view evaporates when the session ends
        if (!stopped && session.log.length > 0) {
          const secs = Math.max(1, Math.round((Date.now() - session.startedAt) / 1000));
          const header = `${AUTHOR_BY_ROLE[job.role]} · ${new Date(session.startedAt).toLocaleString()} · ${secs}s`;
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
        } else {
          if (roleFor(fresh) !== job.role) continue;
        }
        if (db.leaseFor(job.task.id, LEASE_TTL_MS)) continue;

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
  function afterJob(job: AgentJob, result: SpawnResult, session: AgentSessionInfo): void {
    const task = db.tasks().find((t) => t.id === job.task.id);
    if (!task) return;
    const last = db.comments(task.id).at(-1);
    const secs = Math.max(1, Math.round((Date.now() - session.startedAt) / 1000));
    const reason = deathReason(result, secs, session.log);
    if (job.role === "planner") {
      if (last?.author === PLANNER_AUTHOR) log(`planner ${task.id}: plan attached — over to plan review`);
      else {
        db.createComment(task.id, {
          author: PLANNER_AUTHOR,
          kind: "comment",
          body: `${KanbanDb.SESSION_DIED_PREFIX}auto-plan ${reason} — comment on this card to re-trigger.`,
        });
      }
    } else if (job.role === "plan-reviewer") {
      if (last?.author === PLAN_REVIEWER_AUTHOR) log(`plan-reviewer ${task.id}: verdict recorded — waiting on the gate`);
      else {
        db.createComment(task.id, {
          author: PLAN_REVIEWER_AUTHOR,
          kind: "comment",
          body: `${KanbanDb.SESSION_DIED_PREFIX}plan review ${reason} — approve or reject the plan directly, or comment on this card to re-run the review.`,
        });
      }
    } else if (job.role === "reviewer") {
      if (task.laneId === "done") log(`reviewer ${task.id}: approved → done`);
      else if (task.laneId === "implement") log(`reviewer ${task.id}: blocked → implement`);
      else if (last?.author === REVIEWER_AUTHOR) log(`reviewer ${task.id}: left a comment, no verdict`);
      else {
        db.createComment(task.id, {
          author: REVIEWER_AUTHOR,
          kind: "comment",
          body: `${KanbanDb.SESSION_DIED_PREFIX}auto-review ${reason}; comment on this card to re-trigger.`,
        });
      }
    } else {
      const desc = job.mode === "plan" ? "built the plan → review" : "fixed → back to review";
      const prefix = job.mode === "resume" ? `resumed builder ${task.id}` : `builder ${task.id}`;
      if (task.laneId === "review") log(`${prefix}: ${desc}`);
      else if (last?.author === BUILDER_AUTHOR) log(`builder ${task.id}: left a comment, no handoff`);
      else {
        db.createComment(task.id, {
          author: BUILDER_AUTHOR,
          kind: "comment",
          body: `${KanbanDb.SESSION_DIED_PREFIX}auto-builder ${reason} — findings unaddressed, needs a human.`,
        });
      }
    }
  }

  const stopWatch = db.watch(() => scan(), opts.watchIntervalMs ?? 300);
  log(`enabled — agents run in ${opts.cwd}, timeout ${Math.round(timeoutMs / 60_000)} min, block cap ${maxBlocks}${maxParallel > 1 ? `, up to ${maxParallel} parallel` : ""}`);
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
            author: AUTHOR_BY_ROLE[session.role],
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
