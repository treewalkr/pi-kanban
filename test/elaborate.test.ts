import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startAutoReview,
  ELABORATOR_AUTHOR,
  REVIEWER_AUTHOR,
  PLANNER_AUTHOR,
  PLAN_REVIEWER_AUTHOR,
  type AgentJob,
  type SpawnFn,
  type SpawnResult,
} from "../src/autoreview";
import { KanbanDb } from "../src/db";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeSpawn() {
  const calls: Array<{ job: AgentJob; finish: (result: SpawnResult) => void }> = [];
  const spawnFn: SpawnFn = (job) =>
    new Promise<SpawnResult>((resolve) => calls.push({ job, finish: resolve }));
  return { calls, spawnFn };
}

let dir = "";
let db: KanbanDb;

let loopDir = "";
let loopDb: KanbanDb | null = null;
let writer: KanbanDb | null = null;
let stop: (() => void) | null = null;

function setupLoop(): { dbFile: string; writer: KanbanDb } {
  loopDir = mkdtempSync(join(tmpdir(), "kanban-elaborate-loop-"));
  const dbFile = join(loopDir, "t.db");
  writer = new KanbanDb(dbFile);
  return { dbFile, writer };
}

function startLoop(spawnFn: SpawnFn, dbFile: string) {
  loopDb = new KanbanDb(dbFile);
  const handle = startAutoReview({ db: loopDb, cwd: loopDir, spawnFn, watchIntervalMs: 50 });
  stop = () => handle.stop();
  return handle;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-elaborate-"));
  db = new KanbanDb(join(dir, "t.db"));
});

