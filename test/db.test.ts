import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { DEFAULT_LANES, KanbanDb, KanbanError } from "../src/db";

let dir = "";
let db: KanbanDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-db-"));
  db = new KanbanDb(join(dir, "t.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("agentConfig: null → set → roundtrip → replace; unknown role rejected", () => {
  expect(db.agentConfig("reviewer")).toBeNull();
  const saved = db.setAgentConfig("reviewer", {
    provider: "anthropic",
    model: " claude-opus-4-5 ",
    thinking: "max",
    skills: [" ~/.pi/skills/x ", "", "  "],
    context: "we value perf over features",
    timeoutMs: 1_200_000,
  });
  expect(saved).toEqual({
    provider: "anthropic",
    model: "claude-opus-4-5",
    thinking: "max",
    skills: ["~/.pi/skills/x"],
    context: "we value perf over features",
    timeoutMs: 1_200_000,
  });
  expect(db.agentConfig("reviewer")).toEqual(saved);
  expect(db.agentConfig("builder")).toBeNull();

  // set is a full replace — dropped fields disappear
  expect(db.setAgentConfig("reviewer", { model: "other" })).toEqual({ model: "other" });

  expect(() => db.setAgentConfig("worker", {})).toThrow(KanbanError);
});

test("approveTask: approval comment + move to implement; guards lane and plan", () => {
  const task = db.createTask({ title: "feature" });
  db.moveTask(task.id, "plan");
  expect(() => db.approveTask(task.id)).toThrow(/no attached plan/);

  db.attach(task.id, "plan", "# plan v1\ndo the thing");
  const { task: moved, comment } = db.approveTask(task.id, { author: "user" });
  expect(moved.laneId).toBe("implement");
  expect(comment.kind).toBe("approval");
  expect(comment.author).toBe("user");
  expect(comment.body).toBe("plan v1 approved — build it");

  // card no longer in plan → guard fires
  expect(() => db.approveTask(task.id)).toThrow(/not in the plan lane/);
});

test("rejectTask: feedback comment, card stays in plan; empty feedback rejected", () => {
  const task = db.createTask({ title: "feature" });
  db.moveTask(task.id, "plan");
  db.attach(task.id, "plan", "# plan v1");
  const comment = db.rejectTask(task.id, "  use SSE, not polling  ");
  expect(comment.kind).toBe("rejection");
  expect(comment.body).toBe("plan rejected: use SSE, not polling");
  expect(db.resolveTask(task.id).laneId).toBe("plan"); // stays put — re-plan expected
  expect(() => db.rejectTask(task.id, "   ")).toThrow(/must not be empty/);
  expect(() => db.rejectTask(db.createTask({ title: "x" }).id, "why")).toThrow(/not in the plan lane/);
});

test("comment kinds include the plan-gate pair", () => {
  const task = db.createTask({ title: "kinds" });
  for (const kind of ["comment", "review", "handoff", "approval", "rejection"] as const) {
    expect(db.createComment(task.id, { kind, body: `as ${kind}` }).kind).toBe(kind);
  }
  expect(() => db.createComment(task.id, { kind: "verdict", body: "nope" })).toThrow(KanbanError);
});

test("attachments(kind) returns every version oldest-first", () => {
  const task = db.createTask({ title: "one" });
  db.attach(task.id, "session", "first session", "autoreview");
  db.attach(task.id, "session", "second session", "autoreview");
  const logs = db.attachments(task.id, "session");
  expect(logs.map((l) => l.version)).toEqual([1, 2]);
  expect(logs.map((l) => l.content)).toEqual(["first session", "second session"]);
  expect(db.attachment(task.id, "session")!.content).toBe("second session"); // latest still works
});

test("seeds the default workflow lanes in order", () => {
  const lanes = db.lanes();
  expect(lanes.map((l) => l.id)).toEqual(DEFAULT_LANES.map((l) => l.id));
  expect(lanes.map((l) => l.position)).toEqual(DEFAULT_LANES.map((_, i) => (i + 1) * 100));
  expect(lanes.at(-1)?.id).toBe("archive");
  expect(lanes.at(-1)?.fixed).toBe(1);
});

