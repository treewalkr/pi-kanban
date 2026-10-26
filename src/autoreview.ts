import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KanbanDb, type AgentConfig, type AgentRole, type LeaseOwner, type Task } from "./db";

export type { AgentRole };

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
export const PLAN_REVIEWER_AUTHOR = "pi-plan-reviewer";

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
  mode?: "findings" | "plan";
}

export interface SpawnContext {
  cwd: string;
  timeoutMs: number;
  config: AgentConfig | null;
  log: (message: string) => void;
  /** Streams one formatted output line from the running session. */
  emit: (line: string) => void;
  /** Registers the child's kill handle so shutdown can terminate in-flight sessions. */
  track: (kill: () => void) => void;
}

/** Runs one agent session; resolves with the child's exit code (non-zero = failure). */
export type SpawnFn = (job: AgentJob, ctx: SpawnContext) => Promise<number>;

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

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_MAX_BLOCKS = 3;
const DEFAULT_MAX_PLAN_BLOCKS = 2;
const MAX_LOG_LINES = 150;

export interface AgentSessionInfo {
  taskId: string;
  role: AgentRole;
  startedAt: number;
  log: string[];
}

const activityProviders = new Set<() => AgentSessionInfo[]>();

/** In-flight agent sessions across all autoreview instances, for the /activity endpoint. */
export function activitySnapshot(): AgentSessionInfo[] {
  return [...activityProviders].flatMap((provide) => provide());
}

/**
 * One pi JSONL event (`--mode json`) → one short log line, or null for noise
 * (usage churn, text deltas). Unknown events are dropped, not errors.
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
    case "compaction_start":
      return `compacting (${ev.reason})`;
    case "agent_settled":
      return "settled";
    default:
      return null;
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

/**
 * pi flags for a role: env (KANBAN_AUTOREVIEW_MODEL / KANBAN_AUTOREVIEW_THINKING)
 * beats the board config, which beats the built-in default (reviewer thinks max;
 * setting the thinking env var to "" disables thinking entirely).
 */
