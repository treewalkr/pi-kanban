import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultLaneContext, KanbanDb } from "../src/db";
import {
  BUILDER_AUTHOR,
  REVIEWER_AUTHOR,
  activitySnapshot,
  evaluateLaneContext,
  startAutoReview,
  type AgentJob,
  type GateFn,
  type SpawnContext,
  type SpawnFn,
  type SpawnResult,
} from "../src/autoreview";
import {
  cardInReview,
  db,
  dir,
  fakeSpawn,
  setDb,
  setup,
  sleep,
  start,
  stop,
  useAutoReviewHooks,
  withAgentEnv,
} from "./autoreview.helpers";

useAutoReviewHooks();

describe("project routing", () => {
  function recordingSpawn() {
    const calls: Array<{ job: AgentJob; ctx: SpawnContext; finish: (result: SpawnResult) => void }> = [];
    const spawnFn: SpawnFn = (job, ctx) =>
      new Promise<SpawnResult>((resolve) => calls.push({ job, ctx, finish: resolve }));
    return { calls, spawnFn };
  }

  test("per-card spawn cwd: routed project spawns in its repo; un-routed falls back to serve cwd", async () => {
    const { dbFile, writer: w } = setup();
    const alphaDir = join(dir, "alpha-repo");
    mkdirSync(alphaDir);
    w.setProjectRepo("alpha", alphaDir);
    const routed = w.createTask({ title: "routed", lane: "review", project: "alpha" });
    w.createComment(routed.id, { author: BUILDER_AUTHOR, kind: "handoff", body: "done, please review" });

    const { calls, spawnFn } = recordingSpawn();
    withAgentEnv({}, () => start(spawnFn, dbFile));
    await sleep(150);
    expect(calls.map((c) => [c.job.task.id, c.ctx.cwd])).toEqual([[routed.id, alphaDir]]);

    // an un-routed tag keeps the serve launch dir
    const fallback = w.createTask({ title: "fallback", lane: "review", project: "beta" });
    w.createComment(fallback.id, { author: BUILDER_AUTHOR, kind: "handoff", body: "done, please review" });
    await sleep(150);
    expect(calls).toHaveLength(1); // serial default slot — the routed spawn is still in flight
    calls[0].finish({ code: 0 });
    await sleep(200);
    expect(calls).toHaveLength(2);
    expect(calls[1].job.task.id).toBe(fallback.id);
    expect(calls[1].ctx.cwd).toBe(dir);

    // resume mode routes through the same per-card cwd
    const dead = w.createTask({ title: "dead builder", lane: "implement", project: "alpha" });
    w.createComment(dead.id, { author: BUILDER_AUTHOR, kind: "comment", body: "session died: crash" });
    w.setCardSession(dead.id, "builder", "kanban-x-builder-1");
    w.queueResume(dead.id);
    calls[1].finish({ code: 0 });
    await sleep(200);
    const resume = calls.find((c) => c.job.task.id === dead.id && c.job.mode === "resume");
    expect(resume).toBeDefined();
    expect(resume!.ctx.cwd).toBe(alphaDir);
  });

  test("startup banner reports fallback cwd and routed project count", () => {
    const { dbFile, writer: w } = setup();
    const { spawnFn } = fakeSpawn();
    const boot = (): string[] => {
      const lines: string[] = [];
      const loopDb = new KanbanDb(dbFile);
      const handle = startAutoReview({ db: loopDb, cwd: dir, spawnFn, watchIntervalMs: 50, gate: null, log: (m) => lines.push(m) });
      handle.stop();
      loopDb.close();
      return lines;
    };

    expect(boot()[0]).toBe(
      `enabled — agents run in ${dir}, stall 10 min / cap 120 min, block cap 3, test gate off`,
    );

    const repo1 = join(dir, "repo-1");
    const repo2 = join(dir, "repo-2");
    mkdirSync(repo1);
    mkdirSync(repo2);
    w.setProjectRepo("alpha", repo1);
    w.setProjectRepo("beta", repo2);
    w.setProjectGate("gamma", true); // registered but un-routed — not counted

    expect(boot()[0]).toBe(
      `enabled — agents run in ${dir} +2 routed projects, stall 10 min / cap 120 min, block cap 3, test gate off`,
    );
  });

  test("pre-review gate runs in the card's repo and skips on test_gate=0", async () => {
    const { dbFile, writer: w } = setup();
    const alphaDir = join(dir, "alpha-repo");
    mkdirSync(alphaDir);
    w.setProjectRepo("alpha", alphaDir);
    const routed = w.createTask({ title: "gated routed", lane: "review", project: "alpha" });
    w.createComment(routed.id, { author: BUILDER_AUTHOR, kind: "handoff", body: "done, please review" });

    const gateCalls: string[] = [];
    const gateFn: GateFn = async (cwd) => {
      gateCalls.push(cwd);
      return { ok: true, output: "" };
    };
    const logs: string[] = [];
    const { calls, spawnFn } = recordingSpawn();
    withAgentEnv({}, () => start(spawnFn, dbFile, { gate: gateFn, log: (m) => logs.push(m) }));
    await sleep(150);
    expect(gateCalls).toEqual([alphaDir]);
    expect(calls).toHaveLength(1);
    calls[0].finish({ code: 0 });
    await sleep(150);

    // an un-routed tag gates on the serve cwd
    const fallback = w.createTask({ title: "gated fallback", lane: "review", project: "beta" });
    w.createComment(fallback.id, { author: BUILDER_AUTHOR, kind: "handoff", body: "done, please review" });
    await sleep(200);
    expect(gateCalls).toEqual([alphaDir, dir]);
    calls[1].finish({ code: 0 });
    await sleep(150);

    // test_gate=0 skips the gate; the reviewer still spawns
    w.setProjectGate("beta", false);
    const skipped = w.createTask({ title: "gate skipped", lane: "review", project: "beta" });
    w.createComment(skipped.id, { author: BUILDER_AUTHOR, kind: "handoff", body: "done, please review" });
    await sleep(200);
    expect(gateCalls).toHaveLength(2);
    const skipSpawn = calls.find((c) => c.job.task.id === skipped.id);
    expect(skipSpawn).toBeDefined();
    expect(logs).toContain(`reviewer ${skipped.id}: test gate off for project 'beta' — skipping`);
  });
});

