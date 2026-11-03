import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { DEFAULT_LANES, PLAN_REVIEWER_AUTHOR, BUILDER_AUTHOR, KanbanDb, KanbanError, defaultLaneContext, type LaneContext } from "../src/db";

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

  expect(() => db.setAgentConfig("chief", {})).toThrow(KanbanError);
});

test("pools: set → list → replace → delete; caps and field trimming", () => {
  expect(db.pools()).toEqual([]);

  const saved = db.setPool("heavy", {
    name: " heavy ",
    enabled: true,
    roles: ["builder", "builder"],
    slots: [
      { provider: " anthropic ", model: " claude-3-5-sonnet ", thinking: "max" },
      { provider: "", model: " ", thinking: "" },
    ],
  });

  expect(saved).toEqual({
    id: "heavy",
    name: "heavy",
    enabled: true,
    roles: ["builder"],
    slots: [{ provider: "anthropic", model: "claude-3-5-sonnet", thinking: "max" }, {}],
    updatedAt: expect.any(Number),
  });

  expect(db.pools()).toEqual([saved]);

  // replace updates fields
  const replaced = db.setPool("heavy", {
    name: "heavy-renamed",
    enabled: false,
    roles: ["builder", "reviewer"],
    slots: [{ model: "claude-haiku" }],
  });
  expect(replaced.name).toBe("heavy-renamed");
  expect(replaced.enabled).toBe(false);
  expect(replaced.roles).toEqual(["builder", "reviewer"]);
  expect(replaced.slots).toEqual([{ model: "claude-haiku" }]);
  // disabled pools still list in pools()
  expect(db.pools()).toEqual([replaced]);

  // Validation: empty name
  expect(() =>
    db.setPool("p1", { name: "   ", roles: ["builder"], slots: [{ model: "m" }] }),
  ).toThrow(new KanbanError("pool name must not be empty", "invalid"));

  // Validation: unknown role
  expect(() =>
    db.setPool("p1", { name: "p1", roles: ["unknown" as any], slots: [{ model: "m" }] }),
  ).toThrow(new KanbanError("pool 'p1' must serve 1-4 known roles", "invalid"));

  // Validation: empty roles
  expect(() =>
    db.setPool("p1", { name: "p1", roles: [], slots: [{ model: "m" }] }),
  ).toThrow(new KanbanError("pool 'p1' must serve 1-4 known roles", "invalid"));

  // Fully-inherit slots are valid parallel lanes; only field values trim
  const inheritOnly = db.setPool("p1", {
    name: "p1",
    roles: ["builder"],
    slots: [{ provider: "", model: " ", thinking: "" }],
  });
  expect(inheritOnly.slots).toEqual([{}]);

  // Validation: empty slots array
  expect(() =>
    db.setPool("p-empty", { name: "p-empty", roles: ["builder"], slots: [] }),
  ).toThrow(new KanbanError("pool 'p-empty' must have 1-8 slots", "invalid"));

  // Validation: 9 slots
  const nineSlots = Array.from({ length: 9 }, (_, i) => ({ model: `m-${i}` }));
  expect(() =>
    db.setPool("p1", { name: "p1", roles: ["builder"], slots: nineSlots }),
  ).toThrow(new KanbanError("pool 'p1' must have 1-8 slots", "invalid"));

  // Caps: 13th enabled slot board-wide rejected, but disabled pools don't count
  // First, create pool1 with 8 enabled slots
  const eightSlots = Array.from({ length: 8 }, (_, i) => ({ model: `m-${i}` }));
  db.setPool("p1", { name: "pool 1", enabled: true, roles: ["builder"], slots: eightSlots });

  // Creating a disabled pool with 8 slots works (disabled doesn't count toward 12)
  db.setPool("p-disabled", { name: "disabled pool", enabled: false, roles: ["planner"], slots: eightSlots });

  // Creating an enabled pool with 5 slots would make total = 8 + 5 = 13 > 12 -> throws
  const fiveSlots = Array.from({ length: 5 }, (_, i) => ({ model: `m2-${i}` }));
  expect(() =>
    db.setPool("p2", { name: "pool 2", enabled: true, roles: ["reviewer"], slots: fiveSlots }),
  ).toThrow(new KanbanError("board-wide enabled slots would exceed 12", "invalid"));

  // But 4 enabled slots makes total = 8 + 4 = 12 <= 12 -> succeeds
  const fourSlots = Array.from({ length: 4 }, (_, i) => ({ model: `m2-${i}` }));
  db.setPool("p2", { name: "pool 2", enabled: true, roles: ["reviewer"], slots: fourSlots });

  // deletePool on missing id throws not-found
  expect(() => db.deletePool("non-existent")).toThrow(new KanbanError("no pool 'non-existent'", "not-found"));

  // deletePool removes the pool
  db.deletePool("p1");
  expect(db.pools().map((p) => p.id)).not.toContain("p1");
});

test("board max workers: default 12, set/get round-trip, rejects out-of-range", () => {
  expect(db.maxWorkers()).toBe(12);

  expect(db.setMaxWorkers(5)).toBe(5);
  expect(db.maxWorkers()).toBe(5);

  expect(db.setMaxWorkers(1)).toBe(1);
  expect(db.maxWorkers()).toBe(1);

  expect(db.setMaxWorkers(20)).toBe(20);
  expect(db.maxWorkers()).toBe(20);

  expect(() => db.setMaxWorkers(0)).toThrow(new KanbanError("max workers must be between 1 and 20", "invalid"));
  expect(() => db.setMaxWorkers(21)).toThrow(new KanbanError("max workers must be between 1 and 20", "invalid"));
  expect(() => db.setMaxWorkers(2.5)).toThrow(new KanbanError("max workers must be between 1 and 20", "invalid"));
});

test("pool maxWorkers: absent means slot count, validation clamps to slots", () => {
  const threeSlots = [{ model: "m-0" }, { model: "m-1" }, { model: "m-2" }];

  const savedWithCap = db.setPool("p1", {
    name: "pool 1",
    roles: ["builder"],
    slots: threeSlots,
    maxWorkers: 2,
  });
  expect(savedWithCap.maxWorkers).toBe(2);
  expect(db.pools()[0].maxWorkers).toBe(2);
  expect(db.pool("p1")?.maxWorkers).toBe(2);

  const savedWithoutCap = db.setPool("p2", {
    name: "pool 2",
    roles: ["reviewer"],
    slots: threeSlots,
  });
  expect("maxWorkers" in savedWithoutCap).toBe(false);
  expect("maxWorkers" in db.pools()[1]).toBe(false);
  expect("maxWorkers" in db.pool("p2")!).toBe(false);

  expect(() =>
    db.setPool("p1", { name: "pool 1", roles: ["builder"], slots: threeSlots, maxWorkers: 0 }),
  ).toThrow(new KanbanError("pool 'p1' maxWorkers must be between 1 and 3 (its slot count)", "invalid"));

  expect(() =>
    db.setPool("p1", { name: "pool 1", roles: ["builder"], slots: threeSlots, maxWorkers: 4 }),
  ).toThrow(new KanbanError("pool 'p1' maxWorkers must be between 1 and 3 (its slot count)", "invalid"));

  expect(() =>
    db.setPool("p1", { name: "pool 1", roles: ["builder"], slots: threeSlots, maxWorkers: 2.5 }),
  ).toThrow(new KanbanError("pool 'p1' maxWorkers must be between 1 and 3 (its slot count)", "invalid"));
});

test("setCardSession/cardSession roundtrip; deleteTask clears pointer and request", () => {
  const task = db.createTask({ title: "session-test" });
  expect(db.cardSession(task.id)).toBeNull();

  db.setCardSession(task.id, "builder", "kanban-test-1");
  expect(db.cardSession(task.id)).toEqual({ role: "builder", sessionId: "kanban-test-1" });

  // upsert overwrites role+id
  db.setCardSession(task.id, "reviewer", "kanban-test-2");
  expect(db.cardSession(task.id)).toEqual({ role: "reviewer", sessionId: "kanban-test-2" });

  db.queueResume(task.id);
  expect(db.resumeRequests()).toEqual([{ taskId: task.id, requestedAt: expect.any(Number) }]);

  db.deleteTask(task.id);
  expect(db.cardSession(task.id)).toBeNull();
  expect(db.resumeRequests()).toEqual([]);
});

test("approveTask: approval comment + move to implement; guards lane and plan; works on a card parked from plan", () => {
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

  // a passing review parked the card in waiting — the gate still works from there
  const parked = db.createTask({ title: "parked gate" });
  db.moveTask(parked.id, "plan");
  db.attach(parked.id, "plan", "# plan v1");
  db.planReview(parked.id, { verdict: "pass", message: "checks out", author: "pi-plan-reviewer" });
  expect(db.resolveTask(parked.id).laneId).toBe("waiting");
  const { task: unparked } = db.approveTask(parked.id);
  expect(unparked.laneId).toBe("implement");
  expect(db.resolveTask(parked.id).previousLane).toBeNull(); // the gate clears the park
});

test("rejectTask: feedback comment, card ends in plan (a parked card returns first); empty feedback rejected", () => {
  const task = db.createTask({ title: "feature" });
  db.moveTask(task.id, "plan");
  db.attach(task.id, "plan", "# plan v1");
  const { comment } = db.rejectTask(task.id, "  use SSE, not polling  ");
  expect(comment.kind).toBe("rejection");
  expect(comment.body).toBe("plan rejected: use SSE, not polling");
  expect(db.resolveTask(task.id).laneId).toBe("plan"); // stays put — re-plan expected
  expect(() => db.rejectTask(task.id, "   ")).toThrow(/must not be empty/);
  expect(() => db.rejectTask(db.createTask({ title: "x" }).id, "why")).toThrow(/not in the plan lane/);

  // rejecting a card parked by a passing review returns it to plan for the re-armed planner
  db.planReview(task.id, { verdict: "pass", message: "checks out", author: "pi-plan-reviewer" });
  expect(db.resolveTask(task.id).laneId).toBe("waiting");
  const { task: returned, returned: moved } = db.rejectTask(task.id, "use SSE, not polling");
  expect(moved).toBe(true);
  expect(returned.laneId).toBe("plan");
  expect(db.resolveTask(task.id).previousLane).toBeNull();
});

test("planReview: pass parks the card in waiting, block leaves it in plan; lane, plan and message guards", () => {
  const task = db.createTask({ title: "feature" });
  db.moveTask(task.id, "plan");
  db.attach(task.id, "plan", "# plan v1");
  const { comment: pass, task: parked } = db.planReview(task.id, { verdict: "pass", message: "checks out", author: "pi-plan-reviewer" });
  expect(pass.kind).toBe("review");
  expect(pass.author).toBe("pi-plan-reviewer");
  expect(pass.body).toBe("plan review: pass — checks out");
  expect(parked.laneId).toBe("waiting"); // pass parks it at the human gate
  expect(parked.previousLane).toBe("plan");
  expect(db.waiting(task.id)).toBe("gate");

  // a human reply returns the parked card to the plan-lane gate
  const { task: returned, moved } = db.comment(task.id, { author: "user", body: "looks good" });
  expect(moved).toBe("returned");
  expect(returned.laneId).toBe("plan");
  expect(returned.previousLane).toBeNull();

  const { comment: block } = db.planReview(task.id, { verdict: "block", message: "vague tests", findings: ["AC2 has no test", "step 3 has no target file"] });
  expect(block.body).toBe("plan review: block — vague tests\n- AC2 has no test\n- step 3 has no target file");
  expect(block.author).toBe("user"); // author defaults like any comment
  expect(db.resolveTask(task.id).laneId).toBe("plan"); // block stays for the planner

  const { comment: findingsOnly } = db.planReview(task.id, { verdict: "block", findings: ["only finding"] });
  expect(findingsOnly.body).toBe("plan review: block\n- only finding");

  const bare = db.createTask({ title: "no plan" });
  db.moveTask(bare.id, "plan");
  expect(() => db.planReview(bare.id, { verdict: "pass" })).toThrow(/no attached plan/);
  const movedOn = db.createTask({ title: "moved on" });
  db.moveTask(movedOn.id, "plan");
  db.attach(movedOn.id, "plan", "# p");
  db.approveTask(movedOn.id);
  expect(() => db.planReview(movedOn.id, { verdict: "pass" })).toThrow(/not in the plan lane/);
  expect(() => db.planReview(task.id, { verdict: "pass", message: "  " })).toThrow(/needs a message/);
  expect(() => db.planReview(task.id, { verdict: "block", message: "", findings: [] })).toThrow(/needs a message/);
});