test("appends the archive lane when reopening a board that predates it", () => {
  const path = join(dir, "old.db");
  new KanbanDb(path).close();
  const raw = new Database(path); // simulate a board written before archive existed
  raw.run("DELETE FROM lanes WHERE id = 'archive'");
  raw.close();
  const reopened = new KanbanDb(path);
  const lanes = reopened.lanes();
  expect(lanes.at(-1)?.id).toBe("archive");
  expect(lanes.at(-1)?.fixed).toBe(1);
  expect(lanes.at(-1)!.position).toBeGreaterThan(lanes.at(-2)!.position);
  reopened.close();
});

test("adds the parent column when reopening a board that predates hierarchy", () => {
  const path = join(dir, "old.db");
  const raw = new Database(path); // simulate a board written before parent_id existed
  raw.exec(`
    CREATE TABLE lanes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      position REAL NOT NULL, fixed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      lane_id TEXT NOT NULL REFERENCES lanes (id), project TEXT NOT NULL DEFAULT '',
      position REAL NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO lanes (id, name, description, position, fixed) VALUES ('todo', 'Todo', '', 100, 0);
    INSERT INTO tasks (id, title, note, lane_id, project, position, created_at, updated_at)
      VALUES ('abc12', 'legacy', '', 'todo', '', 100, 0, 0);
  `);
  raw.close();
  const reopened = new KanbanDb(path);
  expect(reopened.resolveTask("abc12").parentId).toBeNull();
  reopened.close();
});

test("createTask defaults to the first lane and appends in order", () => {
  const a = db.createTask({ title: "a" });
  const b = db.createTask({ title: "b" });
  expect(a.laneId).toBe("backlog");
  expect(a.position).toBe(100);
  expect(b.position).toBe(200);
  expect(db.laneTasks("backlog").map((t) => t.title)).toEqual(["a", "b"]);
});

test("resolves lanes by slug prefix, name prefix, and ordinal", () => {
  expect(db.resolveLane("imp").name).toBe("Test + Implement");
  expect(db.resolveLane("rev").name).toBe("Review");
  expect(db.resolveLane("3").name).toBe("Test + Implement");
  expect(() => db.resolveLane("zzz")).toThrow(KanbanError);
});

test("resolves tasks by id prefix and rejects ambiguity", () => {
  const a = db.createTask({ title: "a" });
  expect(db.resolveTask(a.id.slice(0, 2)).id).toBe(a.id);
  expect(() => db.resolveTask("zzzzz")).toThrow(/no task/);
});

test("moveTask inserts at an index and appends without one", () => {
  const a = db.createTask({ title: "a" });
  const b = db.createTask({ title: "b" });
  const c = db.createTask({ title: "c" });
  db.moveTask(c.id, "backlog", 0);
  expect(db.laneTasks("backlog").map((t) => t.title)).toEqual(["c", "a", "b"]);
  db.moveTask(c.id, "plan");
  expect(db.laneTasks("backlog").map((t) => t.title)).toEqual(["a", "b"]);
  expect(db.laneTasks("plan").map((t) => t.title)).toEqual(["c"]);
});

test("midpoint squeezes trigger renormalization instead of collapsing", () => {
  for (let i = 0; i < 40; i++) db.createTask({ title: `t${i}`, index: 0 });
  const positions = db.laneTasks("backlog").map((t) => t.position);
  for (let i = 1; i < positions.length; i++) {
    expect(positions[i] - positions[i - 1]).toBeGreaterThan(0.01);
  }
});

test("updateTask merges a patch and bumps updatedAt", () => {
  const a = db.createTask({ title: "old" });
  const updated = db.updateTask(a.id, { title: "new", note: "n", lane: "review", project: "x" });
  expect(updated.title).toBe("new");
  expect(updated.laneId).toBe("review");
  expect(updated.project).toBe("x");
  expect(updated.updatedAt).toBeGreaterThanOrEqual(a.createdAt);
});