// ---------- lane contexts: the generic interpreter (card 3n96c) ----------

describe("lane contexts", () => {
  test("roleFor has no hardcoded lane-id branches; contexts drive cleared, renamed, and custom lanes", async () => {
    // source-level: the loop's roleFor body carries no lane-id literals
    const src = readFileSync(new URL("../src/autoreview.ts", import.meta.url), "utf-8");
    const body = src.slice(src.indexOf("const roleFor"), src.indexOf("const enqueue"));
    expect(body).not.toContain('task.laneId === "plan"');
    expect(body).not.toContain('task.laneId === "implement"');
    expect(body).not.toContain('task.laneId === "review"');

    const { dbFile, writer: w } = setup();
    // clearing a lane's context disarms the loop on that lane
    w.setLaneContext("review", null);
    const card = cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(150);
    expect(calls.length).toBe(0);

    // attaching a context to the same lane arms its actors again
    w.setLaneContext("review", {
      actors: [{ id: "reviewer", author: REVIEWER_AUTHOR, instructions: `Review card {id} "{title}" hard.` }],
      triggers: [{ kind: "on-enter" }],
    });
    await sleep(150);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("reviewer");
    expect(calls[0].job.prompt).toContain(`Review card ${card.id} "ship it" hard.`);
    calls[0].finish({ code: 0 });
    await sleep(20);

    // renaming a lane keeps its workflow: contexts key on lane id, not name
    w.updateLane("plan", { name: "Product Design" });
    const card2 = w.createTask({ title: "plan me", lane: "plan" });
    w.attach(card2.id, "plan", "# plan v1");
    await sleep(150);
    const pr = calls.find((c) => c.job.role === "plan-reviewer");
    expect(pr).toBeDefined();
    expect(pr!.job.task.id).toBe(card2.id);
    pr!.finish({ code: 0 });
  });

  test("custom Design lane with own template, actor, exit rule, and gate runs end-to-end with zero code changes", async () => {
    const { dbFile, writer: w } = setup();
    w.createLane({ name: "Design" });
    w.setLaneContext("design", {
      artifact: "design",
      template: "# Design Spec\n## Layout",
      actors: [{ id: "designer", author: "pi-designer", instructions: `Design card {id} "{title}" against the template.` }],
      triggers: [{ kind: "on-enter" }],
      exits: [{ on: { author: "pi-designer", kind: "comment", prefix: "design: pass" }, action: "park" }],
      gate: { approveTarget: "plan", requireArtifact: "design", rejectPrefix: "design rejected" },
    });
    const card = w.createTask({ title: "redesign header", lane: "design" });
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("designer");
    expect(calls[0].job.prompt).toContain(`Design card ${card.id} "redesign header" against the template.`);
    expect(calls[0].job.prompt).toContain("--- design template and review checklist ---");
    expect(calls[0].job.prompt).toContain("## Layout");
    calls[0].finish({ code: 0 });
    await sleep(20);

    // the designer's pass verdict parks the card at the human gate (exit rule)
    w.comment(card.id, { author: "pi-designer", kind: "comment", body: "design: pass — see the spec" });
    await sleep(150);
    expect(w.resolveTask(card.id).laneId).toBe("waiting");
    expect(w.resolveTask(card.id).previousLane).toBe("design");
    expect(db!.waiting(card.id)).toBe("gate");

    // the human gate approves into the plan lane, arming the planner
    w.attach(card.id, "design", "# spec");
    w.approveTask(card.id);
    await sleep(200);
    const planner = calls.find((c) => c.job.role === "planner");
    expect(planner).toBeDefined();
    expect(planner!.job.task.id).toBe(card.id);
    expect(w.resolveTask(card.id).laneId).toBe("plan");
    planner!.finish({ code: 0 });
  });

  test("custom lane caps park for a human after max agent cycles", async () => {
    const { dbFile, writer: w } = setup();
    w.createLane({ name: "Design" });
    w.setLaneContext("design", {
      actors: [{ id: "designer", author: "pi-designer", instructions: "Design {id}." }],
      triggers: [{ kind: "comment", commentKind: "review", author: "pi-design-reviewer", targetActor: "designer" }, { kind: "human-comment" }],
      cap: { max: 2, scope: "thread", match: { author: "pi-design-reviewer", kind: "review" }, author: "pi-design-reviewer", message: "design cap: {max} cycles on {id}" },
    });
    const card = w.createTask({ title: "gfx", lane: "design" });
    w.createComment(card.id, { author: "pi-design-reviewer", kind: "review", body: "review: block — first" });
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(150);
    // cycle 1: one block since the thread started, under the cap of 2
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("designer");
    // the fake designer leaves its own comment, then finishes — no death trace
    w.createComment(card.id, { author: "pi-designer", kind: "handoff", body: "design v1 done" });
    calls[0].finish({ code: 0 });
    await sleep(20);

    // the second reviewer block is cycle 2 of 2 — the cap parks the card instead of re-arming
    w.createComment(card.id, { author: "pi-design-reviewer", kind: "review", body: "review: block — second" });
    await sleep(150);
    expect(calls.length).toBe(1); // capped
    const last = w.comments(card.id).at(-1)!;
    expect(last.author).toBe("pi-design-reviewer");
    expect(last.kind).toBe("question");
    expect(last.body).toBe(`design cap: 2 cycles on ${card.id}`);
    expect(w.resolveTask(card.id).laneId).toBe("waiting"); // the cap question parks the card

    // a human reply returns the card and re-arms the designer (the cap never gates a human's reply)
    w.comment(card.id, { author: "user", body: "redo it with the new palette" });
    await sleep(150);
    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("designer");
    calls[1].finish({ code: 0 });
  });

  test("evaluateLaneContext: a blocked card yields no actor and re-arms on unblock", () => {
    const { writer: w } = setup();
    const ctx = defaultLaneContext("implement")!;
    const blocker = w.createTask({ title: "blocker", lane: "implement" });
    const card = w.createTask({ title: "card", lane: "implement" });
    w.comment(card.id, { author: "user", body: "ready to build" });

    // armed human comment → actor.id === "builder"
    const ev1 = evaluateLaneContext(w, w.resolveTask(card.id), ctx);
    expect(ev1.actor?.id).toBe("builder");

    // after setBlockedBy → toEqual({ actor: null })
    w.setBlockedBy(card.id, [blocker.id]);
    const ev2 = evaluateLaneContext(w, w.resolveTask(card.id), ctx);
    expect(ev2).toEqual({ actor: null });

    // after the blocker → Done → actor.id === "builder"
    w.updateTask(blocker.id, { lane: "done" });
    const ev3 = evaluateLaneContext(w, w.resolveTask(card.id), ctx);
    expect(ev3.actor?.id).toBe("builder");
  });

  test("a blocked implement card gets no builder and nothing queued", async () => {
    const { dbFile, writer: w } = setup();
    const blocker = w.createTask({ title: "blocker", lane: "implement" });
    const card = w.createTask({ title: "card", lane: "implement" });
    w.comment(card.id, { author: "user", body: "build it" });
    w.setBlockedBy(card.id, [blocker.id]);

    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(150);
    expect(calls.length).toBe(0);
    expect(activitySnapshot().sessions.some((s) => s.taskId === card.id)).toBe(false);
    expect(activitySnapshot().queued.some((q) => q.taskId === card.id)).toBe(false);

    // unrelated write bumps data_version
    w.createTask({ title: "unrelated", lane: "backlog" });
    await sleep(150);
    expect(calls.length).toBe(0);
    expect(activitySnapshot().sessions.some((s) => s.taskId === card.id)).toBe(false);
    expect(activitySnapshot().queued.some((q) => q.taskId === card.id)).toBe(false);
  });

  test("a blocked card in plan is not armed on entry", async () => {
    const { dbFile, writer: w } = setup();
    const blocker = w.createTask({ title: "blocker", lane: "implement" });
    const card = w.createTask({ title: "card", lane: "backlog" });
    w.setBlockedBy(card.id, [blocker.id]);
    w.updateTask(card.id, { lane: "plan" });

    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(150);
    expect(calls.length).toBe(0);

    w.updateTask(blocker.id, { lane: "done" });
    await sleep(200);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("planner");
    expect(calls[0].job.task.id).toBe(card.id);
    calls[0].finish({ code: 0 });
  });

  test("unblocking re-arms the loop with no new comment", async () => {
    const { dbFile, writer: w } = setup();
    const blocker = w.createTask({ title: "blocker", lane: "implement" });
    const card = w.createTask({ title: "card", lane: "implement" });
    w.comment(card.id, { author: "user", body: "build it" });
    w.setBlockedBy(card.id, [blocker.id]);

    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(150);
    expect(calls.length).toBe(0);

    w.updateTask(blocker.id, { lane: "done" });
    await sleep(200);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("builder");
    expect(calls[0].job.task.id).toBe(card.id);
    expect(db!.nextTask().task?.id).toBe(card.id);
    calls[0].finish({ code: 0 });
  });

  test("a spawn queued before the block does not run when the slot frees", async () => {
    const { dbFile, writer: w } = setup();
    const blocker = w.createTask({ title: "blocker", lane: "implement" });
    const elab = w.createTask({ title: "elab", lane: "backlog" });
    w.queueElaboration(elab.id);

    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(150);

    // elaboration occupies the default slot
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("elaborator");

    // while elaborator runs, an armed implement card is queued
    const card = w.createTask({ title: "card", lane: "implement" });
    w.comment(card.id, { author: "user", body: "build it" });
    await sleep(150);
    expect(activitySnapshot().queued.some((q) => q.taskId === card.id)).toBe(true);

    // block the card, then finish the elaborator
    w.setBlockedBy(card.id, [blocker.id]);
    calls[0].finish({ code: 0 });
    await sleep(150);

    // does not run: dropped from queue
    expect(calls.length).toBe(1);
    expect(activitySnapshot().queued.some((q) => q.taskId === card.id)).toBe(false);

    // after unblocking, card spawns
    w.updateTask(blocker.id, { lane: "done" });
    await sleep(200);
    expect(calls.length).toBe(2);
    expect(calls[1].job.task.id).toBe(card.id);
    expect(calls[1].job.role).toBe("builder");
    calls[1].finish({ code: 0 });
  });

  test("a queued resume waits for the blocker and keeps its session id", async () => {
    const { dbFile, writer: w } = setup();
    const blocker = w.createTask({ title: "blocker", lane: "implement" });
    const card = w.createTask({ title: "dead builder", lane: "implement" });
    w.createComment(card.id, { author: BUILDER_AUTHOR, kind: "comment", body: "session died: timeout after 20m" });
    w.setCardSession(card.id, "builder", "kanban-x-builder-blocked");
    w.queueResume(card.id);
    w.setBlockedBy(card.id, [blocker.id]);

    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(150);

    expect(calls.length).toBe(0);
    expect(w.resumeRequests().some((r) => r.taskId === card.id)).toBe(true);

    w.updateTask(blocker.id, { lane: "done" });
    await sleep(200);

    expect(calls.length).toBe(1);
    expect(calls[0].job.mode).toBe("resume");
    expect(calls[0].job.sessionId).toBe("kanban-x-builder-blocked");
    expect(w.resumeRequests().some((r) => r.taskId === card.id)).toBe(false);
    calls[0].finish({ code: 0 });
  });

  test("a resume already queued is persisted when blocked and survives a restart", async () => {
    const { dbFile, writer: w } = setup();
    const blocker = w.createTask({ title: "blocker", lane: "implement" });
    const elab = w.createTask({ title: "elab", lane: "backlog" });
    w.queueElaboration(elab.id);

    const logs: string[] = [];
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile, { log: (msg) => logs.push(msg) });
    await sleep(150);

    // elaborator occupies the slot
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("elaborator");

    // dead card with resume queued behind the running elaborator
    const d = w.createTask({ title: "dead card", lane: "implement" });
    w.createComment(d.id, { author: BUILDER_AUTHOR, kind: "comment", body: "session died: crash" });
    w.setCardSession(d.id, "builder", "kanban-x-builder-restart");
    w.queueResume(d.id);
    await sleep(150);

    // block the dead card, then finish the elaborator
    w.setBlockedBy(d.id, [blocker.id]);
    calls[0].finish({ code: 0 });
    await sleep(150);

    expect(calls.length).toBe(1);
    expect(w.resumeRequests().some((r) => r.taskId === d.id)).toBe(true);
    expect(logs).toContain(`builder ${d.id}: blocked — resume held, request kept until its blockers land`);

    // restart the loop while still blocked
    stop!();
    db!.close();
    setDb(null);

    const fakeSpawn2 = fakeSpawn();
    start(fakeSpawn2.spawnFn, dbFile);
    await sleep(150);

    expect(fakeSpawn2.calls.length).toBe(0);
    expect(w.resumeRequests().some((r) => r.taskId === d.id)).toBe(true);

    // unblock: resumes with stored session id
    w.updateTask(blocker.id, { lane: "done" });
    await sleep(200);

    expect(fakeSpawn2.calls.length).toBe(1);
    expect(fakeSpawn2.calls[0].job.mode).toBe("resume");
    expect(fakeSpawn2.calls[0].job.sessionId).toBe("kanban-x-builder-restart");
    expect(w.resumeRequests().some((r) => r.taskId === d.id)).toBe(false);
    fakeSpawn2.calls[0].finish({ code: 0 });
  });

  test("a resume blocked during its pre-spawn gate hands its request back", async () => {
    const { dbFile, writer: w } = setup();
    const blocker = w.createTask({ title: "blocker", lane: "implement" });
    const card = w.createTask({ title: "review card", lane: "review" });
    w.createComment(card.id, { author: REVIEWER_AUTHOR, kind: "comment", body: "session died: stall" });
    w.setCardSession(card.id, "reviewer", "kanban-x-reviewer-gate");
    w.queueResume(card.id);

    let releaseGate: ((res: { ok: boolean; output: string }) => void) | undefined;
    let notifyGateStarted: (() => void) | undefined;
    const gateStarted = new Promise<void>((r) => { notifyGateStarted = r; });
    const gatePromise = new Promise<{ ok: boolean; output: string }>((r) => { releaseGate = r; });

    let gateMode: "hold" | "fast" = "hold";
    const testGate: GateFn = async () => {
      if (gateMode === "hold") {
        notifyGateStarted?.();
        return gatePromise;
      }
      return { ok: true, output: "" };
    };

    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile, { gate: testGate });

    await gateStarted;
    w.setBlockedBy(card.id, [blocker.id]);
    releaseGate!({ ok: true, output: "" });
    await sleep(150);

    expect(calls.length).toBe(0);
    expect(w.resumeRequests().some((r) => r.taskId === card.id)).toBe(true);

    gateMode = "fast";
    w.updateTask(blocker.id, { lane: "done" });
    await sleep(200);

    expect(calls.length).toBe(1);
    expect(calls[0].job.mode).toBe("resume");
    expect(calls[0].job.sessionId).toBe("kanban-x-reviewer-gate");
    expect(w.resumeRequests().some((r) => r.taskId === card.id)).toBe(false);
    calls[0].finish({ code: 0 });
  });

  test("a card blocked during the pre-spawn gate does not spawn when the gate clears", async () => {
    const { dbFile, writer: w } = setup();
    const blocker = w.createTask({ title: "blocker", lane: "implement" });
    const card = cardInReview(w);

    let releaseGate: ((res: { ok: boolean; output: string }) => void) | undefined;
    let notifyGateStarted: (() => void) | undefined;
    const gateStarted = new Promise<void>((r) => { notifyGateStarted = r; });
    const gatePromise = new Promise<{ ok: boolean; output: string }>((r) => { releaseGate = r; });

    let gateMode: "hold" | "fast" = "hold";
    const testGate: GateFn = async () => {
      if (gateMode === "hold") {
        notifyGateStarted?.();
        return gatePromise;
      }
      return { ok: true, output: "" };
    };

    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile, { gate: testGate });

    await gateStarted;
    w.setBlockedBy(card.id, [blocker.id]);
    releaseGate!({ ok: true, output: "" });
    await sleep(150);

    expect(calls.length).toBe(0);

    gateMode = "fast";
    w.updateTask(blocker.id, { lane: "done" });
    await sleep(200);

    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("reviewer");
    expect(calls[0].job.task.id).toBe(card.id);
    calls[0].finish({ code: 0 });
  });
});