afterEach(() => {
  stop?.();
  loopDb?.close();
  writer?.close();
  if (loopDir) rmSync(loopDir, { recursive: true, force: true });
  stop = null;
  loopDb = null;
  writer = null;
  loopDir = "";

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("elaborationRequests: queue → list → clear; on conflict updates timestamp", async () => {
  const t1 = db.createTask({ title: "First task" });
  const t2 = db.createTask({ title: "Second task" });

  expect(db.elaborationRequests()).toEqual([]);

  db.queueElaboration(t1.id);
  await sleep(10);
  db.queueElaboration(t2.id);

  const reqs = db.elaborationRequests();
  expect(reqs.map((r) => r.taskId)).toEqual([t1.id, t2.id]);
  expect(reqs[0].requestedAt).toBeLessThanOrEqual(reqs[1].requestedAt);

  // on conflict update
  await sleep(10);
  db.queueElaboration(t1.id);
  const updatedReqs = db.elaborationRequests();
  expect(updatedReqs.map((r) => r.taskId)).toEqual([t2.id, t1.id]);

  db.clearElaboration(t2.id);
  expect(db.elaborationRequests().map((r) => r.taskId)).toEqual([t1.id]);
  db.clearElaboration(t1.id);
  expect(db.elaborationRequests()).toEqual([]);
});

test("deleteTask cascades to elaboration_requests for task and descendants", () => {
  const parent = db.createTask({ title: "Parent task" });
  const child = db.createTask({ title: "Child task", parent: parent.id });

  db.queueElaboration(parent.id);
  db.queueElaboration(child.id);
  expect(db.elaborationRequests().length).toBe(2);

  db.deleteTask(parent.id, true);
  expect(db.elaborationRequests()).toEqual([]);
});

test("setAgentConfig accepts elaborator; invalid role error names elaborator", () => {
  const saved = db.setAgentConfig("elaborator", {
    model: "claude-haiku-3-5",
    thinking: "off",
  });
  expect(saved).toEqual({
    model: "claude-haiku-3-5",
    thinking: "off",
  });
  expect(db.agentConfig("elaborator")).toEqual(saved);

  expect(() => db.setAgentConfig("invalid-role", {})).toThrow(
    "unknown agent role 'invalid-role' (reviewer | builder | planner | plan-reviewer | elaborator)",
  );
});

test("elaboration request spawns one elaborator with the fixed prompt", async () => {
  const { dbFile, writer: w } = setupLoop();
  const card = w.createTask({ title: "Add fuzzy search", lane: "backlog" });
  w.queueElaboration(card.id);

  const { calls, spawnFn } = fakeSpawn();
  startLoop(spawnFn, dbFile);

  await sleep(100);
  expect(calls.length).toBe(1);
  const job = calls[0].job;
  expect(job.role).toBe("elaborator");
  expect(job.mode).toBe("elaborate");
  expect(job.prompt).toContain("You are pi-elaborator.");
  expect(job.prompt).toContain(card.id);
  expect(job.prompt).toContain(`kanban edit ${card.id} --note`);
  expect(job.prompt).toContain("--author pi-elaborator");
  expect(w.elaborationRequests()).toEqual([]);

  // finish the job; further scan spawns nothing
  calls[0].finish({ code: 0 });
  await sleep(50);
  w.createTask({ title: "noise" });
  await sleep(100);
  expect(calls.length).toBe(1);
});

test("request waits while the card already has a queued job, then fires", async () => {
  const { dbFile, writer: w } = setupLoop();
  const card = w.createTask({ title: "ship feature", lane: "review" });
  w.createComment(card.id, { author: "pi-builder", kind: "handoff", body: "done, please review" });

  const { calls, spawnFn } = fakeSpawn();
  startLoop(spawnFn, dbFile);

  await sleep(100);
  expect(calls.length).toBe(1);
  expect(calls[0].job.role).toBe("reviewer");

  // queue elaboration while reviewer runs
  w.queueElaboration(card.id);
  w.createTask({ title: "noise" });
  await sleep(100);
  // request row persists because reviewer owns the card
  expect(w.elaborationRequests().map((r) => r.taskId)).toEqual([card.id]);
  expect(calls.length).toBe(1);

  // reviewer finishes without re-arming reviewer (e.g. comment left)
  w.createComment(card.id, { author: REVIEWER_AUTHOR, kind: "comment", body: "looks fine" });
  calls[0].finish({ code: 0 });

  await sleep(150);
  // elaborator should now spawn and clear request
  expect(calls.length).toBe(2);
  expect(calls[1].job.role).toBe("elaborator");
  expect(w.elaborationRequests()).toEqual([]);
});

test("elaborator comments are invisible to lane arming — gate, question, review disarm", async () => {
  // Leg 1: plan card with plan attached + planner handoff + plan-reviewer pass + pi-elaborator comment
  {
    const { dbFile, writer: w } = setupLoop();
    const card = w.createTask({ title: "gated card", lane: "plan" });
    w.attach(card.id, "plan", "# Plan v1");
    w.createComment(card.id, { author: PLANNER_AUTHOR, kind: "handoff", body: "plan v1 attached" });
    w.planReview(card.id, { verdict: "pass", message: "looks good", author: PLAN_REVIEWER_AUTHOR });
    w.createComment(card.id, { author: ELABORATOR_AUTHOR, kind: "comment", body: "elaborated — note now carries intent + acceptance criteria" });

    const { calls, spawnFn } = fakeSpawn();
    startLoop(spawnFn, dbFile);
    await sleep(50);
    w.createTask({ title: "noise" });
    await sleep(100);
    expect(calls.length).toBe(0);

    stop?.();
    loopDb?.close();
    writer?.close();
    rmSync(loopDir, { recursive: true, force: true });
    stop = null;
    loopDb = null;
    writer = null;
    loopDir = "";
  }

  // Leg 2: plan card whose last decision comment is a pi-planner question + pi-elaborator comment
  {
    const { dbFile, writer: w } = setupLoop();
    const card = w.createTask({ title: "question card", lane: "plan" });
    w.createComment(card.id, { author: PLANNER_AUTHOR, kind: "question", body: "which database to use?" });
    w.createComment(card.id, { author: ELABORATOR_AUTHOR, kind: "comment", body: "elaborated — note now carries intent + acceptance criteria" });

    const { calls, spawnFn } = fakeSpawn();
    startLoop(spawnFn, dbFile);
    await sleep(50);
    w.createTask({ title: "noise" });
    await sleep(100);
    expect(calls.length).toBe(0);

    stop?.();
    loopDb?.close();
    writer?.close();
    rmSync(loopDir, { recursive: true, force: true });
    stop = null;
    loopDb = null;
    writer = null;
    loopDir = "";
  }

  // Leg 3: review card whose last decision comment is a pi-reviewer comment + pi-elaborator comment
  {
    const { dbFile, writer: w } = setupLoop();
    const card = w.createTask({ title: "review disarmed card", lane: "review" });
    w.createComment(card.id, { author: "pi-builder", kind: "handoff", body: "ready for review" });
    w.createComment(card.id, { author: REVIEWER_AUTHOR, kind: "comment", body: "left a note" });
    w.createComment(card.id, { author: ELABORATOR_AUTHOR, kind: "comment", body: "elaborated — note now carries intent + acceptance criteria" });

    const { calls, spawnFn } = fakeSpawn();
    startLoop(spawnFn, dbFile);
    await sleep(50);
    w.createTask({ title: "noise" });
    await sleep(100);
    expect(calls.length).toBe(0);

    stop?.();
    loopDb?.close();
    writer?.close();
    rmSync(loopDir, { recursive: true, force: true });
    stop = null;
    loopDb = null;
    writer = null;
    loopDir = "";
  }
});

test("elaboration on a gated plan card runs once and leaves the gate intact", async () => {
  const { dbFile, writer: w } = setupLoop();
  const card = w.createTask({ title: "gated plan card", lane: "plan" });
  w.attach(card.id, "plan", "# Plan v1");
  w.createComment(card.id, { author: PLANNER_AUTHOR, kind: "handoff", body: "plan v1 attached" });
  w.planReview(card.id, { verdict: "pass", message: "approved by reviewer", author: PLAN_REVIEWER_AUTHOR });

  const { calls, spawnFn } = fakeSpawn();
  startLoop(spawnFn, dbFile);
  await sleep(50);
  expect(calls.length).toBe(0);

  w.queueElaboration(card.id);
  w.createTask({ title: "noise" });
  await sleep(100);

  expect(calls.length).toBe(1);
  expect(calls[0].job.role).toBe("elaborator");

  // Fake agent posts the success comment and exits 0
  w.createComment(card.id, {
    author: ELABORATOR_AUTHOR,
    kind: "comment",
    body: "elaborated — note now carries intent + acceptance criteria",
  });
  calls[0].finish({ code: 0 });

  await sleep(50);
  w.createTask({ title: "noise" });
  await sleep(100);

  expect(calls.length).toBe(1); // no planner spawn
  expect(w.resolveTask(card.id).laneId).toBe("plan");

  const comments = w.comments(card.id);
  const lastComment = comments.at(-1);
  expect(lastComment?.author).toBe(ELABORATOR_AUTHOR);
  const decisionComments = comments.filter((c) => c.author !== ELABORATOR_AUTHOR);
  expect(decisionComments.at(-1)?.body).toContain(KanbanDb.PLAN_REVIEW_PASS);
});

test("elaboration success records the agent comment; death posts the retry hint", async () => {
  // Success leg
  {
    const { dbFile, writer: w } = setupLoop();
    const card = w.createTask({ title: "task to elaborate", lane: "backlog" });
    w.queueElaboration(card.id);

    const { calls, spawnFn } = fakeSpawn();
    startLoop(spawnFn, dbFile);

    await sleep(100);
    expect(calls.length).toBe(1);

    // fake agent updates note and creates comment
    w.updateTask(card.id, {
      note: "Intent: do something.\nAcceptance criteria:\nAC1 first criterion",
    });
    w.createComment(card.id, {
      author: ELABORATOR_AUTHOR,
      kind: "comment",
      body: "elaborated — note now carries intent + acceptance criteria",
    });
    calls[0].finish({ code: 0 });
    await sleep(50);

    const task = w.resolveTask(card.id);
    expect(task.note).toContain("Intent: do something.");
    expect(task.laneId).toBe("backlog");
    const comments = w.comments(card.id);
    expect(comments.at(-1)?.author).toBe(ELABORATOR_AUTHOR);
    expect(comments.some((c) => c.body.startsWith("session died:"))).toBe(false);

    stop?.();
    loopDb?.close();
    writer?.close();
    rmSync(loopDir, { recursive: true, force: true });
    stop = null;
    loopDb = null;
    writer = null;
    loopDir = "";
  }

  // Failure leg
  {
    const { dbFile, writer: w } = setupLoop();
    const card = w.createTask({ title: "failing elaboration", lane: "backlog" });
    w.queueElaboration(card.id);

    const { calls, spawnFn } = fakeSpawn();
    startLoop(spawnFn, dbFile);

    await sleep(100);
    expect(calls.length).toBe(1);

    calls[0].finish({ code: 1, stderrTail: "boom" });
    await sleep(50);

    const task = w.resolveTask(card.id);
    expect(task.laneId).toBe("backlog");
    const comments = w.comments(card.id);
    const last = comments.at(-1);
    expect(last?.author).toBe(ELABORATOR_AUTHOR);
    expect(last?.body).toContain("session died: elaboration");
    expect(last?.body).toContain(`kanban elaborate ${card.id}`);

    stop?.();
    loopDb?.close();
    writer?.close();
    rmSync(loopDir, { recursive: true, force: true });
    stop = null;
    loopDb = null;
    writer = null;
    loopDir = "";
  }
});