export function agentFlags(role: AgentRole, cfg: AgentConfig | null): string[] {
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
  if (cfg?.context) args.push("--append-system-prompt", cfg.context);
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

const defaultSpawn: SpawnFn = (job, { cwd, timeoutMs, config, log, emit, track }) => {
  const proc = Bun.spawn({
    // json mode streams JSONL events while the session runs (--print waits for the end)
    cmd: ["pi", "--mode", "json", "--session-id", sessionIdFor(job), ...agentFlags(job.role, config), job.prompt],
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  track(() => proc.kill());
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

  return proc.exited.then(async (code) => {
    clearTimeout(timer);
    if (timedOut) log(`${job.role} ${job.task.id}: timed out after ${Math.round(timeoutMs / 60_000)} min, killed`);
    else if (code !== 0) {
      const tail = (await stderr).trim();
      if (tail) log(`${job.role} ${job.task.id}: exited ${code}, stderr tail:\n${tail.slice(-1500)}`);
    }
    return timedOut ? 1 : (code ?? 1);
  });
};

export function startAutoReview(opts: AutoReviewOptions): { stop(): void } {
  const db = opts.db;
  const log = opts.log ?? (() => {});
  const spawnFn = opts.spawnFn ?? defaultSpawn;

  // ---------- cross-process session leases ----------
  // One agent per card across every server: the lease is taken before spawn,
  // heartbeated while the session runs, released on finish/shutdown. A lease
  // whose heartbeat went stale (owner killed hard) is reclaimable.
  const owner: LeaseOwner = { pid: process.pid, bootId: Date.now() };
  const LEASE_TTL_MS = 60_000;
  const LEASE_HEARTBEAT_MS = 15_000;
  const kills = new Set<() => void>();
  const track = (kill: () => void): void => {
    kills.add(kill);
  };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBlocks = opts.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const maxPlanBlocks = opts.maxPlanBlocks ?? DEFAULT_MAX_PLAN_BLOCKS;

  const queue: AgentJob[] = [];
  const inFlight = new Set<string>();
  const sessions = new Map<string, AgentSessionInfo>();
  const provide = (): AgentSessionInfo[] => [...sessions.values()];
  activityProviders.add(provide);
  let draining = false;
  let stopped = false;

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
      for (let i = thread.length - 1; i >= 0; i--) {
        const c = thread[i]!;
        if (c.kind === "rejection") return "planner"; // explicit human intent: re-plan with the feedback
        if (c.author.startsWith("pi-")) return c.author === PLAN_REVIEWER_AUTHOR && c.kind === "comment" ? "plan-reviewer" : "planner";
      }
      return "planner"; // fresh card, or only human comments so far
    }
    if (task.laneId === "review" && last?.author !== REVIEWER_AUTHOR) return "reviewer";
    if (task.laneId === "implement") {
      if (last?.kind === "review" && last?.author === REVIEWER_AUTHOR) {
        const blocks = thread.filter((c) => c.kind === "review" && c.author === REVIEWER_AUTHOR).length;
        return blocks < maxBlocks ? "builder" : "capped";
      }
      // a human approval (never agent-authored) arms the plan-build builder
      if (last?.kind === "approval" && !last.author.startsWith("pi-")) return "builder";
    }
    return null;
  };

  const enqueue = (job: AgentJob): void => {
    if (stopped || inFlight.has(job.task.id) || queue.some((j) => j.task.id === job.task.id)) return;
    queue.push(job);
  };

  function scan(): void {
    if (stopped) return;
    const lanes = new Set(db.lanes().map((l) => l.id));
    if (!lanes.has("review") || !lanes.has("implement")) return;
    for (const task of db.tasks()) {
      if (db.leaseFor(task.id, LEASE_TTL_MS)) continue; // another process (or our own session) works this card
      const role = roleFor(task);
      if (role === "planner") enqueue({ task, role, prompt: plannerPrompt(task) });
      else if (role === "plan-reviewer") enqueue({ task, role, prompt: planReviewerPrompt(task) });
      else if (role === "reviewer") enqueue({ task, role, prompt: reviewerPrompt(task) });
      else if (role === "builder") {
        const plan = db.comments(task.id).at(-1)?.kind === "approval";
        enqueue({ task, role, mode: plan ? "plan" : "findings", prompt: plan ? builderPlanPrompt(task) : builderPrompt(task) });
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
          body: `plan review cap reached: blocked ${maxPlanBlocks}× since the last human comment — the latest plan waits at the gate with open findings. kanban reject ${task.id} --message <feedback> to re-plan, or comment to re-run the review.`,
        });
        log(`plan-review cap reached on ${task.id} — leaving it for a human`);
      }
    }
    void drain();
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (!stopped && queue.length > 0) {
        const job = queue.shift()!;
        const fresh = db.tasks().find((t) => t.id === job.task.id);
        if (!fresh || roleFor(fresh) !== job.role) continue; // state moved on while queued
        if (!db.tryTakeLease(job.task.id, job.role, owner, LEASE_TTL_MS)) {
          log(`${job.role} ${job.task.id}: lease held by another server — skipping`);
          continue;
        }
        inFlight.add(job.task.id);
        const config = db.agentConfig(job.role); // fresh per spawn: web edits apply to the next session
        const flags = agentFlags(job.role, config);
        const model = flags.includes("--model") ? flags[flags.indexOf("--model") + 1] : "default model";
        const thinking = flags.includes("--thinking") ? `thinking ${flags[flags.indexOf("--thinking") + 1]}` : "";
        const skills = config?.skills?.length ? `${config.skills.length} skill${config.skills.length === 1 ? "" : "s"}` : "";
        log(`${job.role} start ${job.task.id} "${job.task.title}" (${[model, thinking, skills].filter(Boolean).join(" · ")})`);
        const session: AgentSessionInfo = { taskId: job.task.id, role: job.role, startedAt: Date.now(), log: [] };
        const beat = setInterval(() => db.heartbeatLease(job.task.id, owner), LEASE_HEARTBEAT_MS);
        sessions.set(job.task.id, session);
        const emit = (line: string): void => {
          session.log.push(line);
          if (session.log.length > MAX_LOG_LINES) session.log.shift();
          log(`${job.role} ${job.task.id} │ ${line}`);
        };
        let code = 0;
        try {
          code = await spawnFn(job, { cwd: opts.cwd, timeoutMs: config?.timeoutMs ?? timeoutMs, config, log, emit, track });
        } catch (err) {
          log(`${job.role} ${job.task.id}: spawn error ${(err as Error).message}`);
          code = 1;
        } finally {
          // keep the transcript on the card — the live view evaporates when the session ends
          if (session.log.length > 0) {
            const secs = Math.max(1, Math.round((Date.now() - session.startedAt) / 1000));
            const header = `${AUTHOR_BY_ROLE[job.role]} · ${new Date(session.startedAt).toLocaleString()} · ${secs}s`;
            try {
              db.attach(job.task.id, "session", `${header}\n${session.log.join("\n")}`, "autoreview");
            } catch (err) {
              log(`${job.role} ${job.task.id}: could not save the session log (${(err as Error).message})`);
            }
          }
          sessions.delete(job.task.id);
          clearInterval(beat);
          db.releaseLease(job.task.id, owner);
        }
        inFlight.delete(job.task.id);
        try {
          afterJob(job, code);
        } catch (err) {
          log(`${job.role} ${job.task.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
        scan(); // follow the verdict: block → builder, handoff → reviewer
      }
    } finally {
      draining = false;
    }
  }

  /** Log the outcome; if the session died without leaving a trace, say so on the card. */
  function afterJob(job: AgentJob, code: number): void {
    const task = db.tasks().find((t) => t.id === job.task.id);
    if (!task) return;
    const last = db.comments(task.id).at(-1);
    if (job.role === "planner") {
      if (last?.author === PLANNER_AUTHOR) log(`planner ${task.id}: plan attached — over to plan review`);
      else {
        db.createComment(task.id, {
          author: PLANNER_AUTHOR,
          kind: "comment",
          body: `auto-plan ${code !== 0 ? `failed (exit ${code})` : "ended without attaching a plan"} — comment on this card to re-trigger.`,
        });
      }
    } else if (job.role === "plan-reviewer") {
      if (last?.author === PLAN_REVIEWER_AUTHOR) log(`plan-reviewer ${task.id}: verdict recorded — waiting on the gate`);
      else {
        db.createComment(task.id, {
          author: PLAN_REVIEWER_AUTHOR,
          kind: "comment",
          body: `plan review ${code !== 0 ? `failed (exit ${code})` : "ended without a verdict"} — approve or reject the plan directly, or comment on this card to re-run the review.`,
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
          body: `auto-review ${code !== 0 ? `failed (exit ${code})` : "ended without a verdict"} — comment on this card to re-trigger.`,
        });
      }
    } else {
      if (task.laneId === "review") log(`builder ${task.id}: ${job.mode === "plan" ? "built the plan → review" : "fixed → back to review"}`);
      else if (last?.author === BUILDER_AUTHOR) log(`builder ${task.id}: left a comment, no handoff`);
      else {
        db.createComment(task.id, {
          author: BUILDER_AUTHOR,
          kind: "comment",
          body: `auto-builder ${code !== 0 ? `failed (exit ${code})` : "ended without a handoff"} — findings unaddressed, needs a human.`,
        });
      }
    }
  }

  const stopWatch = db.watch(() => scan(), opts.watchIntervalMs ?? 300);
  log(`enabled — agents run in ${opts.cwd}, timeout ${Math.round(timeoutMs / 60_000)} min, block cap ${maxBlocks}`);
  scan(); // cards already waiting get picked up right away

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      stopWatch();
      activityProviders.delete(provide);
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