test("lane guards: fixed lanes and non-empty lanes refuse deletion", () => {
  expect(() => db.deleteLane("backlog")).toThrow(/fixed/);
  db.createTask({ title: "a" });
  expect(() => db.deleteLane("backlog")).toThrow(/fixed/); // backlog is fixed even when full
  db.createTask({ title: "b", lane: "plan" });
  expect(() => db.deleteLane("plan")).toThrow(/still holds/);
  expect(db.deleteLane("plan", true).id).toBe("plan");
  expect(db.tasks().every((t) => t.laneId !== "plan")).toBe(true);
});

test("createLane slugifies and dedupes ids", () => {
  const first = db.createLane({ name: "Blocked" });
  const second = db.createLane({ name: "Blocked" });
  expect(first.id).toBe("blocked");
  expect(second.id).toBe("blocked-2");
});

test("board groups tasks by lane order", () => {
  db.createTask({ title: "a", lane: "done" });
  db.createTask({ title: "b" });
  const { tasks } = db.board();
  expect(tasks.map((t) => t.title)).toEqual(["b", "a"]);
});

test("createTask with a parent defaults to the parent's lane", () => {
  const epic = db.createTask({ title: "epic", lane: "plan" });
  const story = db.createTask({ title: "story", parent: epic.id });
  expect(story.parentId).toBe(epic.id);
  expect(story.laneId).toBe("plan");
  expect(db.createTask({ title: "elsewhere", parent: epic.id, lane: "done" }).laneId).toBe("done");
});

test("hierarchy depth is capped at epic → story → subtask", () => {
  const epic = db.createTask({ title: "epic" });
  const story = db.createTask({ title: "story", parent: epic.id });
  const sub = db.createTask({ title: "sub", parent: story.id });
  expect(() => db.createTask({ title: "too deep", parent: sub.id })).toThrow(/epic → story → subtask/);
  const otherStory = db.createTask({ title: "other story", parent: epic.id });
  expect(() => db.updateTask(story.id, { parent: otherStory.id })).toThrow(/epic → story → subtask/);
  const root = db.createTask({ title: "root" });
  expect(db.updateTask(story.id, { parent: root.id }).parentId).toBe(root.id);
});

test("parenting rejects self and descendant cycles", () => {
  const epic = db.createTask({ title: "epic" });
  const story = db.createTask({ title: "story", parent: epic.id });
  expect(() => db.updateTask(epic.id, { parent: epic.id })).toThrow(/own parent/);
  expect(() => db.updateTask(epic.id, { parent: story.id })).toThrow(/descendant/);
});

test("updateTask sets and clears a parent", () => {
  const a = db.createTask({ title: "a" });
  const b = db.createTask({ title: "b" });
  expect(db.updateTask(b.id, { parent: a.id }).parentId).toBe(a.id);
  expect(db.updateTask(b.id, { parent: null }).parentId).toBeNull();
});

test("childrenOf returns direct children in position order", () => {
  const epic = db.createTask({ title: "epic" });
  const other = db.createTask({ title: "other" });
  const a = db.createTask({ title: "a", parent: epic.id });
  db.createTask({ title: "b", parent: epic.id });
  db.createTask({ title: "grandchild", parent: a.id });
  expect(db.childrenOf(epic.id).map((t) => t.title)).toEqual(["a", "b"]);
  expect(db.childrenOf(a.id).map((t) => t.title)).toEqual(["grandchild"]);
  expect(db.childrenOf(other.id)).toHaveLength(0);
});

test("deleteTask guards descendants and force cascades the subtree", () => {
  const epic = db.createTask({ title: "epic" });
  const story = db.createTask({ title: "story", parent: epic.id, lane: "plan" });
  db.createTask({ title: "sub", parent: story.id });
  expect(() => db.deleteTask(epic.id)).toThrow(/descendant/);
  db.deleteTask(epic.id, true);
  expect(db.tasks()).toHaveLength(0);
});

