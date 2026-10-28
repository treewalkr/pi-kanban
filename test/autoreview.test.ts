import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanDb } from "../src/db";
import {
  BUILDER_AUTHOR,
  PLANNER_AUTHOR,
  PLAN_REVIEWER_AUTHOR,
  PLAN_SECTIONS,
  PLAN_TEMPLATE,
  REVIEWER_AUTHOR,
  activitySnapshot,
  agentFlags,
  builderPlanPrompt,
  deathReason,
  durationFor,
  formatPiEvent,
  plannerPrompt,
  planReviewerPrompt,
  reviewerPrompt,
  sessionIdFor,
  startAutoReview,
  type AgentJob,
  type SpawnContext,
  type SpawnFn,
  type SpawnResult,
} from "../src/autoreview";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run with the agent env vars cleared, then set from `env`, restoring after. */
function withAgentEnv(env: Record<string, string>, run: () => void): void {
  const keys = ["KANBAN_AUTOREVIEW_MODEL", "KANBAN_AUTOREVIEW_THINKING"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Records every spawn; the test resolves each one when its "agent" is done. */
function fakeSpawn() {
  const calls: Array<{ job: AgentJob; finish: (result: SpawnResult) => void }> = [];
  const spawnFn: SpawnFn = (job) =>
    new Promise<SpawnResult>((resolve) => calls.push({ job, finish: resolve }));
  return { calls, spawnFn };
}

let dir = "";
let db: KanbanDb | null = null;
let writer: KanbanDb | null = null;
let stop: (() => void) | null = null;

function setup(): { dbFile: string; writer: KanbanDb } {
  dir = mkdtempSync(join(tmpdir(), "kanban-autoreview-"));
  const dbFile = join(dir, "t.db");
  writer = new KanbanDb(dbFile);
  return { dbFile, writer };
}

afterEach(() => {
  stop?.();
  db?.close();
  writer?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  stop = null;
  db = null;
  writer = null;
  dir = "";
});

function start(spawnFn: SpawnFn, dbFile: string) {
  db = new KanbanDb(dbFile);
  const handle = startAutoReview({ db, cwd: dir, spawnFn, watchIntervalMs: 50 });
  stop = () => handle.stop();
  return handle;
}

/** A card in review with a builder handoff as the last comment — the armed state. */
function cardInReview(w: KanbanDb, title = "ship it") {
  const card = w.createTask({ title, lane: "review" });
  w.createComment(card.id, { author: "pi-builder", kind: "handoff", body: "done, please review" });
  return card;
}

describe("auto-review", () => {
  test("reviewer spawns for a card waiting in review", () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("reviewer");
    expect(calls[0].job.task.id).toBe(card.id);
    expect(calls[0].job.prompt).toContain(`kanban brief ${card.id}`);
    expect(calls[0].job.prompt).toContain("--author pi-reviewer");
  });

  test("approve ends the loop: no re-spawn on later board writes", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await w.handoff(card.id, "done", { kind: "review", author: REVIEWER_AUTHOR, message: "approved" });
    calls[0].finish({ code: 0 });
    await sleep(20);
    w.createTask({ title: "noise" }); // unrelated write kicks the watcher
    await sleep(150);
    expect(calls.length).toBe(1);
  });

  test("block spawns the builder; handoff back re-arms the reviewer; approve ends it", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);

    // reviewer blocks: card to implement, findings on the note
    await w.handoff(card.id, "implement", {
      kind: "review",
      author: REVIEWER_AUTHOR,
      message: "found issues",
      findings: ["src/a.ts:1 off by one"],
    });
    calls[0].finish({ code: 0 });
    await sleep(20);
    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("builder");
    expect(calls[1].job.task.id).toBe(card.id);
    expect(calls[1].job.prompt).toContain("pi-builder");

    // builder fixes and hands back to review
    await w.handoff(card.id, "review", { author: BUILDER_AUTHOR, message: "fixed, tests green" });
    calls[1].finish({ code: 0 });
    await sleep(20);
    expect(calls.length).toBe(3);
    expect(calls[2].job.role).toBe("reviewer");

    // second pass approves
    await w.handoff(card.id, "done", { kind: "review", author: REVIEWER_AUTHOR, message: "approved" });
    calls[2].finish({ code: 0 });
    await sleep(20);
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(3);
    expect(db!.tasks().find((t) => t.id === card.id)!.laneId).toBe("done");
  });

  test("three block cycles hit the cap: no builder spawn, cap comment posted once", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    for (let i = 1; i <= 3; i++) {
      await w.handoff(card.id, "implement", {
        kind: "review",
        author: REVIEWER_AUTHOR,
        message: `block ${i}`,
        findings: ["x"],
      });
      if (i < 3) await w.handoff(card.id, "review", { author: BUILDER_AUTHOR, message: "fixed" });
    }
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(0);
    const thread = db!.comments(card.id);
    const last = thread.at(-1)!;
    expect(last.author).toBe(REVIEWER_AUTHOR);
    expect(last.kind).toBe("comment");
    expect(last.body).toContain("cap");
    // the cap comment already disarmed the card — a later write must not repost it
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(db!.comments(card.id).length).toBe(thread.length);
    expect(calls.length).toBe(0);
  });

  test("reviewer crash (non-zero exit) posts a failure comment and does not hot-loop", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    calls[0].finish({ code: 1 });
    await sleep(20);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(REVIEWER_AUTHOR);
    expect(last.body).toContain("failed");
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(1);
  });

  test("reviewer exiting cleanly without a verdict leaves a nudge comment", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    calls[0].finish({ code: 0 });
    await sleep(20);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(REVIEWER_AUTHOR);
    expect(last.body).toContain("without a verdict");
  });

  test("reviewer comment (no verdict) is an acceptable end — no extra failure comment", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const before = w.comments(card.id).length;
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await w.createComment(card.id, {
      author: REVIEWER_AUTHOR,
      kind: "comment",
      body: "could not locate the work in this repo — needs manual review",
    });
    calls[0].finish({ code: 0 });
    await sleep(20);
    expect(db!.comments(card.id).length).toBe(before + 1);
  });

  test("in-flight card is not spawned twice by repeated scans", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await w.createComment(card.id, { author: "pi-builder", body: "still eligible, last author is the builder" });
    await sleep(150);
    expect(calls.length).toBe(1);
  });

  test("two eligible cards are reviewed serially", async () => {
    const { dbFile, writer: w } = setup();
    cardInReview(w, "first");
    cardInReview(w, "second");
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(1);
    const firstId = calls[0].job.task.id;
    await w.handoff(firstId, "done", { kind: "review", author: REVIEWER_AUTHOR, message: "approved" });
    calls[0].finish({ code: 0 });
    await sleep(20);
    expect(calls.length).toBe(2);
    expect(calls[1].job.task.id).not.toBe(firstId);
  });

  test("builder crash posts a failure comment, not another builder spawn", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await w.handoff(card.id, "implement", {
      kind: "review",
      author: REVIEWER_AUTHOR,
      message: "found issues",
      findings: ["x"],
    });
    calls[0].finish({ code: 0 });
    await sleep(20);
    expect(calls.length).toBe(2);
    calls[1].finish({ code: 1 });
    await sleep(20);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(BUILDER_AUTHOR);
    expect(last.body).toContain("failed");
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(2);
  });

  test("prompts embed the card id and the verdict commands", () => {
    const task = { id: "abc12", title: "quotes \"ok\"", laneId: "review" } as never;
    const prompt = reviewerPrompt(task);
    expect(prompt).toContain("abc12");
    expect(prompt).toContain("review abc12 --approve");
    expect(prompt).toContain("review abc12 --block");
    expect(prompt).toContain("--finding");
  });

  test("agentFlags: reviewer defaults to thinking max, builder to nothing", () => {
    withAgentEnv({}, () => {
      expect(agentFlags("reviewer", null)).toEqual(["--thinking", "max"]);
      expect(agentFlags("builder", null)).toEqual([]);
    });
  });

  test("agentFlags: board config maps onto pi flags", () => {
    withAgentEnv({}, () => {
      expect(
        agentFlags("reviewer", {
          provider: "anthropic",
          model: "claude-opus-4-5",
          thinking: "high",
          skills: ["~/.pi/agent/skills/scrutinize"],
          context: "we value perf",
          tools: "-edit",
          extraArgs: ["--no-mcp"],
        }),
      ).toEqual([
        "--provider",
        "anthropic",
        "--model",
        "claude-opus-4-5",
        "--thinking",
        "high",
        "--skill",
        "~/.pi/agent/skills/scrutinize",
        "--append-system-prompt",
        "we value perf",
        "--tools",
        "-edit",
        "--no-mcp",
      ]);
    });
  });

  test("agentFlags: env beats config; empty thinking env disables it", () => {
    withAgentEnv({ KANBAN_AUTOREVIEW_MODEL: "openai/o3", KANBAN_AUTOREVIEW_THINKING: "low" }, () => {
      expect(agentFlags("reviewer", { model: "claude-x", thinking: "max" })).toEqual([
        "--model",
        "openai/o3",
        "--thinking",
        "low",
      ]);
    });
    withAgentEnv({ KANBAN_AUTOREVIEW_MODEL: "openai/o3", KANBAN_AUTOREVIEW_THINKING: "" }, () => {
      expect(agentFlags("reviewer", { thinking: "max" })).toEqual(["--model", "openai/o3"]);
    });
  });

  test("spawn carries the board config: context, skills and timeout reach the session", async () => {
    const { dbFile, writer: w } = setup();
    cardInReview(w);
    w.setAgentConfig("reviewer", {
      model: "claude-opus-4-5",
      skills: ["~/.pi/agent/skills/scrutinize"],
      context: "we value perf over features",
      timeoutMs: 300_000,
    });
    const seen: Array<{ flags: string[]; timeoutMs: number }> = [];
    const spawnFn: SpawnFn = (job, ctx) => {
      seen.push({ flags: agentFlags(job.role, ctx.config), timeoutMs: ctx.timeoutMs });
      return Promise.resolve({ code: 1 }); // session "fails": no verdict, so the loop stops here
    };
    start(spawnFn, dbFile);
    await sleep(20);
    expect(seen[0]!.flags).toContain("--append-system-prompt");
    expect(seen[0]!.flags).toContain("--skill");
    expect(seen[0]!.flags).toContain("claude-opus-4-5");
    expect(seen[0]!.timeoutMs).toBe(300_000);
  });

  test("sessionIdFor: fresh per role and per spawn, valid pi session id", () => {
    const task = { id: "abc12", title: "t", laneId: "plan" } as never;
    const planner = sessionIdFor({ task, role: "planner", prompt: "" }, 1_000);
    const builder = sessionIdFor({ task, role: "builder", prompt: "" }, 1_000);
    const later = sessionIdFor({ task, role: "planner", prompt: "" }, 2_000);
    for (const id of [planner, builder, later]) {
      expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/);
      expect(id).toStartWith("kanban-abc12-");
    }
    expect(planner).not.toBe(builder);
    expect(planner).not.toBe(later);
  });

  test("formatPiEvent renders signal events, drops noise", () => {
    expect(formatPiEvent('{"type":"session","version":3,"id":"x","cwd":"/y"}')).toBe("session started");
    expect(
      formatPiEvent(
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"looks good\\nverdict soon"}]}}',
      ),
    ).toBe("text: looks good verdict soon");
    expect(formatPiEvent('{"type":"message_end","message":{"role":"user","content":[]}}')).toBeNull();
    expect(formatPiEvent('{"type":"tool_execution_start","toolName":"bash","args":{"command":"bun test"}}')).toBe(
      "→ bash: bun test",
    );
    expect(formatPiEvent('{"type":"tool_execution_end","toolName":"bash","durationMs":240,"isError":false}')).toBe(
      "✓ bash 240ms",
    );
    expect(formatPiEvent('{"type":"tool_execution_end","toolName":"edit","isError":true}')).toBe("✗ edit");
    expect(
      formatPiEvent('{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"errorMessage":"529 overloaded"}'),
    ).toBe("retry 1/3: 529 overloaded");
    expect(formatPiEvent('{"type":"compaction_start","reason":"threshold"}')).toBe("compacting (threshold)");
    expect(formatPiEvent('{"type":"message_update","usage":{"input":10}}')).toBeNull();
    expect(
      formatPiEvent('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hel"}}'),
    ).toBeNull();
    expect(formatPiEvent("not json")).toBeNull();
    const long = "x".repeat(400);
    expect(formatPiEvent(`{"type":"tool_execution_start","toolName":"bash","args":{"command":"${long}"}}`)!.length).toBeLessThanOrEqual(220);
  });

  test("formatPiEvent renders model errors, exhausted retries and unknown error events", () => {
    expect(
      formatPiEvent(
        '{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"usage limit reached"}}',
      ),
    ).toBe("✗ model error: usage limit reached");
    expect(
      formatPiEvent('{"type":"message_end","message":{"role":"assistant","stopReason":"error"}}'),
    ).toBe("✗ model error: unknown error");
    expect(
      formatPiEvent('{"type":"auto_retry_end","success":false,"finalError":"429 quota exceeded"}'),
    ).toBe("retries exhausted: 429 quota exceeded");
    expect(
      formatPiEvent('{"type":"auto_retry_end","success":true}'),
    ).toBeNull();
    expect(
      formatPiEvent('{"type":"compaction_end","errorMessage":"disk full"}'),
    ).toBe("✗ compaction failed: disk full");
    expect(
      formatPiEvent('{"type":"compaction_end"}'),
    ).toBeNull();
    expect(formatPiEvent('{"type":"agent_settled","aborted":true}')).toBe("settled (aborted)");
    expect(formatPiEvent('{"type":"agent_settled","aborted":false}')).toBe("settled");
    expect(formatPiEvent('{"type":"whatever","errorMessage":"boom"}')).toBe("⚠ whatever: boom");
    expect(formatPiEvent('{"type":"whatever"}')).toBeNull();
    expect(formatPiEvent('{"type":"whatever","errorMessage":"   "}')).toBeNull();
  });

  test("durationFor rounds seconds and minutes accurately", () => {
    expect(durationFor(8)).toBe("8s");
    expect(durationFor(59)).toBe("59s");
    expect(durationFor(60)).toBe("1 min");
    expect(durationFor(1200)).toBe("20 min");
  });

  test("deathReason names timeouts, exit codes and silent clean exits", () => {
    expect(deathReason({ code: 1, timedOut: true }, 1200, [])).toBe("timed out after 20 min");
    expect(
      deathReason({ code: 1, stderrTail: "line\nError: ECONNREFUSED" }, 4, []),
    ).toBe("failed (exit 1 — Error: ECONNREFUSED) after 4s");
    expect(deathReason({ code: 0 }, 8, [])).toBe(
      "ended without a verdict after 8s — model returned no output",
    );
    expect(deathReason({ code: 0 }, 30, ["session started", "text: looks good"])).toBe(
      "ended without a verdict after 30s",
    );
  });

  test("stderr tail is captured on exit 0 and lands in the session attachment", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const spawnFn: SpawnFn = (_job, context) => {
      context.emit("session started");
      return Promise.resolve({ code: 0, stderrTail: "provider: usage limit reached (HTTP 429)" });
    };
    start(spawnFn, dbFile);
    await sleep(30);
    const logs = db!.attachments(card.id, "session");
    expect(logs.length).toBe(1);
    expect(logs[0]!.content).toContain("stderr tail:");
    expect(logs[0]!.content).toContain("provider: usage limit reached (HTTP 429)");
  });

  test("reviewer death comment names exit code, stderr line and duration", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const spawnFn: SpawnFn = () =>
      Promise.resolve({ code: 1, stderrTail: "line\nError: ECONNREFUSED" });
    start(spawnFn, dbFile);
    await sleep(30);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(REVIEWER_AUTHOR);
    expect(last.body).toStartWith(
      "session died: auto-review failed (exit 1 — Error: ECONNREFUSED) after",
    );
    expect(last.body).toEndWith("; comment on this card to re-trigger.");
  });

  test("simulated spawn exiting 0 without a verdict leaves a reason comment and a diagnostic attachment", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const spawnFn: SpawnFn = () =>
      Promise.resolve({ code: 0, stderrTail: "quota exceeded" });
    start(spawnFn, dbFile);
    await sleep(30);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.body).toContain("session died: auto-review ended without a verdict after");
    expect(last.body).toContain("model returned no output");
    expect(last.body).toContain("; comment on this card to re-trigger.");
    const logs = db!.attachments(card.id, "session");
    expect(logs.length).toBe(1);
    expect(logs[0]!.content).toContain("stderr tail:");
    expect(logs[0]!.content).toContain("quota exceeded");
  });

  test("finished sessions save their log on the card; silent ones save nothing", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    let talkative = true;
    const spawnFn: SpawnFn = (_job, context) => {
      if (talkative) {
        context.emit("session started");
        context.emit("→ bash: bun test");
      }
      return Promise.resolve({ code: talkative ? 0 : 1 });
    };
    start(spawnFn, dbFile);
    await sleep(20);
    const logs = db!.attachments(card.id, "session");
    expect(logs.length).toBe(1);
    expect(logs[0]!.source).toBe("autoreview");
    expect(logs[0]!.content).toContain("pi-reviewer"); // header names the role
    expect(logs[0]!.content).toContain("→ bash: bun test");

    // a silent session (nothing emitted) attaches nothing
    talkative = false;
    w.createComment(card.id, { author: "user", body: "re-arm" }); // any comment re-arms review
    await sleep(200);
    expect(db!.attachments(card.id, "session").length).toBe(1);
  });

  test("activity registry: session lists with emitted lines, clears when the job ends", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    let ctx!: SpawnContext;
    let finish!: (result: SpawnResult) => void;
    const spawnFn: SpawnFn = (job, context) => {
      ctx = context;
      return new Promise<SpawnResult>((resolve) => (finish = resolve));
    };
    start(spawnFn, dbFile);
    expect(activitySnapshot().map((s) => s.taskId)).toEqual([card.id]);
    ctx.emit("session started");
    ctx.emit("→ bash: bun test");
    const snap = activitySnapshot()[0]!;
    expect(snap.role).toBe("reviewer");
    expect(snap.log).toEqual(["session started", "→ bash: bun test"]);
    finish({ code: 0 });
    await sleep(20);
    expect(activitySnapshot().some((s) => s.taskId === card.id)).toBe(false);
  });

  test("activity registry: stop() clears sessions even with a pending spawn", () => {
    const { dbFile, writer: w } = setup();
    cardInReview(w);
    const spawnFn: SpawnFn = () => new Promise<SpawnResult>(() => {});
    const handle = start(spawnFn, dbFile);
    expect(activitySnapshot().length).toBe(1);
    handle.stop();
    expect(activitySnapshot().length).toBe(0);
  });
});

