import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
  formatPiEvent,
  plannerPrompt,
  planReviewerPrompt,
  reviewerPrompt,
  sessionIdFor,
  startAutoReview,
  type AgentJob,
  type SpawnContext,
  type SpawnFn,
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
  const calls: Array<{ job: AgentJob; finish: (code: number) => void }> = [];
  const spawnFn: SpawnFn = (job) =>
    new Promise<number>((resolve) => calls.push({ job, finish: resolve }));
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
    calls[0].finish(0);
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
    calls[0].finish(0);
    await sleep(20);
    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("builder");
    expect(calls[1].job.task.id).toBe(card.id);
    expect(calls[1].job.prompt).toContain("pi-builder");

    // builder fixes and hands back to review
    await w.handoff(card.id, "review", { author: BUILDER_AUTHOR, message: "fixed, tests green" });
    calls[1].finish(0);
    await sleep(20);
    expect(calls.length).toBe(3);
    expect(calls[2].job.role).toBe("reviewer");

    // second pass approves
    await w.handoff(card.id, "done", { kind: "review", author: REVIEWER_AUTHOR, message: "approved" });
    calls[2].finish(0);
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
    calls[0].finish(1);
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
    calls[0].finish(0);
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
    calls[0].finish(0);
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
    calls[0].finish(0);
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
    calls[0].finish(0);
    await sleep(20);
    expect(calls.length).toBe(2);
    calls[1].finish(1);
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
      return Promise.resolve(1); // session "fails": no verdict, so the loop stops here
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

  test("finished sessions save their log on the card; silent ones save nothing", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    let talkative = true;
    const spawnFn: SpawnFn = (_job, context) => {
      if (talkative) {
        context.emit("session started");
        context.emit("→ bash: bun test");
      }
      return Promise.resolve(talkative ? 0 : 1);
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
    let finish!: (code: number) => void;
    const spawnFn: SpawnFn = (job, context) => {
      ctx = context;
      return new Promise<number>((resolve) => (finish = resolve));
    };
    start(spawnFn, dbFile);
    expect(activitySnapshot().map((s) => s.taskId)).toEqual([card.id]);
    ctx.emit("session started");
    ctx.emit("→ bash: bun test");
    const snap = activitySnapshot()[0]!;
    expect(snap.role).toBe("reviewer");
    expect(snap.log).toEqual(["session started", "→ bash: bun test"]);
    finish(0);
    await sleep(20);
    expect(activitySnapshot().some((s) => s.taskId === card.id)).toBe(false);
  });

  test("activity registry: stop() clears sessions even with a pending spawn", () => {
    const { dbFile, writer: w } = setup();
    cardInReview(w);
    const spawnFn: SpawnFn = () => new Promise<number>(() => {});
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
    calls[0].finish(0);
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
    calls[0].finish(0);
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
    calls[0].finish(0);
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
    calls[0].finish(0);
    await sleep(20);
    expect(calls[1]!.job.role).toBe("planner");
    await w.createComment(card.id, { author: PLANNER_AUTHOR, kind: "handoff", body: "plan v2 attached — over to pi-plan-reviewer" });
    calls[1].finish(0);
    await sleep(20);
    expect(calls[2]!.job.role).toBe("plan-reviewer");
    // block 2 → cap, not a third planner run
    await planVerdict(w, card, "block", `${BLOCK} — 2`);
    calls[2].finish(0);
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
      calls.at(-1)!.finish(0);
      await sleep(20);
      if (round === 1) {
        await w.createComment(card.id, { author: PLANNER_AUTHOR, kind: "handoff", body: "plan v2 — over to pi-plan-reviewer" });
        calls.at(-1)!.finish(0);
        await sleep(20);
      }
    }
    expect(db!.comments(card.id).at(-1)!.body).toContain("cap"); // two blocks → capped

    await w.rejectTask(card.id, "shrink the scope"); // human feedback resets the count
    await sleep(200);
    expect(calls.at(-1)!.job.role).toBe("planner");
    await w.createComment(card.id, { author: PLANNER_AUTHOR, kind: "handoff", body: "plan v3 — over to pi-plan-reviewer" });
    calls.at(-1)!.finish(0);
    await sleep(20);
    await planVerdict(w, card, "block", `${BLOCK} — after reset`);
    calls.at(-1)!.finish(0);
    await sleep(20);
    expect(calls.at(-1)!.job.role).toBe("planner"); // 1 block since the human comment — not capped
    expect(db!.comments(card.id).at(-1)!.body).not.toContain("cap");
  });

  test("plan-reviewer crash posts a failure comment and does not hot-loop", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    calls[0].finish(1);
    await sleep(20);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(PLAN_REVIEWER_AUTHOR);
    expect(last.body).toContain("failed");
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(1);
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
    calls[0].finish(0);
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
    calls[0].finish(0);
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
    calls[0].finish(1);
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
});