test("attach versions per card and kind; latestPlan returns the newest", () => {
  const a = db.createTask({ title: "a" });
  const v1 = db.attach(a.id, "plan", "first draft", "/tmp/p1.md");
  const v2 = db.attach(a.id, "plan", "second draft", "/tmp/p2.md");
  expect(v1.version).toBe(1);
  expect(v2.version).toBe(2);
  expect(db.latestPlan(a.id)!.content).toBe("second draft");
  expect(db.latestPlan(a.id)!.source).toBe("/tmp/p2.md");
  // versions are per kind: another kind starts over
  expect(db.attach(a.id, "brief", "x").version).toBe(1);
  expect(db.latestPlan(a.id)!.version).toBe(2);
});

test("attach rejects unknown tasks and empty content", () => {
  expect(() => db.attach("zzzzz", "plan", "x")).toThrow(/no task/);
  const a = db.createTask({ title: "a" });
  expect(() => db.attach(a.id, "plan", "  ")).toThrow(/empty/);
  expect(db.latestPlan(a.id)).toBeNull();
});

test("latestPlans keys the newest plan per card for the board payload", () => {
  const a = db.createTask({ title: "a" });
  const b = db.createTask({ title: "b" });
  db.attach(a.id, "plan", "v1");
  db.attach(a.id, "plan", "v2");
  db.attach(b.id, "plan", "only");
  const plans = db.latestPlans();
  expect(Object.keys(plans).sort()).toEqual([a.id, b.id].sort());
  expect(plans[a.id]!.content).toBe("v2");
  expect(plans[b.id]!.content).toBe("only");
  expect(db.board().plans[a.id]!.content).toBe("v2");
});

test("deleting a task (or its lane) removes its attachments", () => {
  const a = db.createTask({ title: "a", lane: "plan" });
  const b = db.createTask({ title: "b" });
  db.attach(a.id, "plan", "x");
  db.attach(b.id, "plan", "y");
  db.deleteTask(b.id);
  expect(db.latestPlans()[b.id]).toBeUndefined();
  db.deleteLane("plan", true);
  expect(db.latestPlans()[a.id]).toBeUndefined();
});

test("createComment defaults author/kind and threads read back in order", () => {
  const a = db.createTask({ title: "a" });
  const first = db.createComment(a.id, { body: "first" });
  const second = db.createComment(a.id, { body: "second  ", author: " pi-builder ", kind: "review" });
  expect(first).toMatchObject({ taskId: a.id, author: "user", kind: "comment", body: "first" });
  expect(second).toMatchObject({ author: "pi-builder", kind: "review", body: "second" });
  // rapid-fire inserts may share a millisecond; rowid keeps them in post order
  for (let i = 0; i < 5; i++) db.createComment(a.id, { body: `c${i}` });
  expect(db.comments(a.id).map((c) => c.body)).toEqual(["first", "second", "c0", "c1", "c2", "c3", "c4"]);
  expect(db.comments(a.id)[0]!.createdAt).toBeLessThanOrEqual(db.comments(a.id).at(-1)!.createdAt);
});

test("createComment rejects empty bodies, unknown kinds, unknown tasks", () => {
  const a = db.createTask({ title: "a" });
  expect(() => db.createComment(a.id, { body: "  " })).toThrow(/empty/);
  expect(() => db.createComment(a.id, { body: "x", kind: "shout" })).toThrow(/unknown comment kind/);
  expect(() => db.createComment("zzzzz", { body: "x" })).toThrow(/no task/);
  expect(db.comments(a.id)).toHaveLength(0);
});