describe("auto-plan", () => {
  /** A card in the plan lane with a plan attached — one human action from the gate. */
  function cardInPlan(w: KanbanDb, title = "plan me") {
    const card = w.createTask({ title, lane: "plan" });
    w.attach(card.id, "plan", "# plan v1\nstep one");
    return card;
  }

  test("planner spawns for a bare card in the plan lane; its own comment disarms it", async () => {
    const { dbFile, writer: w } = setup();
    const card = w.createTask({ title: "fresh idea", lane: "plan" });
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("planner");
    expect(calls[0].job.prompt).toContain(`kanban brief ${card.id}`);
    expect(calls[0].job.prompt).toContain("kanban attach");

    // planner finishes: attaches a plan and comments → disarmed
    w.attach(card.id, "plan", "# v2");
    await w.createComment(card.id, { author: PLANNER_AUTHOR, body: "plan v2 attached" });
    calls[0].finish({ code: 0 });
    await sleep(20);
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(1); // no re-spawn
  });

  test("rejection re-arms the planner; the prompt points at the feedback", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInPlan(w);
    await w.createComment(card.id, { author: PLANNER_AUTHOR, body: "plan v1 attached" });
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(0); // disarmed by the planner's comment

    await w.rejectTask(card.id, "use SSE, not polling");
    await sleep(200);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("planner");
    expect(calls[0].job.prompt).toContain("rejection");
    expect(db!.resolveTask(card.id).laneId).toBe("plan");
  });

  const PASS = "plan review: pass";
  const BLOCK = "plan review: block";

  /** A card whose planner just handed off — armed for the plan reviewer. */
  function planReady(w: KanbanDb, title = "plan ready") {
    const card = w.createTask({ title, lane: "plan" });
    w.attach(card.id, "plan", "# plan v1\nsteps");
    w.createComment(card.id, { author: PLANNER_AUTHOR, kind: "handoff", body: "plan v1 attached — over to pi-plan-reviewer" });
    return card;
  }

  function planVerdict(w: KanbanDb, card: { id: string }, verdict: "pass" | "block", body: string) {
    return w.createComment(card.id, { author: PLAN_REVIEWER_AUTHOR, kind: "review", body });
  }

  test("planner handoff arms the plan reviewer; its prompt carries the checklist", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("plan-reviewer");
    expect(calls[0].job.task.id).toBe(card.id);
    expect(calls[0].job.prompt).toContain(`plan-review ${card.id} --pass`);
    expect(calls[0].job.prompt).toContain(`plan-review ${card.id} --block`);
    expect(calls[0].job.prompt).toContain("Review checklist");
    expect(calls[0].job.prompt).toContain("Never move the card");

    await planVerdict(w, card, "pass", `${PASS} — executable`);
    calls[0].finish({ code: 0 });
    await sleep(20);
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(1); // pass leaves the card at the human gate
  });

  test("plan-review block re-arms the planner with the findings", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await planVerdict(w, card, "block", `${BLOCK} — vague tests\n- AC2 has no test`);
    calls[0].finish({ code: 0 });
    await sleep(20);
    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("planner");
    expect(calls[1].job.prompt).toContain("plan-review");
    expect(db!.resolveTask(card.id).laneId).toBe("plan");
  });

  test("two blocks since the last human comment hit the plan-review cap", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    // block 1 → planner
    await planVerdict(w, card, "block", `${BLOCK} — 1`);
    calls[0].finish({ code: 0 });
    await sleep(20);
    expect(calls[1]!.job.role).toBe("planner");
    await w.createComment(card.id, { author: PLANNER_AUTHOR, kind: "handoff", body: "plan v2 attached — over to pi-plan-reviewer" });
    calls[1].finish({ code: 0 });
    await sleep(20);
    expect(calls[2]!.job.role).toBe("plan-reviewer");
    // block 2 → cap, not a third planner run
    await planVerdict(w, card, "block", `${BLOCK} — 2`);
    calls[2].finish({ code: 0 });
    await sleep(20);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(PLAN_REVIEWER_AUTHOR);
    expect(last.body).toContain("cap");
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(3); // cap comment disarmed the card
  });

  test("a human rejection resets the plan-review block count", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    for (let round = 1; round <= 2; round++) {
      await planVerdict(w, card, "block", `${BLOCK} — ${round}`);
      calls.at(-1)!.finish({ code: 0 });
      await sleep(20);
      if (round === 1) {
        await w.createComment(card.id, { author: PLANNER_AUTHOR, kind: "handoff", body: "plan v2 — over to pi-plan-reviewer" });
        calls.at(-1)!.finish({ code: 0 });
        await sleep(20);
      }
    }
    expect(db!.comments(card.id).at(-1)!.body).toContain("cap"); // two blocks → capped

    await w.rejectTask(card.id, "shrink the scope"); // human feedback resets the count
    await sleep(200);
    expect(calls.at(-1)!.job.role).toBe("planner");
    await w.createComment(card.id, { author: PLANNER_AUTHOR, kind: "handoff", body: "plan v3 — over to pi-plan-reviewer" });
    calls.at(-1)!.finish({ code: 0 });
    await sleep(20);
    await planVerdict(w, card, "block", `${BLOCK} — after reset`);
    calls.at(-1)!.finish({ code: 0 });
    await sleep(20);
    expect(calls.at(-1)!.job.role).toBe("planner"); // 1 block since the human comment — not capped
    expect(db!.comments(card.id).at(-1)!.body).not.toContain("cap");
  });

  test("plan-reviewer crash posts a failure comment and does not hot-loop", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    calls[0].finish({ code: 1 });
    await sleep(20);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(PLAN_REVIEWER_AUTHOR);
    expect(last.body).toContain("failed");
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(1);
  });

  test("plan-reviewer failure: a human comment re-runs the reviewer, not the planner", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    calls[0].finish({ code: 1 });
    await sleep(20);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(PLAN_REVIEWER_AUTHOR);
    expect(last.body).toContain("failed");

    await w.createComment(card.id, { author: "user", body: "re-run the review" });
    await sleep(200);
    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("plan-reviewer");
    expect(calls[1].job.prompt).toContain(`plan-review ${card.id} --pass`);
    expect(calls.map((c) => c.job.role)).not.toContain("planner");
    expect(db!.attachments(card.id, "plan").length).toBe(1);
  });

  test("plan-reviewer cannot-evaluate: a human comment re-runs the reviewer", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(1);
    const threadBefore = db!.comments(card.id).length;
    await w.createComment(card.id, {
      author: PLAN_REVIEWER_AUTHOR,
      kind: "comment",
      body: "cannot evaluate the plan — repo unreadable",
    });
    calls[0].finish({ code: 0 });
    await sleep(20);
    expect(db!.comments(card.id).length).toBe(threadBefore + 1);

    await w.createComment(card.id, { author: "user", body: "fixed repo, try again" });
    await sleep(200);
    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("plan-reviewer");
  });

  test("plan-review cap: a human comment re-runs the reviewer on the same plan", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    // block 1 → planner
    await planVerdict(w, card, "block", `${BLOCK} — 1`);
    calls[0].finish({ code: 0 });
    await sleep(20);
    expect(calls[1]!.job.role).toBe("planner");
    await w.attach(card.id, "plan", "# plan v2\nrevised");
    await w.createComment(card.id, { author: PLANNER_AUTHOR, kind: "handoff", body: "plan v2 attached — over to pi-plan-reviewer" });
    calls[1].finish({ code: 0 });
    await sleep(20);
    expect(calls[2]!.job.role).toBe("plan-reviewer");
    // block 2 → cap
    await planVerdict(w, card, "block", `${BLOCK} — 2`);
    calls[2].finish({ code: 0 });
    await sleep(20);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(PLAN_REVIEWER_AUTHOR);
    expect(last.body).toContain("cap");
    expect(db!.attachments(card.id, "plan").length).toBe(2);

    await w.createComment(card.id, { author: "user", body: "give it another look" });
    await sleep(200);
    expect(calls.length).toBe(4);
    expect(calls[3].job.role).toBe("plan-reviewer");
    expect(db!.attachments(card.id, "plan").length).toBe(2);
  });

  test("human comment after a pass re-arms the planner (unchanged)", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("plan-reviewer");

    await planVerdict(w, card, "pass", `${PASS} — executable`);
    calls[0].finish({ code: 0 });
    await sleep(20);
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(1); // pass leaves the card at the human gate

    await w.createComment(card.id, { author: "user", body: "actually revise step 2" });
    await sleep(200);
    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("planner");
  });

  test("rejection after a reviewer failure still re-arms the planner", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    calls[0].finish({ code: 1 });
    await sleep(20);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(PLAN_REVIEWER_AUTHOR);
    expect(last.body).toContain("failed");

    await w.rejectTask(card.id, "rewrite it");
    await sleep(200);
    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("planner");
  });

  test("plan reviewer defaults to thinking max; prompt forbids the gate", () => {
    const task = { id: "abc12", title: "plan me", laneId: "plan" } as never;
    withAgentEnv({}, () => {
      expect(agentFlags("plan-reviewer", null)).toEqual(["--thinking", "max"]);
    });
    expect(planReviewerPrompt(task)).toContain("never run kanban approve/reject");
  });

  test("approval arms the plan-build builder; its handoff re-arms the reviewer", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInPlan(w);
    await w.approveTask(card.id); // approval comment + move to implement
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("builder");
    expect(calls[0].job.mode).toBe("plan");
    expect(calls[0].job.prompt).toContain("had its plan approved");

    // builder builds and hands off to review → reviewer takes over
    await w.handoff(card.id, "review", { author: BUILDER_AUTHOR, message: "built, tests green" });
    calls[0].finish({ code: 0 });
    await sleep(20);
    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("reviewer");
  });

  test("agent-authored approval never arms the builder", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInPlan(w);
    await w.approveTask(card.id, { author: "pi-planner" }); // a rogue agent approving its own plan
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(150);
    expect(calls.length).toBe(0);
  });

  test("planner question disarms; a human answer re-arms the planner", async () => {
    const { dbFile, writer: w } = setup();
    const card = w.createTask({ title: "ambiguous idea", lane: "plan" });
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(1);
    expect(calls[0].job.prompt).toContain("--kind question");

    // planner asks instead of attaching a plan → waiting on the human, no failure comment
    await w.createComment(card.id, { author: PLANNER_AUTHOR, kind: "question", body: "Q1: SSE or polling? default: SSE" });
    calls[0].finish({ code: 0 });
    await sleep(20);
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(1);
    expect(db!.comments(card.id).at(-1)!.kind).toBe("question");

    // the human answers → planner runs again
    await w.createComment(card.id, { author: "user", body: "SSE" });
    await sleep(200);
    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("planner");
  });

  test("planner crash posts a failure comment and does not hot-loop", async () => {
    const { dbFile, writer: w } = setup();
    const card = w.createTask({ title: "doomed", lane: "plan" });
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    calls[0].finish({ code: 1 });
    await sleep(20);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(PLANNER_AUTHOR);
    expect(last.body).toContain("auto-plan failed");
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(1);
  });

  test("planner defaults to thinking max; prompt forbids moving the card or touching the gate", () => {
    const task = { id: "abc12", title: "plan me", laneId: "plan" } as never;
    withAgentEnv({}, () => {
      expect(agentFlags("planner", null)).toEqual(["--thinking", "max"]);
    });
    expect(plannerPrompt(task)).toContain("Never move the card");
    expect(plannerPrompt(task)).toContain("never run kanban approve/reject");
    expect(builderPlanPrompt(task)).toContain("never run kanban approve/reject");
  });

  test("plan template file carries every required section, in order", () => {
    const templatePart = PLAN_TEMPLATE.split(/^## Review checklist$/m)[0]!;
    const headings = [...templatePart.matchAll(/^### (.+)$/gm)].map((m) => m[1]!.trim());
    expect(headings).toEqual([...PLAN_SECTIONS]);
    expect(PLAN_TEMPLATE).toContain("## Review checklist");
    expect(PLAN_TEMPLATE).toContain("N/A — reason");
  });

  test("plannerPrompt embeds the template and makes the planner self-check against the checklist", () => {
    const prompt = plannerPrompt({ id: "abc12", title: "plan me", laneId: "plan" } as never);
    expect(prompt).toContain(PLAN_TEMPLATE.trim());
    for (const section of PLAN_SECTIONS) expect(prompt).toContain(`### ${section}`);
    expect(prompt).toContain("Review checklist");
  });

  test("SKILL.md auto-plan section documents failed-review routing", () => {
    const skillPath = join(import.meta.dir, "..", "skills", "pi-kanban", "SKILL.md");
    const skillContent = readFileSync(skillPath, "utf8");
    const [_, planSection] = skillContent.split(/## Auto-plan loop\n/);
    expect(planSection).toBeDefined();
    const [autoPlanText] = planSection.split(/## Auto-review loop\n/);
    expect(autoPlanText).toBeDefined();
    expect(autoPlanText).toContain("any human comment re-runs the");
    expect(autoPlanText).toContain("no re-plan");
    expect(autoPlanText).toContain("re-arms the");
  });
});

// ---------- cross-process leases ----------

test("two server loops on one db → exactly one planner spawns", async () => {
  const { dbFile, writer } = setup();
  writer.createTask({ title: "race me", lane: "plan" });
  const a = fakeSpawn();
  const b = fakeSpawn();
  const dbA = new KanbanDb(dbFile);
  const dbB = new KanbanDb(dbFile);
  const hA = startAutoReview({ db: dbA, cwd: dir, spawnFn: a.spawnFn, watchIntervalMs: 50 });
  const hB = startAutoReview({ db: dbB, cwd: dir, spawnFn: b.spawnFn, watchIntervalMs: 50 });
  stop = () => {
    hA.stop();
    hB.stop();
    dbA.close();
    dbB.close();
  };
  await sleep(500);
  expect(a.calls.length + b.calls.length).toBe(1);
});

test("stop kills in-flight children and releases the lease", async () => {
  const { dbFile, writer } = setup();
  const card = writer.createTask({ title: "long runner", lane: "plan" });
  const kills: number[] = [];
  let spawns = 0;
  const spawnFn: SpawnFn = (_job, ctx) => {
    spawns += 1;
    return new Promise<SpawnResult>((resolve) => {
      ctx.track(() => {
        kills.push(1);
        resolve({ code: 143 });
      });
    });
  };
  const dbA = new KanbanDb(dbFile);
  const h = startAutoReview({ db: dbA, cwd: dir, spawnFn, watchIntervalMs: 50 });
  stop = () => {
    h.stop();
    try {
      dbA.close();
    } catch {}
  };
  await sleep(300);
  expect(spawns).toBe(1);
  expect(writer.leaseFor(card.id)).not.toBeNull(); // held while the session runs
  h.stop();
  dbA.close();
  await sleep(100);
  expect(kills.length).toBe(1); // child terminated, not orphaned
  expect(writer.leaseFor(card.id)).toBeNull(); // lease released on shutdown
  expect(writer.comments(card.id).length).toBe(0); // stopped session posts no exit 143 failure comment
});

test("lease released after a session finishes normally", async () => {
  const { dbFile, writer } = setup();
  const card = writer.createTask({ title: "quick one", lane: "plan" });
  const fake = fakeSpawn();
  const dbA = new KanbanDb(dbFile);
  const h = startAutoReview({ db: dbA, cwd: dir, spawnFn: fake.spawnFn, watchIntervalMs: 50 });
  stop = () => {
    h.stop();
    dbA.close();
  };
  await sleep(300);
  expect(fake.calls.length).toBe(1);
  fake.calls[0]!.finish({ code: 0 });
  await sleep(200);
  expect(writer.leaseFor(card.id)).toBeNull();
});

test("session finish untracks kill handle so stop() does not invoke it", async () => {
  const { dbFile, writer } = setup();
  writer.createTask({ title: "track cleanup", lane: "plan" });
  let killCalled = false;
  let finishSession!: () => void;
  const spawnFn: SpawnFn = (_job, ctx) => {
    ctx.track(() => {
      killCalled = true;
    });
    return new Promise<SpawnResult>((resolve) => {
      finishSession = () => resolve({ code: 0 });
    });
  };
  const dbA = new KanbanDb(dbFile);
  const h = startAutoReview({ db: dbA, cwd: dir, spawnFn, watchIntervalMs: 50 });
  stop = () => {
    h.stop();
    dbA.close();
  };
  await sleep(300);
  expect(finishSession).toBeDefined();
  finishSession();
  await sleep(200);
  h.stop();
  expect(killCalled).toBe(false);
});

test("stale lease is reclaimed on scan and session spawns", async () => {
  const { dbFile, writer } = setup();
  const card = writer.createTask({ title: "crashed owner card", lane: "plan" });
  const raw = new Database(dbFile);
  try {
    raw.query(
      "INSERT INTO agent_leases (task_id, role, owner_pid, boot_id, heartbeat_at) VALUES (?, ?, ?, ?, ?)",
    ).run(card.id, "planner", 99999, 1, Date.now() - 120_000);
  } finally {
    raw.close();
  }

  expect(writer.leaseFor(card.id)).not.toBeNull();
  expect(writer.leaseFor(card.id, 60_000)).toBeNull();

  const fake = fakeSpawn();
  const dbA = new KanbanDb(dbFile);
  const h = startAutoReview({ db: dbA, cwd: dir, spawnFn: fake.spawnFn, watchIntervalMs: 50 });
  stop = () => {
    h.stop();
    dbA.close();
  };
  await sleep(300);
  expect(fake.calls.length).toBe(1);
  expect(fake.calls[0]!.job.role).toBe("planner");
  expect(writer.leaseFor(card.id)?.ownerPid).toBe(process.pid);
});

test("plannerPrompt names a per-run plan file so concurrent runs never clobber", () => {
  const task = { id: "k7x9", title: "t", note: "", laneId: "plan", project: "", parentId: null, position: 1, createdAt: 1, updatedAt: 1 };
  expect(plannerPrompt(task as never, 1234)).toContain("/tmp/plan-k7x9-ya.md");
});