test("comment kinds include the plan-gate pair and the planner's question", () => {
  const task = db.createTask({ title: "kinds" });
  for (const kind of ["comment", "review", "handoff", "approval", "rejection", "question"] as const) {
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

test("attach enforces the card-file name rule", () => {
  const task = db.createTask({ title: "one" });
  for (const bad of ["Design", "repro log", "a/b", "../x", "-lead", "x.md.md", "", "a".repeat(49), "x.MD"]) {
    expect(() => db.attach(task.id, bad, "content")).toThrow(/invalid file name/);
  }
  for (const good of ["plan", "session", "design", "design.md", "repro-log-2", "repro-log-2.txt", "a".repeat(48), "7"]) {
    expect(db.attach(task.id, good, `content of ${good}`).kind).toBe(good);
  }
});

test("card files version independently per name; latestFiles lists latest per name, sessions excluded", () => {
  const task = db.createTask({ title: "one" });
  db.attach(task.id, "plan", "# v1");
  db.attach(task.id, "design", "v1");
  db.attach(task.id, "design", "v2");
  db.attach(task.id, "repro-log.txt", "v1");
  db.attach(task.id, "session", "agent log", "autoreview");

  expect(db.attachments(task.id, "design").map((a) => a.version)).toEqual([1, 2]);
  expect(db.attachments(task.id, "repro-log.txt").map((a) => a.version)).toEqual([1]); // separate sequence
  expect(db.attachment(task.id, "design")!.content).toBe("v2");

  const files = db.latestFiles(task.id);
  expect(files.map((f) => f.kind)).toEqual(["design", "plan", "repro-log.txt"]); // name-ordered, no session
  expect(files.map((f) => f.version)).toEqual([2, 1, 1]);
  expect(db.latestFiles(db.createTask({ title: "empty" }).id)).toEqual([]);
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

test("waiting lane: seeds first, fixed, and migrates existing boards", () => {
  const freshLanes = db.lanes();
  expect(freshLanes[0].id).toBe("waiting");
  expect(freshLanes[0].fixed).toBe(1);
  expect(freshLanes[1].id).toBe("backlog");
  expect(() => db.deleteLane("waiting")).toThrow(/fixed/);

  // Pre-existing DB without waiting lane regains it at position 0 (min / 2)
  const path = join(dir, "pre-waiting.db");
  new KanbanDb(path).close();
  const raw = new Database(path);
  raw.run("DELETE FROM lanes WHERE id = 'waiting'");
  raw.close();
  const reopened = new KanbanDb(path);
  const reLanes = reopened.lanes();
  expect(reLanes[0].id).toBe("waiting");
  expect(reLanes[0].fixed).toBe(1);
  expect(reLanes[0].position).toBeLessThan(reLanes[1].position);
  reopened.close();

  // Pre-existing custom waiting lane is adopted and marked fixed
  const path2 = join(dir, "custom-waiting.db");
  const raw2 = new Database(path2);
  raw2.exec(`
    CREATE TABLE lanes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      position REAL NOT NULL, fixed INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO lanes (id, name, description, position, fixed) VALUES ('waiting', 'Custom Waiting', 'custom', 50, 0);
  `);
  raw2.close();
  const adopted = new KanbanDb(path2);
  const adoptedWaiting = adopted.resolveLane("waiting");
  expect(adoptedWaiting.fixed).toBe(1);
  adopted.close();
});

test("wip limit: set → roundtrip → clear; invalid values rejected", () => {
  expect(db.lanes().every((l) => l.wipLimit === null)).toBe(true);
  const lane = db.updateLane("implement", { wipLimit: 3 });
  expect(lane.wipLimit).toBe(3);
  expect(db.lanes().find((l) => l.id === "implement")?.wipLimit).toBe(3);
  db.updateLane("implement", { name: "Test + Implement" });
  expect(db.lanes().find((l) => l.id === "implement")?.wipLimit).toBe(3);
  db.updateLane("implement", { wipLimit: null });
  expect(db.lanes().find((l) => l.id === "implement")?.wipLimit).toBeNull();
  for (const bad of [0, 1.5, 1000, "3" as any]) {
    expect(() => db.updateLane("implement", { wipLimit: bad })).toThrow(
      new KanbanError("wip limit must be an integer from 1 to 999 (or null to clear)", "invalid"),
    );
  }
  expect(db.updateLane("review", { wipLimit: 1 }).wipLimit).toBe(1);
  expect(db.updateLane("review", { wipLimit: 999 }).wipLimit).toBe(999);
  db.updateLane("review", { wipLimit: null });
});

test("adds the wip_limit column when reopening a board that predates it", () => {
  const path = join(dir, "oldwip.db");
  const raw = new Database(path); // simulate a board written before wip_limit existed
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
      VALUES ('wip34', 'legacy', '', 'todo', '', 100, 0, 0);
  `);
  raw.close();
  const reopened = new KanbanDb(path);
  const todo = reopened.lanes().find((l) => l.id === "todo");
  expect(todo?.wipLimit).toBeNull();
  expect(reopened.updateLane("todo", { wipLimit: 2 }).wipLimit).toBe(2);
  expect(reopened.lanes().find((l) => l.id === "todo")?.wipLimit).toBe(2);
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
  expect(db.resolveLane("3").name).toBe("Plan");
  expect(db.resolveLane("4").name).toBe("Test + Implement");
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

test("moveLane: before-anchor and last round-trip; order persists via lanes()", () => {
  db.createLane({ name: "Staging" });
  expect(db.lanes().map((l) => l.id)).toEqual(["waiting", "backlog", "plan", "implement", "review", "done", "archive", "staging"]);

  const moved = db.moveLane("staging", "review");
  expect(moved.id).toBe("staging");
  expect(db.lanes().map((l) => l.id)).toEqual(["waiting", "backlog", "plan", "implement", "staging", "review", "done", "archive"]);

  db.moveLane("staging", null); // null anchor = literal last
  expect(db.lanes().map((l) => l.id).at(-1)).toBe("staging");

  // anchors resolve like every other lane ref (name and ordinal forms)
  expect(db.moveLane("staging", "Done").id).toBe("staging");
  expect(db.lanes().map((l) => l.id)).toEqual(["waiting", "backlog", "plan", "implement", "review", "staging", "done", "archive"]);

  const path = join(dir, "t.db");
  db.close();
  const reopened = new KanbanDb(path);
  expect(reopened.lanes().map((l) => l.id)).toEqual(["waiting", "backlog", "plan", "implement", "review", "staging", "done", "archive"]);
  reopened.close();
  db = new KanbanDb(path);
});

test("fixed lanes refuse reorder and delete; self-anchor and index+before refused", () => {
  expect(() => db.moveLane("waiting", "review")).toThrow(/lane 'waiting' is fixed and cannot be reordered/);
  expect(() => db.updateLane("done", { index: 0 })).toThrow(/is fixed and cannot be reordered/);
  expect(() => db.moveLane("archive", null)).toThrow(/is fixed and cannot be reordered/);
  expect(() => db.deleteLane("waiting")).toThrow(/lane 'waiting' is fixed and cannot be deleted/);
  expect(() => db.moveLane("review", "review")).toThrow(/lane 'review' cannot be moved before itself/);
  expect(() => db.updateLane("review", { index: 1, before: "plan" })).toThrow(/pass either index or before, not both/);
  // anchors may be fixed lanes — only the moved lane's fixedness is refused
  expect(db.moveLane("review", "done").id).toBe("review");
  expect(db.lanes().map((l) => l.id)).toEqual(["waiting", "backlog", "plan", "implement", "review", "done", "archive"]);
});

test("lane positions renormalize to GAP spacing when squeezed", () => {
  const raw = new Database(join(dir, "t.db"));
  raw.run("UPDATE lanes SET position = 100.005 WHERE id = 'plan'");
  raw.run("UPDATE lanes SET position = 100.01 WHERE id = 'implement'");
  raw.close();

  db.moveLane("review", "plan"); // a reorder write triggers the renormalize
  const positions = db.lanes().map((l) => l.position);
  expect(positions.length).toBeGreaterThan(2);
  for (let i = 1; i < positions.length; i++) {
    expect(positions[i] - positions[i - 1]).toBeCloseTo(100);
  }
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

test("boardViolations reports all three kinds", () => {
  // Healthy controls first:
  // 1. childless done card
  db.createTask({ title: "childless-done", lane: "done" });
  // 2. done child under done parent
  const doneParent = db.createTask({ title: "done-parent", lane: "done" });
  db.createTask({ title: "done-child", parent: doneParent.id, lane: "done" });
  // 3. implement card with plan
  const plannedCard = db.createTask({ title: "planned-card", lane: "implement" });
  db.attach(plannedCard.id, "plan", "plan text");
  // 4. child ahead of parent (e.g. child in implement, parent in plan)
  const planParent = db.createTask({ title: "plan-parent", lane: "plan" });
  const aheadChild = db.createTask({ title: "ahead-child", parent: planParent.id, lane: "implement" });
  db.attach(aheadChild.id, "plan", "plan text");
  expect(db.boardViolations()).toEqual([]);

  // Now seed the three violations:
  // (a) done epic with backlog child
  const epicA = db.createTask({ title: "epic-a", lane: "done" });
  const childA = db.createTask({ title: "child-a", parent: epicA.id, lane: "backlog" });

  // (b) implement parent (with plan) with backlog child
  const parentB = db.createTask({ title: "parent-b", lane: "implement" });
  db.attach(parentB.id, "plan", "plan for b");
  const childB = db.createTask({ title: "child-b", parent: parentB.id, lane: "backlog" });

  // (c) implement card without plan
  const cardC = db.createTask({ title: "card-c", lane: "implement" });

  const violations = db.boardViolations();
  expect(violations).toEqual([
    {
      kind: "done-parent-active-children",
      cardId: epicA.id,
      childIds: [childA.id],
    },
    {
      kind: "child-behind-parent",
      cardId: childB.id,
      parentId: parentB.id,
      cardLaneId: "backlog",
      parentLaneId: "implement",
    },
    {
      kind: "missing-plan",
      cardId: cardC.id,
      laneId: "implement",
    },
  ]);
});

test("boardViolations reports wip-over-limit per over lane", () => {
  // No limits set anywhere → unchanged clean-board behavior.
  expect(db.boardViolations()).toEqual([]);

  db.updateLane("implement", { wipLimit: 2 });
  const a = db.createTask({ title: "wip-a", lane: "implement" });
  const b = db.createTask({ title: "wip-b", lane: "implement" });
  db.attach(a.id, "plan", "p");
  db.attach(b.id, "plan", "p");
  // At exactly the limit → no violation.
  expect(db.boardViolations()).toEqual([]);

  const c = db.createTask({ title: "wip-c", lane: "implement" });
  db.attach(c.id, "plan", "p");
  expect(db.boardViolations()).toEqual([
    { kind: "wip-over-limit", laneId: "implement", limit: 2, count: 3 },
  ]);

  // Second limited lane adds its own violation, in board-lane order (review after implement).
  const r1 = db.createTask({ title: "wip-r1", lane: "review" });
  const r2 = db.createTask({ title: "wip-r2", lane: "review" });
  db.attach(r1.id, "plan", "p");
  db.attach(r2.id, "plan", "p");
  db.updateLane("review", { wipLimit: 1 });
  expect(db.boardViolations()).toEqual([
    { kind: "wip-over-limit", laneId: "implement", limit: 2, count: 3 },
    { kind: "wip-over-limit", laneId: "review", limit: 1, count: 2 },
  ]);
});

test("boardViolations on a clean board is empty; activeChildren excludes done/archive", () => {
  const parent = db.createTask({ title: "parent", lane: "backlog" });
  const childBacklog = db.createTask({ title: "child-backlog", parent: parent.id, lane: "backlog" });
  const childDone = db.createTask({ title: "child-done", parent: parent.id, lane: "done" });
  const childArchive = db.createTask({ title: "child-archive", parent: parent.id, lane: "archive" });

  expect(db.activeChildren(parent.id).map((t) => t.id)).toEqual([childBacklog.id]);

  // Clean board check: parent in backlog, children in backlog/done/archive
  expect(db.boardViolations()).toEqual([]);

  // Move parent to done while childBacklog is still active
  db.moveTask(parent.id, "done");
  expect(db.boardViolations()).toEqual([
    {
      kind: "done-parent-active-children",
      cardId: parent.id,
      childIds: [childBacklog.id],
    },
  ]);

  // Move childBacklog to done -> now board is clean again
  db.moveTask(childBacklog.id, "done");
  expect(db.activeChildren(parent.id)).toEqual([]);
  expect(db.boardViolations()).toEqual([]);
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

test("waiting maps the plan-lane thread's last comment to all five states", () => {
  const task = db.createTask({ title: "w", lane: "plan" });
  db.attach(task.id, "plan", "# p");

  // gate: reviewer pass verdict (which parks the card in waiting)
  db.planReview(task.id, { verdict: "pass", message: "checks out", author: PLAN_REVIEWER_AUTHOR });
  expect(db.waiting(task.id)).toBe("gate");
  db.moveTask(task.id, "plan"); // return it for the rest of the state sequence

  // question: planner asking (kind question)
  db.createComment(task.id, { author: "pi-planner", kind: "question", body: "sse or polling?" });
  expect(db.waiting(task.id)).toBe("question");

  // rerun: reviewer failure body (autoreview afterJob)
  db.createComment(task.id, {
    author: PLAN_REVIEWER_AUTHOR,
    kind: "comment",
    body: "plan review failed (exit 1) — approve or reject the plan directly, or comment on this card to re-run the review.",
  });
  expect(db.waiting(task.id)).toBe("rerun");

  // rerun: reviewer cannot-evaluate body
  db.createComment(task.id, { author: PLAN_REVIEWER_AUTHOR, kind: "comment", body: "cannot evaluate the plan — no checklist verdict" });
  expect(db.waiting(task.id)).toBe("rerun");

  // capped: reviewer cap body (autoreview plan-capped)
  db.createComment(task.id, {
    author: PLAN_REVIEWER_AUTHOR,
    kind: "comment",
    body: `plan review cap reached: blocked 2× since the last human comment — the latest plan waits at the gate with open findings. kanban reject ${task.id} --message <feedback> to re-plan, or comment to re-run the review.`,
  });
  expect(db.waiting(task.id)).toBe("capped");

  // capped: the same cap body as a question comment — the loop parks via db.comment (kind question), and the parked card still badges capped
  db.createComment(task.id, {
    author: PLAN_REVIEWER_AUTHOR,
    kind: "question",
    body: `plan review cap reached: blocked 2× since the last human comment — the latest plan waits at the gate with open findings. kanban reject ${task.id} --message <feedback> to re-plan, or comment to re-run the review.`,
  });
  expect(db.waiting(task.id)).toBe("capped");

  // null: block verdict — the planner or cap comment takes the next turn
  db.planReview(task.id, { verdict: "block", message: "vague tests" });
  expect(db.waiting(task.id)).toBeNull();

  // null: planner handoff
  db.createComment(task.id, { author: "pi-planner", kind: "handoff", body: "plan v2 attached — over to pi-plan-reviewer" });
  expect(db.waiting(task.id)).toBeNull();

  // null: planner-failure comment (known gap — spec maps only pi-plan-reviewer comments to rerun)
  db.createComment(task.id, { author: "pi-planner", kind: "comment", body: "auto-plan failed (exit 1) — comment on this card to re-trigger." });
  expect(db.waiting(task.id)).toBeNull();

  // last comment wins: pass, then a newer human comment → null
  db.planReview(task.id, { verdict: "pass", message: "ok again", author: PLAN_REVIEWER_AUTHOR });
  expect(db.waiting(task.id)).toBe("gate");
  db.createComment(task.id, { author: "user", kind: "comment", body: "use the defaults" });
  expect(db.waiting(task.id)).toBeNull();

  // null: empty thread
  const fresh = db.createTask({ title: "fresh", lane: "plan" });
  expect(db.waiting(fresh.id)).toBeNull();
});

test("waiting is null outside the plan lane whatever the thread says", () => {
  const backlog = db.createTask({ title: "b" });
  db.createComment(backlog.id, { author: "pi-planner", kind: "question", body: "hmm?" });
  expect(db.waiting(backlog.id)).toBeNull();

  const impl = db.createTask({ title: "i", lane: "implement" });
  db.createComment(impl.id, { author: PLAN_REVIEWER_AUTHOR, kind: "review", body: "plan review: pass — ok" });
  expect(db.waiting(impl.id)).toBeNull();

  const parked = db.createTask({ title: "p", lane: "waiting" });
  db.createComment(parked.id, { author: "pi-planner", kind: "question", body: "hmm?" });
  expect(db.waiting(parked.id)).toBe("question");
});

test("session-death comments mark a card dead on any lane", () => {
  const reviewCard = db.createTask({ title: "r", lane: "review" });
  db.createComment(reviewCard.id, {
    author: "pi-reviewer",
    kind: "comment",
    body: `${KanbanDb.SESSION_DIED_PREFIX}auto-review ended without a verdict after 8s — model returned no output; comment on this card to re-trigger.`,
  });
  expect(db.waiting(reviewCard.id)).toBe("dead");
  expect(db.board().waiting[reviewCard.id]).toBe("dead");

  const planCard = db.createTask({ title: "p", lane: "plan" });
  db.createComment(planCard.id, {
    author: "pi-planner",
    kind: "comment",
    body: `${KanbanDb.SESSION_DIED_PREFIX}auto-plan failed (exit 1) after 4s — comment on this card to re-trigger.`,
  });
  expect(db.waiting(planCard.id)).toBe("dead");
  expect(db.board().waiting[planCard.id]).toBe("dead");

  // same reviewer comment without the prefix on a review-lane card → null
  const benignReview = db.createTask({ title: "benign", lane: "review" });
  db.createComment(benignReview.id, {
    author: "pi-reviewer",
    kind: "comment",
    body: "could not locate the work in this repo — needs manual review",
  });
  expect(db.waiting(benignReview.id)).toBeNull();
  expect(db.board().waiting[benignReview.id]).toBeUndefined();
});

test("board() ships a sparse waiting map keyed by task id", () => {
  const gate = db.createTask({ title: "g", lane: "plan" });
  db.attach(gate.id, "plan", "# g");
  db.planReview(gate.id, { verdict: "pass", message: "ok", author: PLAN_REVIEWER_AUTHOR });
  const question = db.createTask({ title: "q", lane: "plan" });
  db.createComment(question.id, { author: "pi-planner", kind: "question", body: "sse?" });
  const parked = db.createTask({ title: "parked", lane: "waiting" });
  db.createComment(parked.id, { author: "pi-planner", kind: "question", body: "which?" });
  const idle = db.createTask({ title: "idle", lane: "plan" }); // plan lane, nothing owed
  const backlog = db.createTask({ title: "x" }); // question shape, wrong lane
  db.createComment(backlog.id, { author: "pi-planner", kind: "question", body: "ignored" });

  const { waiting } = db.board();
  expect(waiting).toEqual({ [gate.id]: "gate", [question.id]: "question", [parked.id]: "question" });
  expect(waiting).toEqual(db.waitingStates());
  expect(waiting[backlog.id]).toBeUndefined();
  expect(waiting[idle.id]).toBeUndefined();
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

// ---------- agent session leases ----------

test("lease: first taker wins, second live owner refused", () => {
  const a = { pid: 1, bootId: 100 };
  const b = { pid: 2, bootId: 200 };
  expect(db.tryTakeLease("t1", "planner", a, 60_000)).toBe(true);
  expect(db.tryTakeLease("t1", "planner", b, 60_000)).toBe(false);
});

test("lease: heartbeat keeps it held, stale lease is reclaimable", () => {
  const a = { pid: 1, bootId: 100 };
  const b = { pid: 2, bootId: 200 };
  expect(db.tryTakeLease("t1", "planner", a, 60_000)).toBe(true);
  db.heartbeatLease("t1", a); // fresh beat → still held
  expect(db.tryTakeLease("t1", "planner", b, 60_000)).toBe(false);
  expect(db.tryTakeLease("t1", "planner", b, 0)).toBe(true); // ttl 0 → any age is stale
  expect(db.leaseFor("t1", 0)).toBeNull(); // stale lease filtered out
  expect(db.leaseFor("t1")).not.toBeNull(); // raw lookup finds the row
  expect(db.leaseFor("t1", 60_000)).not.toBeNull(); // within TTL is live
});

test("lease: release frees the card; releaseLeases only drops own rows", () => {
  const a = { pid: 1, bootId: 100 };
  const b = { pid: 2, bootId: 200 };
  expect(db.tryTakeLease("t1", "planner", a, 60_000)).toBe(true);
  expect(db.tryTakeLease("t2", "reviewer", b, 60_000)).toBe(true);
  db.releaseLease("t1", a);
  expect(db.tryTakeLease("t1", "reviewer", b, 60_000)).toBe(true);
  db.releaseLeases(a);
  expect(db.leaseFor("t2")?.ownerPid).toBe(2); // b's lease untouched
  expect(db.tryTakeLease("t1", "planner", a, 60_000)).toBe(false); // b holds t1 with a fresh heartbeat
  db.releaseLease("t1", b);
  expect(db.tryTakeLease("t1", "planner", a, 60_000)).toBe(true);
});

// ---------- next task ----------

test("nextTask: lane priority review → implement → plan → backlog, oldest first", () => {
  const tBacklog = db.createTask({ title: "backlog card", lane: "backlog" });
  const tPlan = db.createTask({ title: "plan card", lane: "plan" });
  const tImplement = db.createTask({ title: "implement card", lane: "implement" });
  const tReview = db.createTask({ title: "review card", lane: "review" });

  // With cards in all four lanes, returns review card even when backlog was created first
  expect(db.nextTask().task?.id).toBe(tReview.id);

  // After moving each winner to done, walks implement → plan → backlog → null
  db.moveTask(tReview.id, "done");
  expect(db.nextTask().task?.id).toBe(tImplement.id);

  db.moveTask(tImplement.id, "done");
  expect(db.nextTask().task?.id).toBe(tPlan.id);

  db.moveTask(tPlan.id, "done");
  expect(db.nextTask().task?.id).toBe(tBacklog.id);

  db.moveTask(tBacklog.id, "done");
  expect(db.nextTask().task).toBeNull();

  // Within one lane, smaller created_at wins
  const a = db.createTask({ title: "a", lane: "backlog" });
  const b = db.createTask({ title: "b", lane: "backlog" });
  const raw = new Database(join(dir, "t.db"));
  raw.run("UPDATE tasks SET created_at = 1000 WHERE id = ?", [b.id]);
  raw.run("UPDATE tasks SET created_at = 2000 WHERE id = ?", [a.id]);
  raw.close();
  expect(db.nextTask().task?.id).toBe(b.id);
});

test("nextTask: project filter; done, archive and custom lanes never proposed", () => {
  const revB = db.createTask({ title: "review b", lane: "review", project: "b" });
  const backA = db.createTask({ title: "backlog a", lane: "backlog", project: "a" });

  // Project filter
  expect(db.nextTask("a").task?.id).toBe(backA.id);
  expect(db.nextTask("b").task?.id).toBe(revB.id);
  expect(db.nextTask().task?.id).toBe(revB.id);

  // done/archive cards never win over any priority lane
  db.moveTask(revB.id, "done");
  db.moveTask(backA.id, "archive");
  expect(db.nextTask().task).toBeNull();

  // Custom lane card is never returned
  const customLane = db.createLane({ name: "Parking Lot" });
  db.createTask({ title: "custom", lane: customLane.id });
  expect(db.nextTask().task).toBeNull();

  // On a board whose review lane was removed, returns the implement card
  const imp = db.createTask({ title: "implement", lane: "implement" });
  db.deleteLane("review");
  expect(db.nextTask().task?.id).toBe(imp.id);
});

test("lane_events: creation event + capture on every writer path; none for same-lane moves", () => {
  const t = db.createTask({ title: "card 1", lane: "backlog" });
  let events = db.laneEvents(t.id);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    taskId: t.id,
    fromLaneId: null,
    toLaneId: "backlog",
    cause: "create",
    actor: "user",
  });

  // moveTask (mv cause)
  db.moveTask(t.id, "plan");
  events = db.laneEvents(t.id);
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({
    taskId: t.id,
    fromLaneId: "backlog",
    toLaneId: "plan",
    cause: "mv",
    actor: "user",
  });

  // approveTask (cause "approve", actor)
  db.attach(t.id, "plan", "plan body");
  db.approveTask(t.id, { author: "alice" });
  events = db.laneEvents(t.id);
  expect(events).toHaveLength(3);
  expect(events[2]).toMatchObject({
    taskId: t.id,
    fromLaneId: "plan",
    toLaneId: "implement",
    cause: "approve",
    actor: "alice",
  });

  // handoff (cause "handoff")
  db.handoff(t.id, "review", { author: "bob", message: "ready for review" });
  events = db.laneEvents(t.id);
  expect(events).toHaveLength(4);
  expect(events[3]).toMatchObject({
    taskId: t.id,
    fromLaneId: "implement",
    toLaneId: "review",
    cause: "handoff",
    actor: "bob",
  });

  // review-block handoff (cause "review")
  db.handoff(t.id, "implement", { kind: "review", author: "pi-reviewer", message: "blocked" });
  events = db.laneEvents(t.id);
  expect(events).toHaveLength(5);
  expect(events[4]).toMatchObject({
    taskId: t.id,
    fromLaneId: "review",
    toLaneId: "implement",
    cause: "review",
    actor: "pi-reviewer",
  });

  // moveTask (done cause)
  db.moveTask(t.id, "done", undefined, { cause: "done" });
  events = db.laneEvents(t.id);
  expect(events).toHaveLength(6);
  expect(events[5]).toMatchObject({
    taskId: t.id,
    fromLaneId: "implement",
    toLaneId: "done",
    cause: "done",
    actor: "user",
  });

  // moveTask (archive cause)
  db.moveTask(t.id, "archive", undefined, { cause: "archive" });
  events = db.laneEvents(t.id);
  expect(events).toHaveLength(7);
  expect(events[6]).toMatchObject({
    taskId: t.id,
    fromLaneId: "done",
    toLaneId: "archive",
    cause: "archive",
    actor: "user",
  });

  // API-style updateTask lane patch (cause "edit")
  db.updateTask(t.id, { lane: "backlog" });
  events = db.laneEvents(t.id);
  expect(events).toHaveLength(8);
  expect(events[7]).toMatchObject({
    taskId: t.id,
    fromLaneId: "archive",
    toLaneId: "backlog",
    cause: "edit",
    actor: "user",
  });

  // same-lane updateTask with index-only patch appends nothing
  db.updateTask(t.id, { index: 0 });
  events = db.laneEvents(t.id);
  expect(events).toHaveLength(8);

  // events ordered (created_at, rowid)
  const all = db.laneEvents();
  expect(all.map((e) => e.id)).toEqual(events.map((e) => e.id));
});

test("laneEventsAfter returns entries ascending by rowid with card title; maxLaneEventRowid is 0 on empty", () => {
  expect(db.maxLaneEventRowid()).toBe(0); // fresh, empty table
  expect(db.laneEventsAfter(0)).toEqual([]);

  const t = db.createTask({ title: "feed me", lane: "backlog" });
  db.moveTask(t.id, "plan");
  db.moveTask(t.id, "review");

  const feed = db.laneEventsAfter(0);
  expect(feed).toHaveLength(3); // create + two moves
  expect(feed.map((e) => [e.fromLaneId, e.toLaneId])).toEqual([
    [null, "backlog"],
    ["backlog", "plan"],
    ["plan", "review"],
  ]);
  expect(feed.every((e) => e.cardTitle === "feed me" && e.taskId === t.id && typeof e.createdAt === "number")).toBe(true);
  expect([...feed].map((e) => e.rowid)).toEqual([...feed].map((e) => e.rowid).sort((a, b) => a - b)); // ascending

  const last = feed[feed.length - 1].rowid;
  expect(db.laneEventsAfter(last)).toEqual([]); // cursor at the tail
  expect(db.maxLaneEventRowid()).toBe(last);
});

test("lane_events: backfill approximates from thread anchors and is idempotent", () => {
  const path = join(dir, "backfill.db");
  new KanbanDb(path).close();

  // Clear lane_events and board_state flag
  const raw2 = new Database(path);
  raw2.exec("DELETE FROM lane_events; DELETE FROM board_state WHERE key = 'lane_events_backfilled';");

  // Task 1: created in backlog, approved at 1000, current lane is implement
  raw2.run(
    "INSERT INTO tasks (id, title, note, lane_id, project, parent_id, previous_lane, priority, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ["t1", "Task 1", "", "implement", "", null, null, "normal", 100, 500, 1000],
  );
  raw2.run(
    "INSERT INTO comments (id, card_id, author, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ["c1", "t1", "user", "approval", "approved", 1000],
  );

  // Task 2: created in backlog at 200, plan-review block at 300, plain comment at 350, rejection at 400, approval at 500, current lane is done
  raw2.run(
    "INSERT INTO tasks (id, title, note, lane_id, project, parent_id, previous_lane, priority, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ["t2", "Task 2", "", "done", "", null, null, "normal", 200, 200, 500],
  );
  raw2.run(
    "INSERT INTO comments (id, card_id, author, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ["c2_1", "t2", PLAN_REVIEWER_AUTHOR, "review", `${KanbanDb.PLAN_REVIEW_BLOCK} - needs work`, 300],
  );
  raw2.run(
    "INSERT INTO comments (id, card_id, author, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ["c2_2", "t2", "human", "comment", "working on it", 350],
  );
  raw2.run(
    "INSERT INTO comments (id, card_id, author, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ["c2_3", "t2", "human", "rejection", "rejected", 400],
  );
  raw2.run(
    "INSERT INTO comments (id, card_id, author, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ["c2_4", "t2", "human", "approval", "approved", 500],
  );
  raw2.close();

  // Reopen: triggers backfill
  const reopened = new KanbanDb(path);
  const ev1 = reopened.laneEvents("t1");
  // t1 timeline: creation (500, backlog) -> approval (1000, implement) -> current lane (1000, implement -> skipped)
  expect(ev1).toHaveLength(2);
  expect(ev1[0]).toMatchObject({ taskId: "t1", fromLaneId: null, toLaneId: "backlog", cause: "backfill", createdAt: 500 });
  expect(ev1[1]).toMatchObject({ taskId: "t1", fromLaneId: "backlog", toLaneId: "implement", cause: "backfill", createdAt: 1000 });

  const ev2 = reopened.laneEvents("t2");
  // t2 timeline:
  // creation (200, backlog)
  // c2_1: plan-review block (300, plan)
  // c2_2: plain comment (ignored)
  // c2_3: rejection (400, plan) -> same as previous anchor (plan) so skipped!
  // c2_4: approval (500, implement)
  // final synthetic: current lane is done (500, done)
  expect(ev2).toHaveLength(4);
  expect(ev2[0]).toMatchObject({ taskId: "t2", fromLaneId: null, toLaneId: "backlog", cause: "backfill", createdAt: 200 });
  expect(ev2[1]).toMatchObject({ taskId: "t2", fromLaneId: "backlog", toLaneId: "plan", cause: "backfill", createdAt: 300 });
  expect(ev2[2]).toMatchObject({ taskId: "t2", fromLaneId: "plan", toLaneId: "implement", cause: "backfill", createdAt: 500 });
  expect(ev2[3]).toMatchObject({ taskId: "t2", fromLaneId: "implement", toLaneId: "done", cause: "backfill", createdAt: 500 });

  // Idempotency: second reopen adds nothing
  reopened.close();
  const reopened2 = new KanbanDb(path);
  expect(reopened2.laneEvents("t1")).toHaveLength(2);
  expect(reopened2.laneEvents("t2")).toHaveLength(4);
  reopened2.close();
});

test("cardStats: lane times, cycle, current-lane age, gate wait (incl. lane-skipping card)", () => {
  const now = 20_000;
  // Card 1: created at 1000 in backlog, never moved
  const raw = new Database(join(dir, "t.db"));
  const tNever = db.createTask({ title: "never moved", lane: "backlog" });
  raw.run("UPDATE tasks SET created_at = 1000 WHERE id = ?", [tNever.id]);
  raw.run("UPDATE lane_events SET created_at = 1000 WHERE task_id = ?", [tNever.id]);

  const statsNever = db.cardStats(tNever.id, now);
  expect(statsNever.laneTimes).toEqual([{ laneId: "backlog", ms: 19_000 }]);
  expect(statsNever.reachedDone).toBe(false);
  expect(statsNever.cycleMs).toBe(19_000);
  expect(statsNever.currentLaneMs).toBe(19_000);
  expect(statsNever.gateWaitMs).toBe(0);
  expect(statsNever.reviewToDoneMs).toBeNull();

  // Card 2: created at 1000, jumped directly backlog -> done at 5000 (skipping lanes)
  const tSkip = db.createTask({ title: "skipped lanes", lane: "backlog" });
  db.moveTask(tSkip.id, "done");
  raw.run("UPDATE tasks SET created_at = 1000 WHERE id = ?", [tSkip.id]);
  raw.run("UPDATE lane_events SET created_at = 1000 WHERE task_id = ? AND to_lane_id = 'backlog'", [tSkip.id]);
  raw.run("UPDATE lane_events SET created_at = 5000 WHERE task_id = ? AND to_lane_id = 'done'", [tSkip.id]);

  const statsSkip = db.cardStats(tSkip.id, now);
  expect(statsSkip.laneTimes).toEqual([
    { laneId: "backlog", ms: 4000 },
    { laneId: "done", ms: 15_000 },
  ]);
  expect(statsSkip.reachedDone).toBe(true);
  expect(statsSkip.cycleMs).toBe(4000); // 5000 - 1000
  expect(statsSkip.currentLaneMs).toBe(15_000); // 20000 - 5000
  expect(statsSkip.gateWaitMs).toBe(0);
  expect(statsSkip.reviewToDoneMs).toBeNull();

  // Card 3: multi-hop: backlog(1000) -> plan(3000) -> implement(7000) -> review(12000) -> done(16000)
  const tHop = db.createTask({ title: "multi-hop", lane: "backlog" });
  db.moveTask(tHop.id, "plan");
  db.moveTask(tHop.id, "implement");
  db.moveTask(tHop.id, "review");
  db.moveTask(tHop.id, "done");
  raw.run("UPDATE tasks SET created_at = 1000 WHERE id = ?", [tHop.id]);
  raw.run("UPDATE lane_events SET created_at = 1000 WHERE task_id = ? AND to_lane_id = 'backlog'", [tHop.id]);
  raw.run("UPDATE lane_events SET created_at = 3000 WHERE task_id = ? AND to_lane_id = 'plan'", [tHop.id]);
  raw.run("UPDATE lane_events SET created_at = 7000 WHERE task_id = ? AND to_lane_id = 'implement'", [tHop.id]);
  raw.run("UPDATE lane_events SET created_at = 12000 WHERE task_id = ? AND to_lane_id = 'review'", [tHop.id]);
  raw.run("UPDATE lane_events SET created_at = 16000 WHERE task_id = ? AND to_lane_id = 'done'", [tHop.id]);

  const statsHop = db.cardStats(tHop.id, now);
  // backlog: 3000 - 1000 = 2000
  // plan: 7000 - 3000 = 4000
  // implement: 12000 - 7000 = 5000
  // review: 16000 - 12000 = 4000
  // done: 20000 - 16000 = 4000
  expect(statsHop.laneTimes).toEqual([
    { laneId: "backlog", ms: 2000 },
    { laneId: "plan", ms: 4000 },
    { laneId: "implement", ms: 5000 },
    { laneId: "review", ms: 4000 },
    { laneId: "done", ms: 4000 },
  ]);
  const sumMs = statsHop.laneTimes.reduce((acc, lt) => acc + lt.ms, 0);
  expect(sumMs).toBe(now - 1000); // 19000
  expect(statsHop.gateWaitMs).toBe(4000); // plan lane duration
  expect(statsHop.reviewToDoneMs).toBe(4000); // 16000 - 12000
  expect(statsHop.cycleMs).toBe(15_000); // 16000 - 1000
  expect(statsHop.currentLaneMs).toBe(4000); // 20000 - 16000
  raw.close();
});

test("cardStats: loop-health counters (plan-review blocks, review blocks, cap hits, plan versions, session durations)", () => {
  const t = db.createTask({ title: "loop health card", lane: "implement" });

  // 1 planReviewBlocks
  db.createComment(t.id, {
    author: PLAN_REVIEWER_AUTHOR,
    kind: "review",
    body: `${KanbanDb.PLAN_REVIEW_BLOCK} — missing checklist`,
  });

  // reviewBlocks: 3 reviewer comments, 1 reviewer approve with matching done-event/actor -> 3 - 1 = 2
  db.createComment(t.id, {
    author: "pi-reviewer",
    kind: "review",
    body: "findings blocker: broken test",
  });
  db.createComment(t.id, {
    author: "pi-reviewer",
    kind: "review",
    body: "findings blocker: bad types",
  });
  // The approval:
  db.createComment(t.id, {
    author: "pi-reviewer",
    kind: "review",
    body: "approved",
  });
  // matching done event:
  db.moveTask(t.id, "done", undefined, { cause: "review", actor: "pi-reviewer" });

  // cappedHits: 1 plan review cap, 1 auto-review stop cap
  db.createComment(t.id, {
    author: PLAN_REVIEWER_AUTHOR,
    kind: "comment",
    body: `${KanbanDb.PLAN_REVIEW_CAP}: too many attempts`,
  });
  db.createComment(t.id, {
    author: "pi-reviewer",
    kind: "comment",
    body: "auto-review stopped: block cycles reached the cap (3 cycles)",
  });

  // planVersions: 2 plans
  db.attach(t.id, "plan", "# Plan v1");
  db.attach(t.id, "plan", "# Plan v2");

  // sessions: 2 session logs, one with 37s header, one unparseable
  db.attach(t.id, "session", "pi-reviewer · claude · 10/30/2026, 12:00:00 PM · 37s\nlog line 1\nlog line 2");
  db.attach(t.id, "session", "malformed header without duration\nlog line");

  const stats = db.cardStats(t.id);
  expect(stats.planReviewBlocks).toBe(1);
  expect(stats.reviewBlocks).toBe(2);
  expect(stats.cappedHits).toBe(2);
  expect(stats.planVersions).toBe(2);
  expect(stats.sessions).toEqual({ count: 2, totalMs: 37_000 });
});

test("boardStats: wip, throughput weeks, lane dwell averages, projects, cycle average", () => {
  // Empty board stats
  const emptyStats = db.boardStats(100_000);
  expect(emptyStats.board.wip).toBe(0);
  expect(emptyStats.board.cycleAvgMs).toBeNull();
  expect(emptyStats.board.throughput).toHaveLength(8);
  expect(emptyStats.board.projects).toEqual([]);
  expect(emptyStats.board.laneDwell).toEqual({});

  // Seed tasks
  // t1: active, project: "", created at 1000 in backlog
  // t2: active, project: "infra", created at 2000 in implement
  // t3: done, project: "infra", created at 3000, entered done at 8000 (cycle = 5000)
  // t4: archive, project: "web", created at 4000, entered done at 6000 then archive (cycle = 2000)
  const t1 = db.createTask({ title: "t1", lane: "backlog", project: "" });
  const t2 = db.createTask({ title: "t2", lane: "implement", project: "infra" });
  const t3 = db.createTask({ title: "t3", lane: "implement", project: "infra" });
  db.moveTask(t3.id, "done");
  const t4 = db.createTask({ title: "t4", lane: "implement", project: "web" });
  db.moveTask(t4.id, "done");
  db.moveTask(t4.id, "archive");

  const raw = new Database(join(dir, "t.db"));
  raw.run("UPDATE tasks SET created_at = 3000 WHERE id = ?", [t3.id]);
  raw.run("UPDATE lane_events SET created_at = 8000 WHERE task_id = ? AND to_lane_id = 'done'", [t3.id]);
  raw.run("UPDATE tasks SET created_at = 4000 WHERE id = ?", [t4.id]);
  raw.run("UPDATE lane_events SET created_at = 6000 WHERE task_id = ? AND to_lane_id = 'done'", [t4.id]);
  raw.close();

  const now = 20_000;
  const payload = db.boardStats(now);
  // wip: t1, t2 are active (not done/archive) -> 2
  expect(payload.board.wip).toBe(2);

  // cycleAvgMs: t3 cycle = 8000 - 3000 = 5000, t4 cycle = 6000 - 4000 = 2000 -> avg = 3500
  expect(payload.board.cycleAvgMs).toBe(3500);

  // projects: sorted by project asc, "" included
  // "": 1 total, 1 active, 0 done
  // "infra": 2 total, 1 active, 1 done (t3 reached done)
  // "web": 1 total, 0 active, 1 done (t4 reached done)
  expect(payload.board.projects).toEqual([
    { project: "", total: 1, active: 1, done: 0 },
    { project: "infra", total: 2, active: 1, done: 1 },
    { project: "web", total: 1, active: 0, done: 1 },
  ]);

  // throughput: 8 weeks, oldest first
  expect(payload.board.throughput).toHaveLength(8);
  const totalDoneInThroughput = payload.board.throughput.reduce((acc, w) => acc + w.done, 0);
  expect(totalDoneInThroughput).toBe(2); // t3 and t4 both entered done

  // laneDwell: keys only visited lanes with mean over visitors
  expect(payload.board.laneDwell.backlog).toBeDefined();
  expect(payload.board.laneDwell.implement).toBeDefined();
  expect(payload.board.laneDwell.done).toBeDefined();
  expect(payload.board.laneDwell.waiting).toBeUndefined(); // no task entered waiting
});

test("deleting a linked card leaves survivors with no dangling links", () => {
  const a = db.createTask({ title: "Card A", lane: "backlog" });
  const b = db.createTask({ title: "Card B", lane: "backlog" });
  const c = db.createTask({ title: "Card C", lane: "backlog" });
  db.linkCards(a.id, b.id);
  db.linkCards(b.id, c.id);

  const deleted = db.deleteTask(b.id);
  expect(deleted.id).toBe(b.id);
  expect(db.linksOf(a.id)).toEqual([]);
  expect(db.linksOf(c.id)).toEqual([]);
  expect(db.linksMap()).toEqual({});
  expect(db.resolveTask(a.id).title).toBe("Card A");
  expect(db.resolveTask(c.id).title).toBe("Card C");
});

test("lane rm --force leaves no dangling links for removed cards", () => {
  db.createLane({ name: "doomed" });
  const a = db.createTask({ title: "Card A", lane: "backlog" });
  const b = db.createTask({ title: "Card B", lane: "doomed" });
  const c = db.createTask({ title: "Card C", lane: "doomed" });
  const d = db.createTask({ title: "Card D", lane: "doomed" });
  db.linkCards(a.id, b.id);
  db.linkCards(c.id, d.id);

  db.deleteLane("doomed", true);
  expect(db.linksOf(a.id)).toEqual([]);
  expect(db.linksMap()).toEqual({});
});

test("moving a linked card to another lane keeps its links", () => {
  const a = db.createTask({ title: "Card A", lane: "backlog" });
  const b = db.createTask({ title: "Card B", lane: "backlog" });
  db.linkCards(a.id, b.id);

  db.moveTask(a.id, "implement");
  const links = db.linksOf(a.id);
  expect(links).toHaveLength(1);
  expect(links[0].id).toBe(b.id);
  expect(db.linksMap()).toEqual({
    [a.id]: [b.id],
    [b.id]: [a.id],
  });
  expect(db.resolveTask(a.id).laneId).toBe("implement");
});

test("linkCards: self-link invalid, duplicate idempotent, canonical order", () => {
  const a = db.createTask({ title: "Card A", lane: "backlog" });
  const b = db.createTask({ title: "Card B", lane: "backlog" });

  // self-link throws with code invalid
  try {
    db.linkCards(a.id, a.id);
    expect.unreachable();
  } catch (err: any) {
    expect(err).toBeInstanceOf(KanbanError);
    expect(err.message).toMatch(/cannot link a card to itself/);
    expect(err.code).toBe("invalid");
  }

  // linking twice leaves linksOf length 1
  db.linkCards(a.id, b.id);
  const links1 = db.linkCards(a.id, b.id);
  expect(links1).toHaveLength(1);
  expect(links1[0].id).toBe(b.id);
  expect(db.linksOf(a.id)).toHaveLength(1);

  // linkCards(b.id, a.id) after linkCards(a.id, b.id) is a no-op
  const links2 = db.linkCards(b.id, a.id);
  expect(links2).toHaveLength(1);
  expect(links2[0].id).toBe(a.id);
  expect(db.linksMap()[a.id]).toEqual([b.id]);
  expect(db.linksMap()[b.id]).toEqual([a.id]);

  // unlink removes edge
  expect(db.unlinkCards(a.id, b.id)).toBe(true);
  expect(db.linksOf(a.id)).toEqual([]);
  expect(db.unlinkCards(a.id, b.id)).toBe(false);
});


test("tags: default empty; create/patch roundtrip; normalization trims, drops empties, dedupes, keeps order; limits throw", () => {
  const plain = db.createTask({ title: "untagged" });
  expect(plain.tags).toEqual([]);

  const tagged = db.createTask({ title: "tagged", tags: [" ui ", "", "ui", "review-loop", "  "] });
  expect(tagged.tags).toEqual(["ui", "review-loop"]);

  // patch replaces the whole array; [] clears
  const replaced = db.updateTask(tagged.id, { tags: ["a"] });
  expect(replaced.tags).toEqual(["a"]);
  const cleared = db.updateTask(tagged.id, { tags: [] });
  expect(cleared.tags).toEqual([]);

  // omitting tags on patch keeps them
  expect(db.updateTask(cleared.id, { tags: ["k"] }).tags).toEqual(["k"]);
  expect(db.updateTask(cleared.id, { title: "renamed" }).tags).toEqual(["k"]);

  expect(() => db.createTask({ title: "x", tags: ["u".repeat(49)] })).toThrow(
    "tags must be at most 48 characters each",
  );
  expect(() =>
    db.createTask({ title: "x", tags: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"] }),
  ).toThrow("a card carries at most 10 tags");
  expect(() => db.updateTask(plain.id, { tags: ["u".repeat(49)] })).toThrow(
    "tags must be at most 48 characters each",
  );
});

test("tags: pre-tags database migrates with tags defaulting to []", () => {
  const a = db.createTask({ title: "a" });
  const b = db.createTask({ title: "b", tags: ["ui"] });
  db.close();
  const raw = new Database(join(dir, "t.db"));
  raw.exec("ALTER TABLE tasks DROP COLUMN tags");
  raw.close();

  const reopened = new KanbanDb(join(dir, "t.db"));
  const tasks = reopened.tasks();
  expect(tasks.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
  expect(tasks.every((t) => t.tags.length === 0)).toBe(true);
  expect(reopened.updateTask(a.id, { tags: ["x"] }).tags).toEqual(["x"]);
  reopened.close();
});

test("undoTask reverts the latest board move, walks multi-step history, and restores stats", () => {
  const a = db.createTask({ title: "card a" });
  const b = db.createTask({ title: "card b" });
  db.moveTask(a.id, "plan");
  db.moveTask(a.id, "implement");
  db.updateTask(b.id, { lane: "done" }, { cause: "edit" });

  // First undoTask() reverts b from done to backlog
  const res1 = db.undoTask();
  expect(res1.task.id).toBe(b.id);
  expect(res1.task.laneId).toBe("backlog");
  expect(res1.event.fromLaneId).toBe("backlog");
  expect(res1.event.toLaneId).toBe("done");
  expect(res1.event.cause).toBe("edit");
  expect(db.laneEvents(b.id).filter((e) => e.toLaneId === "done")).toHaveLength(0);
  expect(db.cardStats(b.id).reachedDone).toBe(false);

  // Second undoTask() reverts a from implement to plan
  const res2 = db.undoTask();
  expect(res2.task.id).toBe(a.id);
  expect(res2.task.laneId).toBe("plan");
  expect(res2.event.fromLaneId).toBe("plan");
  expect(res2.event.toLaneId).toBe("implement");

  // Third undoTask() reverts a from plan to backlog
  const res3 = db.undoTask();
  expect(res3.task.id).toBe(a.id);
  expect(res3.task.laneId).toBe("backlog");
  expect(res3.event.fromLaneId).toBe("backlog");
  expect(res3.event.toLaneId).toBe("plan");

  // Only creation events remain
  expect(db.laneEvents(a.id)).toHaveLength(1);
  expect(db.laneEvents(b.id)).toHaveLength(1);
});

test("undoTask(taskRef) scopes to the target card and restores waiting previousLane", () => {
  const a = db.createTask({ title: "card a", lane: "plan" });
  const b = db.createTask({ title: "card b" });
  db.attach(a.id, "plan", "# plan\n\n- [ ] do it");
  db.planReview(a.id, { verdict: "pass", message: "ok" });
  expect(db.resolveTask(a.id).laneId).toBe("waiting");
  expect(db.resolveTask(a.id).previousLane).toBe("plan");

  // Drag a to done (clearing previous_lane), then move b to review
  db.updateTask(a.id, { lane: "done" });
  expect(db.resolveTask(a.id).previousLane).toBeNull();
  db.moveTask(b.id, "review");

  // Calling db.undoTask(a.id.slice(0, 4)) leaves b in review, returns a to waiting with previousLane === "plan"
  const res1 = db.undoTask(a.id.slice(0, 4));
  expect(res1.task.id).toBe(a.id);
  expect(res1.task.laneId).toBe("waiting");
  expect(res1.task.previousLane).toBe("plan");
  expect(db.resolveTask(b.id).laneId).toBe("review");

  // Subsequent db.undoTask(a.id) returns a from waiting to plan with previousLane === null
  const res2 = db.undoTask(a.id);
  expect(res2.task.id).toBe(a.id);
  expect(res2.task.laneId).toBe("plan");
  expect(res2.task.previousLane).toBeNull();
});

test("undoTask refuses when only creation/backfill events exist, when from-lane was deleted, or on bad task ref", () => {
  const card = db.createTask({ title: "card" });
  expect(() => db.undoTask()).toThrow(new KanbanError("nothing to undo", "conflict"));
  expect(() => db.undoTask(card.id)).toThrow(
    new KanbanError(`nothing to undo for task '${card.id}'`, "conflict"),
  );

  // Seeded cause = "backfill" rows are ignored and also throw "nothing to undo"
  const raw = new Database(join(dir, "t.db"));
  raw.run(
    "INSERT INTO lane_events (id, task_id, from_lane_id, to_lane_id, cause, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["evt-bf", card.id, "backlog", "plan", "backfill", "system", Date.now()],
  );
  expect(() => db.undoTask()).toThrow(new KanbanError("nothing to undo", "conflict"));
  expect(() => db.undoTask(card.id)).toThrow(
    new KanbanError(`nothing to undo for task '${card.id}'`, "conflict"),
  );

  // If a card is created in custom lane spike, moved to backlog, and spike is deleted via db.deleteLane("spike")
  const spikeLane = db.createLane({ name: "spike" });
  const spikeCard = db.createTask({ title: "spike card", lane: spikeLane.id });
  db.moveTask(spikeCard.id, "backlog");
  db.deleteLane(spikeLane.id);
  expect(() => db.undoTask(spikeCard.id)).toThrow(
    new KanbanError(`cannot undo: lane '${spikeLane.id}' no longer exists`, "conflict"),
  );

  // Unknown task ref throws
  expect(() => db.undoTask("zzzz")).toThrow(new KanbanError("no task matching 'zzzz'", "not-found"));
});

test("ownership: handoff and approve set it, every exit from implement clears it", () => {
  const card = db.createTask({ title: "owned card" });

  // handoff into implement sets owner to the author (default "user")
  db.handoff(card.id, "implement", { message: "building" });
  expect(db.resolveTask(card.id).owner).toBe("user");
  db.handoff(card.id, "implement", { message: "building", author: "pi" });
  expect(db.resolveTask(card.id).owner).toBe("pi");

  // same-lane reorder keeps the owner
  const sibling = db.createTask({ title: "sibling", lane: "implement" });
  db.moveTask(card.id, "implement", 0);
  expect(db.resolveTask(card.id).owner).toBe("pi");
  expect(db.resolveTask(sibling.id).owner).toBeNull();

  // every exit from implement clears it, whatever the patch says
  db.moveTask(card.id, "review");
  expect(db.resolveTask(card.id).owner).toBeNull();
  db.updateTask(card.id, { lane: "implement", owner: "pi" });
  expect(db.resolveTask(card.id).owner).toBe("pi");
  db.updateTask(card.id, { lane: "review", owner: "pi" }); // forced null despite the patch
  expect(db.resolveTask(card.id).owner).toBeNull();

  db.updateTask(card.id, { lane: "implement", owner: "pi" });
  db.moveTask(card.id, "done");
  expect(db.resolveTask(card.id).owner).toBeNull();
  db.updateTask(card.id, { lane: "implement", owner: "pi" });
  db.moveTask(card.id, "archive");
  expect(db.resolveTask(card.id).owner).toBeNull();

  // question-park (waiting) clears it too
  db.updateTask(card.id, { lane: "implement", owner: "pi" });
  db.comment(card.id, { author: "anyone", kind: "question", body: "stuck — which driver?" });
  expect(db.resolveTask(card.id).laneId).toBe("waiting");
  expect(db.resolveTask(card.id).owner).toBeNull();

  // TaskPatch.owner directly: strings trim, empty throws, null clears
  db.updateTask(card.id, { owner: "  ada  " });
  expect(db.resolveTask(card.id).owner).toBe("ada");
  expect(() => db.updateTask(card.id, { owner: "   " })).toThrow(
    new KanbanError("owner must not be empty", "invalid"),
  );
  db.updateTask(card.id, { owner: null });
  expect(db.resolveTask(card.id).owner).toBeNull();

  // approve sets the owner to the builder author
  const gate = db.createTask({ title: "gated card", lane: "plan" });
  db.attach(gate.id, "plan", "# plan v1\nbuild it");
  const { task: approved } = db.approveTask(gate.id);
  expect(approved.laneId).toBe("implement");
  expect(approved.owner).toBe(BUILDER_AUTHOR);
  expect(BUILDER_AUTHOR).toBe("pi-builder");
});

test("ownership: a review return goes to the implement lane's lead actor, never the reviewer", () => {
  const card = db.createTask({ title: "blocked card 1", lane: "review" });
  const { task: returned } = db.handoff(card.id, "implement", {
    kind: "review",
    author: "pi-reviewer",
    message: "blocked",
    findings: ["fix x"],
  });
  expect(returned.owner).toBe(BUILDER_AUTHOR);
  expect(db.resolveTask(card.id).owner).toBe(BUILDER_AUTHOR);

  // with no author -> still BUILDER_AUTHOR (not "user")
  const cardNoAuthor = db.createTask({ title: "blocked card no author", lane: "review" });
  const { task: returnedNoAuthor } = db.handoff(cardNoAuthor.id, "implement", {
    kind: "review",
    message: "blocked without author",
  });
  expect(returnedNoAuthor.owner).toBe(BUILDER_AUTHOR);
  expect(db.resolveTask(cardNoAuthor.id).owner).toBe(BUILDER_AUTHOR);

  // human handoff is never overridden by the lead actor, even with the seeded context present
  const cardHuman = db.createTask({ title: "human handoff", lane: "plan" });
  const { task: returnedHuman } = db.handoff(cardHuman.id, "implement", {
    author: "ada",
    message: "mine",
  });
  expect(returnedHuman.owner).toBe("ada");
  expect(db.resolveTask(cardHuman.id).owner).toBe("ada");

  // owner follows lane config, not a hardcoded constant
  db.setLaneContext("implement", {
    ...defaultLaneContext("implement")!,
    actors: [{ ...defaultLaneContext("implement")!.actors[0]!, author: "pi-smith" }],
  });
  const cardCustom = db.createTask({ title: "blocked card 2", lane: "review" });
  const { task: returnedCustom } = db.handoff(cardCustom.id, "implement", {
    kind: "review",
    author: "pi-reviewer",
    message: "blocked again",
  });
  expect(returnedCustom.owner).toBe("pi-smith");
  expect(db.resolveTask(cardCustom.id).owner).toBe("pi-smith");

  // no-context fallback: clears owner (null), does not fall back to reviewer
  db.setLaneContext("implement", null);
  const cardNoContext = db.createTask({ title: "blocked card 3", lane: "review" });
  const { task: returnedNoContext } = db.handoff(cardNoContext.id, "implement", {
    kind: "review",
    author: "pi-reviewer",
    message: "blocked no context",
  });
  expect(returnedNoContext.owner).toBeNull();
  expect(db.resolveTask(cardNoContext.id).owner).toBeNull();
});

test("claimTask: set, idempotent re-claim, foreign owner refuses without force, force takes over", () => {
  const card = db.createTask({ title: "claimable" });

  const claimed = db.claimTask(card.id, { author: "ada" });
  expect(claimed.owner).toBe("ada");

  // same author re-claims fine
  expect(db.claimTask(card.id, { author: "ada" }).owner).toBe("ada");

  // foreign claim refuses with the exact conflict message
  expect(() => db.claimTask(card.id, { author: "bob" })).toThrow(
    new KanbanError(`card '${card.id}' is already owned by 'ada' — pass --force to take it over`, "conflict"),
  );
  expect(db.resolveTask(card.id).owner).toBe("ada");

  // force takes over; author defaults to "user" — which is then foreign to bob
  expect(db.claimTask(card.id, { author: "bob", force: true }).owner).toBe("bob");
  expect(() => db.claimTask(card.id)).toThrow(/already owned by 'bob'/);
  expect(db.claimTask(card.id, { force: true }).owner).toBe("user");
});

test("moveTaskBefore: anchor placement, wrong-lane and self errors", () => {
  const a = db.createTask({ title: "A", lane: "backlog" });
  const b = db.createTask({ title: "B", lane: "backlog" });
  const c = db.createTask({ title: "C", lane: "backlog" });
  // board order: A, B, C (positions 200, 300, 400 after the seeded waiting lane)

  // place C before A → order: C, A, B
  db.moveTaskBefore(c.id, undefined, a.id);
  expect(db.laneTasks("backlog").map((t) => t.id)).toEqual([c.id, a.id, b.id]);

  // cross-lane move + anchor: move C into plan directly before a plan anchor
  const p1 = db.createTask({ title: "P1", lane: "plan" });
  const p2 = db.createTask({ title: "P2", lane: "plan" });
  db.moveTaskBefore(c.id, "plan", p2.id);
  expect(db.laneTasks("plan").map((t) => t.id)).toEqual([p1.id, c.id, p2.id]);
  expect(db.resolveTask(c.id).laneId).toBe("plan");

  // self anchor
  expect(() => db.moveTaskBefore(a.id, "backlog", a.id)).toThrow(
    new KanbanError("cannot move a card before itself", "invalid"),
  );

  // anchor outside the target lane
  expect(() => db.moveTaskBefore(a.id, "review", p1.id)).toThrow(
    new KanbanError(`anchor card '${p1.id}' is not in lane 'review'`, "conflict"),
  );

  // same-lane reorder keeps the owner (no lane change, no clear)
  db.updateTask(a.id, { owner: "ada" });
  db.moveTaskBefore(a.id, undefined, b.id);
  expect(db.resolveTask(a.id).owner).toBe("ada");
});

test("same-lane moveTask without index/before writes nothing", () => {
  const a = db.createTask({ title: "A", lane: "backlog" });
  const b = db.createTask({ title: "B", lane: "backlog" });
  const c = db.createTask({ title: "C", lane: "backlog" });
  const before = db.resolveTask(b.id);
  const eventsBefore = db.laneEvents(b.id).length;
  const orderBefore = db.laneTasks("backlog").map((t) => t.id);

  const result = db.moveTask(b.id, "backlog");
  expect(result.id).toBe(b.id);

  const after = db.resolveTask(b.id);
  expect(after.position).toBe(before.position);
  expect(after.updatedAt).toBe(before.updatedAt);
  expect(db.laneEvents(b.id)).toHaveLength(eventsBefore);
  expect(db.laneTasks("backlog").map((t) => t.id)).toEqual(orderBefore); // not re-appended
  expect(a.id && c.id).toBeTruthy();

  // --pos still reorders within the same lane
  db.moveTask(b.id, "backlog", 0);
  expect(db.laneTasks("backlog").map((t) => t.id)).toEqual([b.id, a.id, c.id]);
});

// ---------- lane workers + board overview (card d26pe) ----------

test("lane workers: queue → claim → finish lifecycle with guards", () => {
  expect(db.laneWorkers()).toEqual([]);

  const run = db.queueLaneWorker({ laneId: "backlog", focus: "  groom stale cards  " });
  expect(run.status).toBe("queued");
  expect(run.laneId).toBe("backlog");
  expect(run.focus).toBe("groom stale cards");
  expect(run.requestedBy).toBe("user");
  expect(run.id).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]+$/);
  expect(run.sessionId).toBeUndefined();
  expect(run.startedAt).toBeUndefined();

  // newest first
  const second = db.queueLaneWorker({ laneId: "waiting", requestedBy: "pi-manager" });
  expect(db.laneWorkers().map((r) => r.id)).toEqual([second.id, run.id]);
  expect(db.laneWorker(run.id)).toMatchObject({ id: run.id });
  expect(db.laneWorker("zzzzzz")).toBeNull();
  expect(db.laneWorkers({ laneId: "backlog" }).map((r) => r.id)).toEqual([run.id]);

  const now = Date.now();
  const claimed = db.claimLaneWorker(run.id, "kanban-worker-backlog-" + run.id, now);
  expect(claimed).toMatchObject({ status: "running", sessionId: "kanban-worker-backlog-" + run.id, startedAt: now });

  // claim on a non-queued row loses
  expect(db.claimLaneWorker(run.id, "other", now)).toBeNull();
  expect(db.claimLaneWorker("zzzzzz", "other", now)).toBeNull();

  // finish only from running
  const done = db.finishLaneWorker(run.id, { status: "done", summary: "groomed 3 cards", log: "text: done" }, now + 5);
  expect(done).toMatchObject({ status: "done", summary: "groomed 3 cards", endedAt: now + 5 });
  expect(db.finishLaneWorker(run.id, { status: "failed" }, now + 6)).toBeNull(); // second finish null
  expect(db.finishLaneWorker(second.id, { status: "done" }, now)).toBeNull(); // only from running
  expect(db.laneWorkers({ status: "done" }).map((r) => r.id)).toEqual([run.id]);
});

test("failRunningLaneWorkers reaps orphaned running rows", () => {
  const a = db.queueLaneWorker({ laneId: "backlog" });
  const b = db.queueLaneWorker({ laneId: "review" });
  const parked = db.queueLaneWorker({ laneId: "waiting" }); // stays queued — untouched
  const now = Date.now();
  db.claimLaneWorker(a.id, "s-a", now);
  db.claimLaneWorker(b.id, "s-b", now);

  const reaped = db.failRunningLaneWorkers("server restarted — run lost; re-dispatch if needed");
  expect(reaped).toBe(2);
  expect(db.laneWorker(a.id)).toMatchObject({
    status: "failed",
    exitInfo: "server restarted — run lost; re-dispatch if needed",
  });
  expect(db.laneWorker(b.id)!.endedAt).toBeGreaterThan(0);
  expect(db.laneWorker(parked.id)!.status).toBe("queued");

  expect(db.failRunningLaneWorkers("again")).toBe(0);
});

test("queueLaneWorker rejects focus over 2000 characters", () => {
  expect(() => db.queueLaneWorker({ laneId: "backlog", focus: "x".repeat(2001) })).toThrow(
    new KanbanError("worker focus must be at most 2000 characters", "invalid"),
  );
  expect(() => db.queueLaneWorker({ laneId: "backlog", focus: "x".repeat(2000) })).not.toThrow();
});

test("laneSnapshot caps cards at 40 and reports total/truncated; ageDays from the lane entry", () => {
  for (let i = 0; i < 45; i++) db.createTask({ title: `bulk ${i}`, lane: "backlog" });
  const now = Date.now() + 3.5 * 86_400_000; // 3+ days after every entry
  const snap = db.laneSnapshot("backlog", 40, now);
  expect(snap.laneId).toBe("backlog");
  expect(snap.total).toBe(45);
  expect(snap.truncated).toBe(true);
  expect(snap.cards).toHaveLength(40);
  expect(snap.cards.every((c) => c.ageDays === 3)).toBe(true);
  expect(snap.cards.every((c) => c.priority === "normal")).toBe(true);
  expect(snap.cards.every((c) => !c.blocked)).toBe(true);

  // lane order, not creation order across lanes: a moved card reports its current lane
  const mover = db.createTask({ title: "mover", lane: "plan" });
  db.moveTask(mover.id, "backlog");
  const plan = db.laneSnapshot("plan");
  expect(plan.total).toBe(0);

  // blocked per the soft-block rule: a blocker outside done/archive
  const blocker = db.createTask({ title: "blocker", lane: "plan" });
  const blocked = db.createTask({ title: "blocked card", lane: "plan", blockedBy: [blocker.id] });
  const snap2 = db.laneSnapshot("plan", 40, now);
  expect(snap2.cards.find((c) => c.id === blocked.id)!.blocked).toBe(true);
  expect(snap2.cards.find((c) => c.id === blocker.id)!.blocked).toBe(false);
});

test("boardOverview: lane counts, oldest age, waiting ages, next proposal, blocked count", () => {
  // fresh board: every lane present except archive, all empty
  const empty = db.boardOverview();
  expect(empty.lanes.map((l) => l.id)).toEqual(["waiting", "backlog", "plan", "implement", "review", "done"]);
  expect(empty.lanes.every((l) => l.count === 0 && l.oldestDays === 0)).toBe(true);
  expect(empty.waiting).toEqual([]);
  expect(empty.next).toBeNull();
  expect(empty.blocked).toBe(0);

  const day = 86_400_000;
  const future = Date.now() + 5.5 * day; // every entry is 5 days old at this clock

  const b1 = db.createTask({ title: "oldest backlog card", lane: "backlog", priority: "low" });
  for (let i = 0; i < 11; i++) db.createTask({ title: `waiting ${i}`, lane: "waiting" });
  const oldestWaiting = db.createTask({ title: "waiting oldest", lane: "waiting" });
  // park oldestWaiting the longest: rewrite its waiting-entry event to 9 days before `future`
  const raw = new Database(join(dir, "t.db"));
  raw.run("UPDATE lane_events SET created_at = ? WHERE task_id = ?", [future - 9 * day, oldestWaiting.id]);
  raw.close();

  const imp = db.createTask({ title: "implement card", lane: "implement" });
  const impBlocker = db.createTask({ title: "stuck implement card", lane: "implement", blockedBy: [imp.id] });
  const blocker = db.createTask({ title: "backlog blocker", lane: "backlog", priority: "high" });
  db.moveTask(b1.id, "done"); // frees backlog for next

  const overview = db.boardOverview(future);
  const byLane = new Map(overview.lanes.map((l) => [l.id, l]));
  expect(byLane.get("backlog")).toMatchObject({ id: "backlog", name: "Backlog", count: 1, oldestDays: 5 });
  expect(byLane.get("waiting")!.count).toBe(12);
  expect(byLane.get("waiting")!.oldestDays).toBe(9);
  expect(byLane.get("done")!.count).toBe(1);
  expect(overview.lanes.some((l) => l.id === "archive")).toBe(false);

  // waiting: longest-parked first, capped at 10
  expect(overview.waiting).toHaveLength(10);
  expect(overview.waiting[0]).toMatchObject({ id: oldestWaiting.id, title: "waiting oldest", ageDays: 9 });

  // next: first eligible in lane priority order (review → implement → plan → backlog)
  expect(overview.next).toMatchObject({ id: imp.id, title: "implement card" });
  expect(overview.blocked).toBe(1); // the backlog blocker skipped by next

  // a title over 80 chars is capped in the waiting list
  const longTitle = "x".repeat(120);
  const longCard = db.createTask({ title: longTitle, lane: "waiting" });
  const raw2 = new Database(join(dir, "t.db"));
  raw2.run("UPDATE lane_events SET created_at = ? WHERE task_id = ?", [future - 12 * day, longCard.id]);
  raw2.close();
  const overview2 = db.boardOverview(future);
  expect(overview2.waiting[0]!.title).toHaveLength(80);
  expect(overview2.waiting[0]!.ageDays).toBe(12);
});

test("projects: accessor round-trip — set repo, flip gate, clear repo", () => {
  expect(db.listProjects()).toEqual([]);
  expect(db.getProject("alpha")).toBeNull();

  const routed = db.setProjectRepo("alpha", dir);
  expect(routed).toEqual({ name: "alpha", repoPath: dir, testGate: true, testCmd: null });
  expect(db.getProject("alpha")).toEqual(routed);
  expect(db.projectCwd("alpha")).toBe(dir);

  const gated = db.setProjectGate("alpha", false);
  expect(gated).toEqual({ name: "alpha", repoPath: dir, testGate: false, testCmd: null }); // the route survives a gate flip
  expect(db.projectCwd("alpha")).toBe(dir);

  const cleared = db.setProjectRepo("alpha", null);
  expect(cleared).toEqual({ name: "alpha", repoPath: null, testGate: false, testCmd: null });
  expect(db.projectCwd("alpha")).toBeNull(); // un-routed again

  // gate set on a never-routed project creates the row with a null repo
  expect(db.setProjectGate("beta", false)).toEqual({ name: "beta", repoPath: null, testGate: false, testCmd: null });
  expect(db.projectCwd("beta")).toBeNull();
  expect(db.projectCwd("")).toBeNull(); // untagged cards never route

  // reopen persists both rows (created_at survives the updates)
  db.close();
  db = new KanbanDb(join(dir, "t.db"));
  expect(db.getProject("alpha")).toEqual({ name: "alpha", repoPath: null, testGate: false, testCmd: null });
  expect(db.getProject("beta")).toEqual({ name: "beta", repoPath: null, testGate: false, testCmd: null });
  expect(db.listProjects().map((p) => p.name)).toEqual(["alpha", "beta"]);
});

test("projects: seed materializes existing tags once; new tags stay lazy", () => {
  // fresh db: a tag created after open is not a table row yet
  db.createTask({ title: "tagged", project: "alpha" });
  expect(db.getProject("alpha")).toBeNull(); // reads never write
  expect(db.listProjects()).toEqual([{ name: "alpha", repoPath: null, testGate: true, testCmd: null }]); // lazy union

  // reopening the same file seeds the tag exactly once
  db.close();
  db = new KanbanDb(join(dir, "t.db"));
  expect(db.getProject("alpha")).toEqual({ name: "alpha", repoPath: null, testGate: true, testCmd: null });
  expect(db.listProjects()).toEqual([{ name: "alpha", repoPath: null, testGate: true, testCmd: null }]);

  // second reopen is a no-op — and a post-upgrade tag stays lazy until set
  db.createTask({ title: "later tag", project: "beta" });
  db.close();
  db = new KanbanDb(join(dir, "t.db"));
  expect(db.getProject("alpha")).toEqual({ name: "alpha", repoPath: null, testGate: true, testCmd: null });
  expect(db.getProject("beta")).toBeNull();
  expect(db.listProjects().map((p) => p.name)).toEqual(["alpha", "beta"]);

  // "" (untagged cards) never appears
  db.createTask({ title: "untagged" });
  expect(db.listProjects().map((p) => p.name)).toEqual(["alpha", "beta"]);
});

test("projects: setProjectRepo rejects relative, missing, and non-directory paths", () => {
  const relative = join("rel", "x");
  for (const bad of [relative, join(dir, "nope")]) {
    expect(() => db.setProjectRepo("a", bad)).toThrow(
      `repo path must be an absolute path to an existing directory: ${bad}`,
    );
  }
  const filePath = join(dir, "plain.txt");
  writeFileSync(filePath, "not a dir");
  expect(() => db.setProjectRepo("a", filePath)).toThrow(
    `repo path must be an absolute path to an existing directory: ${filePath}`,
  );
  expect(db.getProject("a")).toBeNull(); // a rejected set writes nothing

  for (const name of ["x".repeat(49), ""]) {
    expect(() => db.setProjectRepo(name, dir)).toThrow("project name must be 1 to 48 characters");
    expect(() => db.setProjectGate(name, true)).toThrow("project name must be 1 to 48 characters");
  }
  // names are trimmed, not rejected for surrounding space
  expect(db.setProjectRepo("  a  ", dir).name).toBe("a");
});

test("projects: addProject registers route and refuses duplicate names or invalid paths", () => {
  const added = db.addProject("alpha", dir);
  expect(added).toEqual({ name: "alpha", repoPath: dir, testGate: true, testCmd: null });
  expect(db.getProject("alpha")).toEqual(added);
  expect(db.projectCwd("alpha")).toBe(dir);

  expect(() => db.addProject("alpha", dir)).toThrow(
    "project 'alpha' already exists — use: kanban project set alpha --repo <path>",
  );

  db.createTask({ title: "tagged task", project: "tagged" });
  expect(() => db.addProject("tagged", dir)).toThrow(
    "project 'tagged' already exists — use: kanban project set tagged --repo <path>",
  );

  const relative = join("rel", "x");
  for (const bad of [relative, join(dir, "nope")]) {
    expect(() => db.addProject("beta", bad)).toThrow(
      `repo path must be an absolute path to an existing directory: ${bad}`,
    );
  }
  const filePath = join(dir, "plain.txt");
  writeFileSync(filePath, "not a dir");
  expect(() => db.addProject("beta", filePath)).toThrow(
    `repo path must be an absolute path to an existing directory: ${filePath}`,
  );
  expect(db.getProject("beta")).toBeNull();

  for (const name of ["x".repeat(49), ""]) {
    expect(() => db.addProject(name, dir)).toThrow("project name must be 1 to 48 characters");
  }
  expect(db.addProject("  gamma  ", dir).name).toBe("gamma");
});

test("projects: per-actor overrides round-trip; present-key skills; lane actors; upsert", () => {
  // set {model:" claude-opus-4-5 ", thinking:"high", skills:[" ~/.pi/agent/skills/x ", ""]} on reviewer -> read back
  const set1 = db.setProjectAgentConfig("demo", "reviewer", {
    model: " claude-opus-4-5 ",
    thinking: "high",
    skills: [" ~/.pi/agent/skills/x ", ""],
  });
  expect(set1).toEqual({
    model: "claude-opus-4-5",
    thinking: "high",
    skills: ["~/.pi/agent/skills/x"],
  });
  expect(db.projectAgentConfig("demo", "reviewer")).toEqual({
    model: "claude-opus-4-5",
    thinking: "high",
    skills: ["~/.pi/agent/skills/x"],
  });

  // set {model:"m3", skills:[]} -> read skills: [] (present key stored, not stripped)
  const set2 = db.setProjectAgentConfig("demo", "reviewer", { model: "m3", skills: [] });
  expect(set2).toEqual({ model: "m3", skills: [] });
  expect(db.projectAgentConfig("demo", "reviewer")).toEqual({ model: "m3", skills: [] });

  // setProjectAgentConfig("demo","reviewer",null) -> returns null, read null
  expect(db.setProjectAgentConfig("demo", "reviewer", null)).toBeNull();
  expect(db.projectAgentConfig("demo", "reviewer")).toBeNull();

  // delete on a never-touched project is a silent no-op returning null
  expect(db.setProjectAgentConfig("never-touched", "reviewer", null)).toBeNull();
  expect(db.getProject("never-touched")).toBeNull();

  // unknown actor chief -> KanbanError message exactly
  expect(() => db.setProjectAgentConfig("demo", "chief", { model: "m" })).toThrow(
    new KanbanError(
      "unknown agent role 'chief' (reviewer | builder | planner | plan-reviewer | elaborator | manager | worker)",
      "invalid",
    ),
  );

  // after setLaneContext on a custom lane hosting actor designer, set + read designer works
  const lane = db.createLane({ name: "Design" });
  db.setLaneContext(lane.id, {
    artifact: "design",
    template: "# Design Spec",
    actors: [{ id: "designer", author: "pi-designer", instructions: 'Design {id} "{title}"' }],
    triggers: [{ kind: "on-enter" }],
    gate: { approveTarget: "plan" },
  });
  expect(db.setProjectAgentConfig("demo", "designer", { model: "design-v1" })).toEqual({ model: "design-v1" });
  expect(db.projectAgentConfig("demo", "designer")).toEqual({ model: "design-v1" });

  // set on un-registered tag fresh -> getProject("fresh") equals {name:"fresh", repoPath:null, testGate:true, testCmd:null}
  db.setProjectAgentConfig("fresh", "reviewer", { model: "fresh-model" });
  expect(db.getProject("fresh")).toEqual({
    name: "fresh",
    repoPath: null,
    testGate: true,
    testCmd: null,
  });

  // name "x".repeat(49) -> project name must be 1 to 48 characters with nothing written
  expect(() => db.setProjectAgentConfig("x".repeat(49), "reviewer", { model: "m" })).toThrow(
    new KanbanError("project name must be 1 to 48 characters", "invalid"),
  );
  expect(db.getProject("x".repeat(49))).toBeNull();
  expect(db.projectAgentConfig("x".repeat(49), "reviewer")).toBeNull();
});

test("projects: setProjectTestCmd trims, enforces 1–500, clears, upserts", () => {
  // " cargo test " -> route {testCmd:"cargo test"}
  const r1 = db.setProjectTestCmd("alpha", " cargo test ");
  expect(r1.testCmd).toBe("cargo test");
  expect(db.getProject("alpha")?.testCmd).toBe("cargo test");

  // a 500-char command stores
  const cmd500 = "x".repeat(500);
  const r500 = db.setProjectTestCmd("alpha", cmd500);
  expect(r500.testCmd).toBe(cmd500);
  expect(db.getProject("alpha")?.testCmd).toBe(cmd500);

  // 501-char and whitespace-only "   " -> test command must be 1 to 500 characters
  expect(() => db.setProjectTestCmd("alpha", "x".repeat(501))).toThrow(
    new KanbanError("test command must be 1 to 500 characters", "invalid"),
  );
  expect(() => db.setProjectTestCmd("alpha", "   ")).toThrow(
    new KanbanError("test command must be 1 to 500 characters", "invalid"),
  );

  // null and "" -> testCmd: null
  expect(db.setProjectTestCmd("alpha", null).testCmd).toBeNull();
  expect(db.getProject("alpha")?.testCmd).toBeNull();
  db.setProjectTestCmd("alpha", "npm test");
  expect(db.setProjectTestCmd("alpha", "").testCmd).toBeNull();
  expect(db.getProject("alpha")?.testCmd).toBeNull();

  // returned route keeps existing repoPath/testGate untouched
  db.setProjectRepo("alpha", dir);
  db.setProjectGate("alpha", false);
  const rPreserved = db.setProjectTestCmd("alpha", "make test");
  expect(rPreserved).toEqual({
    name: "alpha",
    repoPath: dir,
    testGate: false,
    testCmd: "make test",
  });

  // set on un-registered tag -> getProject non-null with v1 defaults + the command
  const rTag = db.setProjectTestCmd("unreg", "pytest");
  expect(rTag).toEqual({
    name: "unreg",
    repoPath: null,
    testGate: true,
    testCmd: "pytest",
  });
  expect(db.getProject("unreg")).toEqual(rTag);

  // name guard throws like v1 setters
  for (const name of ["x".repeat(49), ""]) {
    expect(() => db.setProjectTestCmd(name, "test")).toThrow("project name must be 1 to 48 characters");
  }
});

test("projects: no v4 settings — routes read v1-shaped plus null testCmd", () => {
  // board with zero v4 settings: stored rows (setProjectRepo then read) report testCmd: null
  const routed = db.setProjectRepo("delta", dir);
  expect(routed.testCmd).toBeNull();
  expect(db.getProject("delta")?.testCmd).toBeNull();

  // lazy-union row (card tagged later, no row) via listProjects() reports {repoPath:null, testGate:true, testCmd:null}
  db.createTask({ title: "card", project: "later" });
  const row = db.listProjects().find((p) => p.name === "later");
  expect(row).toEqual({ name: "later", repoPath: null, testGate: true, testCmd: null });

  // setProjectRepo/setProjectGate round-trips (route, clear, flip gate) match the v1 test's semantics with testCmd: null throughout
  const gated = db.setProjectGate("delta", false);
  expect(gated).toEqual({ name: "delta", repoPath: dir, testGate: false, testCmd: null });

  const cleared = db.setProjectRepo("delta", null);
  expect(cleared).toEqual({ name: "delta", repoPath: null, testGate: false, testCmd: null });

  // reopen persists
  db.close();
  db = new KanbanDb(join(dir, "t.db"));
  expect(db.getProject("delta")).toEqual({ name: "delta", repoPath: null, testGate: false, testCmd: null });
});

test("projects: reopening a pre-v4 board adds test_cmd and project_agent_configs", () => {
  const path = join(dir, "old-v1-project.db");
  const raw = new Database(path);
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
    CREATE TABLE projects (
      name TEXT PRIMARY KEY,
      repo_path TEXT,
      test_gate INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO lanes (id, name, description, position, fixed) VALUES ('backlog', 'Backlog', '', 100, 1);
    INSERT INTO projects (name, repo_path, test_gate, created_at, updated_at) VALUES ('alpha', NULL, 1, 0, 0);
  `);
  raw.close();

  const reopened = new KanbanDb(path);
  expect(reopened.getProject("alpha")).toEqual({ name: "alpha", repoPath: null, testGate: true, testCmd: null });
  expect(reopened.setProjectTestCmd("alpha", "cargo test")).toEqual({
    name: "alpha",
    repoPath: null,
    testGate: true,
    testCmd: "cargo test",
  });
  expect(reopened.setProjectAgentConfig("alpha", "reviewer", { model: "m" })).toEqual({ model: "m" });
  expect(reopened.projectAgentConfig("alpha", "reviewer")).toEqual({ model: "m" });
  reopened.close();

  const second = new KanbanDb(path);
  expect(second.getProject("alpha")).toEqual({
    name: "alpha",
    repoPath: null,
    testGate: true,
    testCmd: "cargo test",
  });
  expect(second.projectAgentConfig("alpha", "reviewer")).toEqual({ model: "m" });
  second.close();
});

// ---------- lane contexts (card 3n96c) ----------

test("laneContext: seeded defaults reproduce the pipeline shape; plain lanes read null", () => {
  const plan = db.laneContext("plan")!;
  expect(plan.artifact).toBe("plan");
  expect(plan.template).toContain("### Goal");
  expect(plan.actors.map((a) => a.id)).toEqual(["planner", "plan-reviewer"]);
  expect(plan.actors.map((a) => a.author)).toEqual(["pi-planner", PLAN_REVIEWER_AUTHOR]);
  expect(plan.actors[0].instructions).toContain("You are pi-planner. Kanban card {id}");
  expect(plan.actors[0].resumeEnding).toContain("kanban attach {id} <plan-file>");
  expect(plan.actors[0].deathLabel).toBe("auto-plan");
  expect(plan.triggers).toEqual([{ kind: "on-enter" }, { kind: "human-comment" }]);
  expect(plan.exits?.map((e) => e.action)).toEqual(["next-actor", "rerun-first", "disarm"]);
  expect(plan.cap).toMatchObject({ max: 2, scope: "since-human", author: PLAN_REVIEWER_AUTHOR });
  expect(plan.gate).toEqual({
    approveTarget: "implement",
    approveOwner: BUILDER_AUTHOR,
    requireArtifact: "plan",
    rejectPrefix: "plan rejected",
  });

  const impl = db.laneContext("implement")!;
  expect(impl.actors.map((a) => a.id)).toEqual(["builder"]);
  expect(impl.actors[0].approvalInstructions).toContain("had its plan approved");
  expect(impl.triggers).toEqual([
    { kind: "comment", commentKind: "review", author: "pi-reviewer", targetActor: "builder" },
    { kind: "human-comment" },
  ]);
  expect(impl.cap).toMatchObject({ max: 3, scope: "thread", author: "pi-reviewer" });
  expect(impl.testGate).toBeUndefined();

  const review = db.laneContext("review")!;
  expect(review.actors.map((a) => a.id)).toEqual(["reviewer"]);
  expect(review.triggers).toEqual([{ kind: "on-enter" }]);
  expect(review.testGate).toBe(true);
  expect(review.gate).toBeUndefined();

  for (const plain of ["waiting", "backlog", "done", "archive", "no-such-lane"]) {
    expect(db.laneContext(plain)).toBeNull();
  }
  expect(Object.keys(db.laneContexts()).sort()).toEqual(["implement", "plan", "review"]);
  expect(db.board().laneContexts).toEqual(db.laneContexts());
});

test("setLaneContext: custom lane roundtrip, clear, and validation rejections", () => {
  const lane = db.createLane({ name: "Design" });
  expect(db.laneContext(lane.id)).toBeNull();

  const ctx: LaneContext = {
    artifact: "design",
    template: "# Design Spec",
    actors: [{ id: "designer", author: "pi-designer", instructions: 'Design {id} "{title}"' }],
    triggers: [{ kind: "on-enter" }],
    gate: { approveTarget: "plan" },
  };
  const saved = db.setLaneContext(lane.id, ctx);
  expect(saved).toMatchObject({ artifact: "design", template: "# Design Spec" });
  expect(db.laneContext("design")?.actors[0]?.id).toBe("designer");
  expect(db.laneContexts()).toHaveProperty("design");

  expect(db.setLaneContext(lane.id, null)).toBeNull();
  expect(db.laneContext(lane.id)).toBeNull();
  expect(db.laneContexts()).not.toHaveProperty("design");

  for (const fixed of ["waiting", "done", "archive"]) {
    expect(() => db.setLaneContext(fixed, { ...ctx })).toThrow(`lane '${fixed}' cannot host a workflow context`);
  }

  const actor = { id: "designer", author: "pi-designer", instructions: "d" };
  const onEnter = [{ kind: "on-enter" as const }];
  expect(() => db.setLaneContext(lane.id, { actors: [], triggers: onEnter })).toThrow("1-4 actors");
  expect(() => db.setLaneContext(lane.id, { actors: [{ ...actor, id: "Bad Actor" }], triggers: onEnter })).toThrow(
    "lowercase kebab",
  );
  expect(() =>
    db.setLaneContext(lane.id, { actors: [actor, { ...actor, author: "pi-two" }], triggers: onEnter }),
  ).toThrow("duplicate actor id 'designer'");
  expect(() => db.setLaneContext(lane.id, { actors: [{ ...actor, author: "human" }], triggers: onEnter })).toThrow(
    "actor author must start with 'pi-'",
  );
  expect(() => db.setLaneContext(lane.id, { actors: [{ ...actor, instructions: "   " }], triggers: onEnter })).toThrow(
    "actor instructions must not be empty",
  );
  expect(() => db.setLaneContext(lane.id, { actors: [actor], triggers: [] })).toThrow("at least one trigger");
  expect(() => db.setLaneContext(lane.id, { actors: [actor], triggers: onEnter, artifact: "session" })).toThrow(
    "invalid artifact name 'session'",
  );
  expect(() =>
    db.setLaneContext(lane.id, {
      actors: [actor],
      triggers: onEnter,
      cap: { max: 0, scope: "thread", match: {}, author: "pi-designer", message: "m" },
    }),
  ).toThrow("cap max must be an integer from 1 to 20");
  expect(() =>
    db.setLaneContext(lane.id, {
      actors: [actor],
      triggers: onEnter,
      cap: { max: 3, scope: "thread", match: {}, author: "human", message: "m" },
    }),
  ).toThrow("cap author must start with 'pi-'");
  expect(() => db.setLaneContext(lane.id, { actors: [actor], triggers: onEnter, gate: { approveTarget: "  " } })).toThrow(
    "gate needs an approve target lane",
  );
});

test("setLaneContext and setAgentConfig keep agent_configs and lane actor configs in sync", () => {
  // loop roles fold into the seeded lane actors (both surfaces, one state)
  db.setAgentConfig("planner", { model: "p-model", thinking: "max" });
  expect(db.laneContext("plan")!.actors[0].config).toEqual({ model: "p-model", thinking: "max" });
  expect(db.agentConfig("planner")).toEqual({ model: "p-model", thinking: "max" });

  // setLaneContext writes actor configs back to agent_configs
  const ctx = db.laneContext("plan")!;
  ctx.actors[1]!.config = { model: "pr-model" };
  db.setLaneContext("plan", ctx);
  expect(db.agentConfig("plan-reviewer")).toEqual({ model: "pr-model" });
  expect(db.agentConfig("planner")).toEqual({ model: "p-model", thinking: "max" }); // untouched actors persist

  // custom lane actors are valid agent-config roles
  const lane = db.createLane({ name: "Design" });
  db.setLaneContext(lane.id, { actors: [{ id: "designer", author: "pi-designer", instructions: "d" }], triggers: [{ kind: "on-enter" }] });
  db.setAgentConfig("designer", { model: "d-model" });
  expect(db.laneContext(lane.id)!.actors[0].config).toEqual({ model: "d-model" });
  expect(db.agentConfig("designer")).toEqual({ model: "d-model" });

  // utility roles stay in agent_configs; truly unknown roles still refuse
  expect(db.agentConfig("manager")).toBeNull();
  expect(() => db.setAgentConfig("chief", {})).toThrow(KanbanError);
});

test("custom gated lane: planReview and approve/reject route by context", () => {
  const lane = db.createLane({ name: "Design" });
  db.setLaneContext(lane.id, {
    artifact: "design",
    actors: [
      { id: "designer", author: "pi-designer", instructions: "d" },
      { id: "design-reviewer", author: "pi-design-reviewer", instructions: "dr" },
    ],
    triggers: [{ kind: "on-enter" }],
    gate: { approveTarget: "plan", approveOwner: BUILDER_AUTHOR, requireArtifact: "design", rejectPrefix: "design rejected" },
  });
  const task = db.createTask({ title: "gfx", lane: lane.id });
  expect(() => db.approveTask(task.id)).toThrow(/no attached design to approve/);
  db.attach(task.id, "design", "# spec");
  expect(() => db.planReview(task.id, { verdict: "pass" })).toThrow(/needs a message/);

  const { task: parked } = db.planReview(task.id, { verdict: "pass", message: "solid", author: "pi-design-reviewer" });
  expect(parked.laneId).toBe("waiting");
  expect(parked.previousLane).toBe(lane.id);
  expect(db.waiting(task.id)).toBe("gate");

  const { task: moved, comment } = db.approveTask(task.id);
  expect(moved.laneId).toBe("plan");
  expect(moved.owner).toBe(BUILDER_AUTHOR);
  expect(comment.body).toBe("design v1 approved — build it");

  const t2 = db.createTask({ title: "gfx2", lane: lane.id });
  db.attach(t2.id, "design", "# spec v2");
  db.planReview(t2.id, { verdict: "pass", message: "ok", author: "pi-design-reviewer" });
  const { task: returned, comment: rejection } = db.rejectTask(t2.id, "redo the layout");
  expect(returned.laneId).toBe(lane.id);
  expect(returned.previousLane).toBeNull();
  expect(rejection.body).toBe("design rejected: redo the layout");

  // a lane without a gate context still refuses the gate (message pinned by earlier tests)
  const plain = db.createTask({ title: "plain", lane: lane.id });
  db.setLaneContext(lane.id, null);
  expect(() => db.approveTask(plain.id)).toThrow(/not in the plan lane/);
});

test("migrates a pre-context board: adds lanes.context, seeds defaults folding agent_configs, reads stay write-free", () => {
  const file = join(dir, "legacy.db");
  {
    const w = new KanbanDb(file);
    w.setAgentConfig("planner", { model: "p-model", thinking: "max" });
    w.setAgentConfig("plan-reviewer", { model: "pr-model" });
    w.setAgentConfig("builder", { model: "b-model" });
    w.setAgentConfig("reviewer", { model: "r-model" });
    w.setAgentConfig("elaborator", { model: "e-model" });
    w.close();
    // rewind to the pre-context shape: drop the column and the one-time guard
    const raw = new Database(file);
    raw.exec("ALTER TABLE lanes DROP COLUMN context");
    raw.exec("DELETE FROM board_state WHERE key = 'lane_contexts_seeded'");
    raw.close();
  }
  const legacy = new KanbanDb(file);
  const plan = legacy.laneContext("plan")!;
  expect(plan.actors.map((a) => a.id)).toEqual(["planner", "plan-reviewer"]);
  expect(plan.actors[0].config).toEqual({ model: "p-model", thinking: "max" });
  expect(plan.actors[1].config).toEqual({ model: "pr-model" });
  expect(legacy.laneContext("implement")!.actors[0].config).toEqual({ model: "b-model" });
  expect(legacy.laneContext("review")!.actors[0].config).toEqual({ model: "r-model" });
  expect(legacy.agentConfig("elaborator")).toEqual({ model: "e-model" });
  legacy.close();

  // the seeded flag makes later opens (even pure reads) write-free
  const dataVersion = () => {
    const d = new Database(file);
    const v = (d.query("PRAGMA data_version").get() as { data_version: number }).data_version;
    d.close();
    return v;
  };
  const before = dataVersion();
  const reader = new KanbanDb(file);
  expect(reader.laneContext("plan")).not.toBeNull();
  reader.close();
  expect(dataVersion()).toBe(before);
});

// ---------- priority reorders the lane (hquwn) ----------

test("setting high rises a card to the lane top, low sinks it to the bottom; normal leaves position", () => {
  const a = db.createTask({ title: "a", lane: "backlog" });
  const b = db.createTask({ title: "b", lane: "backlog" });
  const c = db.createTask({ title: "c", lane: "backlog" });
  const order = () => db.laneTasks("backlog").map((t) => t.title);
  expect(order()).toEqual(["a", "b", "c"]);

  // c → high: rises above a
  db.updateTask(c.id, { priority: "high" });
  expect(order()).toEqual(["c", "a", "b"]);

  // b → low: sinks below the rest
  db.updateTask(b.id, { priority: "low" });
  expect(order()).toEqual(["c", "a", "b"]);

  // a → high: joins the top behind the other high? no — explicit top
  db.updateTask(a.id, { priority: "high" });
  expect(order()).toEqual(["a", "c", "b"]);

  // c → normal: position untouched (drag still rules)
  db.updateTask(c.id, { priority: "normal" });
  expect(order()).toEqual(["a", "c", "b"]);

  // an explicit index move wins over the priority nudge
  db.updateTask(c.id, { priority: "high", index: 2 });
  expect(order()).toEqual(["a", "b", "c"]);
  expect(db.resolveTask(c.id).priority).toBe("high");
});