test("deleting a task (or its lane) removes its comments", () => {
  const a = db.createTask({ title: "a", lane: "plan" });
  const b = db.createTask({ title: "b" });
  db.createComment(a.id, { body: "x" });
  db.createComment(b.id, { body: "y" });
  db.deleteTask(b.id);
  expect(() => db.comments(b.id)).toThrow(/no task/);
  db.deleteLane("plan", true);
  const raw = new Database(join(dir, "t.db"));
  expect((raw.query("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n).toBe(0);
  raw.close();
});

test("handoff moves the card and records a typed comment atomically", () => {
  const a = db.createTask({ title: "a", lane: "review" });
  const { task, comment } = db.handoff(a.id, "implement", {
    message: "found a bug, back to you",
    author: "pi-reviewer",
    kind: "review",
  });
  expect(task.laneId).toBe("implement");
  expect(comment).toMatchObject({ taskId: a.id, author: "pi-reviewer", kind: "review", body: "found a bug, back to you" });
  expect(db.comments(a.id)).toHaveLength(1);
});

test("handoff findings append checklist lines to the note; blanks are dropped", () => {
  const a = db.createTask({ title: "a", lane: "review", note: "existing" });
  db.handoff(a.id, "implement", { message: "blocked", kind: "review", findings: ["Fix auth src/auth.ts:42", "Add test"] });
  expect(db.resolveTask(a.id).note).toBe("existing\n- [ ] Fix auth src/auth.ts:42\n- [ ] Add test");

  const b = db.createTask({ title: "b", lane: "review", note: "original" });
  db.handoff(b.id, "implement", {
    message: "blocked again",
    kind: "review",
    findings: ["", "  ", "real finding", " trailing kept  "],
  });
  expect(db.resolveTask(b.id).note).toBe("original\n- [ ] real finding\n- [ ] trailing kept");

  const c = db.createTask({ title: "c", lane: "review", note: "untouched" });
  db.handoff(c.id, "implement", { message: "blocked, nothing useful", kind: "review", findings: ["", "   "] });
  expect(db.resolveTask(c.id).note).toBe("untouched");
});

test("a bad handoff message rolls back the lane move and note append", () => {
  const a = db.createTask({ title: "a", lane: "review", note: "original" });
  expect(() => db.handoff(a.id, "done", { message: "   " })).toThrow(/empty/);
  const after = db.resolveTask(a.id);
  expect(after.laneId).toBe("review");
  expect(after.note).toBe("original");
  expect(db.comments(a.id)).toHaveLength(0);
});

test("migrates the prototype plans table into attachments and drops it", () => {
  const path = join(dir, "proto.db");
  new KanbanDb(path).close();
  const raw = new Database(path); // simulate a db carrying the hand-made prototype table
  raw.run(
    "INSERT INTO tasks (id, title, note, lane_id, project, position, created_at, updated_at) VALUES ('abc12', 'proto', '', 'backlog', '', 100, 0, 0)",
  );
  raw.exec(`
    CREATE TABLE plans (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks (id),
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `);
  raw.run(
    "INSERT INTO plans (id, task_id, version, content, source, created_at) VALUES (?, ?, 1, ?, ?, ?)",
    ["8taas", "abc12", "prototype plan", "/tmp/plan.md", Date.now()],
  );
  raw.close();
  const reopened = new KanbanDb(path);
  const plan = reopened.latestPlan("abc12");
  expect(plan?.content).toBe("prototype plan");
  expect(plan?.version).toBe(1);
  expect(plan?.source).toBe("/tmp/plan.md");
  reopened.close();
  const check = new Database(path);
  expect(check.query("SELECT name FROM sqlite_master WHERE type='table' AND name='plans'").all()).toEqual([]);
  check.close();
});

test("deleteLane force removes descendants living in other lanes", () => {
  const story = db.createTask({ title: "story", lane: "plan" });
  db.createTask({ title: "sub", parent: story.id, lane: "done" });
  db.deleteLane("plan", true);
  expect(db.tasks().every((t) => t.parentId === null)).toBe(true);
  expect(db.tasks().some((t) => t.title === "sub")).toBe(false);
});

test("watch fires on writes from another connection and stops on unsubscribe", async () => {
  const waitFor = async (ok: () => boolean, ms = 2000) => {
    const deadline = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > deadline) throw new Error("waitFor timed out");
      await Bun.sleep(5);
    }
  };

  let hits = 0;
  const stop = db.watch(() => hits++, 10);

  const writer = new KanbanDb(join(dir, "t.db")); // a second connection, like the CLI
  writer.createTask({ title: "external write" });
  writer.close();
  await waitFor(() => hits >= 1);

  stop();
  const after = hits;
  const writer2 = new KanbanDb(join(dir, "t.db"));
  writer2.createTask({ title: "after stop" });
  writer2.close();
  await Bun.sleep(100);
  expect(hits).toBe(after);
});
