import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanDb, KanbanError, PRIORITIES, UNBLOCKED_LANES } from "../src/db";
import { Database } from "bun:sqlite";

let dir = "";
let db: KanbanDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-triage-"));
  db = new KanbanDb(join(dir, "t.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("setBlockedBy: replaces, dedupes, and reads both directions", () => {
  const a = db.createTask({ title: "card A" });
  const b = db.createTask({ title: "card B" });
  const c = db.createTask({ title: "card C" });

  // A is blocked by B and C
  db.setBlockedBy(a.id, [b.id, c.id]);

  expect(db.blockers(a.id).map((t) => t.id)).toEqual([b.id, c.id]);
  expect(db.blocking(b.id).map((t) => t.id)).toEqual([a.id]);
  expect(db.blocking(c.id).map((t) => t.id)).toEqual([a.id]);

  // blockedByMap is sparse: only a has blockers
  expect(db.blockedByMap()).toEqual({ [a.id]: [b.id, c.id] });

  // duplicate refs collapse
  db.setBlockedBy(a.id, [b.id, b.id, b.id]);
  expect(db.blockers(a.id).map((t) => t.id)).toEqual([b.id]);
  expect(db.blockedByMap()).toEqual({ [a.id]: [b.id] });

  // repeat call replaces the set (old edges removed)
  db.setBlockedBy(a.id, [c.id]);
  expect(db.blockers(a.id).map((t) => t.id)).toEqual([c.id]);
  expect(db.blocking(b.id)).toEqual([]);
  expect(db.blocking(c.id).map((t) => t.id)).toEqual([a.id]);
  expect(db.blockedByMap()).toEqual({ [a.id]: [c.id] });

  // clearing set
  db.setBlockedBy(a.id, []);
  expect(db.blockers(a.id)).toEqual([]);
  expect(db.blocking(c.id)).toEqual([]);
  expect(db.blockedByMap()).toEqual({});
});

test("setBlockedBy: refuses self-edges and cycles", () => {
  const a = db.createTask({ title: "card A" });
  const b = db.createTask({ title: "card B" });
  const c = db.createTask({ title: "card C" });

  // self-edge refused with conflict
  expect(() => db.setBlockedBy(a.id, [a.id])).toThrow(KanbanError);
  try {
    db.setBlockedBy(a.id, [a.id]);
  } catch (err: any) {
    expect(err.code).toBe("conflict");
  }

  // A is blocked by B
  db.setBlockedBy(a.id, [b.id]);

  // B is blocked by A -> cycle refused with conflict
  expect(() => db.setBlockedBy(b.id, [a.id])).toThrow(KanbanError);
  try {
    db.setBlockedBy(b.id, [a.id]);
  } catch (err: any) {
    expect(err.code).toBe("conflict");
  }

  // Multi-hop cycle: C blocked by A (so C -> A -> B)
  db.setBlockedBy(c.id, [a.id]);
  // B blocked by C would make B -> C -> A -> B -> cycle!
  expect(() => db.setBlockedBy(b.id, [c.id])).toThrow(KanbanError);

  // Replace-set validated against graph minus own outgoing edges:
  // Fresh tasks to isolate:
  const x = db.createTask({ title: "card X" });
  const y = db.createTask({ title: "card Y" });
  const z = db.createTask({ title: "card Z" });

  // Y is blocked by X
  db.setBlockedBy(y.id, [x.id]);
  // Z is blocked by Y (Z -> Y -> X)
  db.setBlockedBy(z.id, [y.id]);

  // X blocked by Z would cycle (X -> Z -> Y -> X)
  expect(() => db.setBlockedBy(x.id, [z.id])).toThrow(KanbanError);

  // Now replace Z's blockers with empty set (removes Z -> Y)
  db.setBlockedBy(z.id, []);

  // Now X blocked by Z is allowed because Z no longer reaches X
  db.setBlockedBy(x.id, [z.id]);
  expect(db.blockers(x.id).map((t) => t.id)).toEqual([z.id]);

  // And in the reverse: setting Z's blockers to [x.id] when X is blocked by Z is refused
  expect(() => db.setBlockedBy(z.id, [x.id])).toThrow(KanbanError);
});

test("soft blocking: done/archive blockers stop blocking", () => {
  const blocker = db.createTask({ title: "Blocker", lane: "backlog" });
  const dependent = db.createTask({ title: "Dependent", lane: "backlog" });

  db.setBlockedBy(dependent.id, [blocker.id]);

  // Check blockers initially
  const bInitial = db.blockers(dependent.id);
  expect(bInitial.length).toBe(1);
  expect(UNBLOCKED_LANES.includes(bInitial[0].laneId as any)).toBe(false);

  // Move blocker to done
  db.moveTask(blocker.id, "done");
  const bDone = db.blockers(dependent.id);
  expect(bDone.length).toBe(1);
  expect(bDone[0].laneId).toBe("done");
  expect(UNBLOCKED_LANES.includes(bDone[0].laneId as any)).toBe(true);

  // Edge remains present in blockedByMap
  expect(db.blockedByMap()).toEqual({ [dependent.id]: [blocker.id] });

  // Move blocker to archive
  db.moveTask(blocker.id, "archive");
  const bArchive = db.blockers(dependent.id);
  expect(bArchive[0].laneId).toBe("archive");
  expect(UNBLOCKED_LANES.includes(bArchive[0].laneId as any)).toBe(true);
  expect(db.blockedByMap()).toEqual({ [dependent.id]: [blocker.id] });
});

test("priority: defaults, backfill, and validation", () => {
  // fresh card defaults to normal
  const task = db.createTask({ title: "default priority" });
  expect(task.priority).toBe("normal");

  // explicit tiers round-trip on create
  const high = db.createTask({ title: "urgent", priority: "high" });
  expect(high.priority).toBe("high");
  const low = db.createTask({ title: "eventual", priority: "low" });
  expect(low.priority).toBe("low");

  // update tier
  const updated = db.updateTask(task.id, { priority: "high" });
  expect(updated.priority).toBe("high");
  expect(db.resolveTask(task.id).priority).toBe("high");

  // invalid tier rejected on create and update
  expect(() => db.createTask({ title: "bad", priority: "urgent" as any })).toThrow(KanbanError);
  try {
    db.createTask({ title: "bad", priority: "urgent" as any });
  } catch (err: any) {
    expect(err.code).toBe("invalid");
  }

  expect(() => db.updateTask(task.id, { priority: "critical" as any })).toThrow(KanbanError);
  try {
    db.updateTask(task.id, { priority: "critical" as any });
  } catch (err: any) {
    expect(err.code).toBe("invalid");
  }

  // Pre-existing DB backfill: simulate board written before priority column existed
  const oldPath = join(dir, "old-pre-priority.db");
  const raw = new Database(oldPath);
  raw.exec(`
    CREATE TABLE lanes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      position REAL NOT NULL, fixed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      lane_id TEXT NOT NULL REFERENCES lanes (id), project TEXT NOT NULL DEFAULT '',
      parent_id TEXT REFERENCES tasks (id),
      position REAL NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO lanes (id, name, description, position, fixed) VALUES ('backlog', 'Backlog', '', 100, 1);
    INSERT INTO tasks (id, title, note, lane_id, project, parent_id, position, created_at, updated_at)
      VALUES ('leg01', 'legacy one', '', 'backlog', '', NULL, 100, 1, 1),
             ('leg02', 'legacy two', '', 'backlog', '', NULL, 200, 2, 2);
  `);
  raw.close();

  // Reopen with KanbanDb
  const reopened = new KanbanDb(oldPath);
  const rows = reopened.tasks();
  expect(rows.length).toBe(2);
  expect(rows[0].priority).toBe("normal");
  expect(rows[1].priority).toBe("normal");
  expect(reopened.resolveTask("leg01").priority).toBe("normal");
  reopened.close();
});

test("nextTask: priority rank beats age, lane rank beats priority", () => {
  // Within a lane: high-newer beats normal-older
  const olderNormal = db.createTask({ title: "older normal", lane: "backlog", priority: "normal" });
  const newerHigh = db.createTask({ title: "newer high", lane: "backlog", priority: "high" });

  const raw = new Database(join(dir, "t.db"));
  raw.run("UPDATE tasks SET created_at = 1000 WHERE id = ?", [olderNormal.id]);
  raw.run("UPDATE tasks SET created_at = 2000 WHERE id = ?", [newerHigh.id]);
  raw.close();

  // high beats normal despite being created later
  const res1 = db.nextTask();
  expect(res1.task?.id).toBe(newerHigh.id);
  expect(res1.blocked).toBe(0);

  // normal beats low
  const lowCard = db.createTask({ title: "low card", lane: "backlog", priority: "low" });
  const raw2 = new Database(join(dir, "t.db"));
  raw2.run("UPDATE tasks SET created_at = 500 WHERE id = ?", [lowCard.id]);
  raw2.close();

  db.moveTask(newerHigh.id, "done");
  const res2 = db.nextTask();
  expect(res2.task?.id).toBe(olderNormal.id);

  db.moveTask(olderNormal.id, "done");
  const res3 = db.nextTask();
  expect(res3.task?.id).toBe(lowCard.id);

  // Lane rank beats priority: low-priority review card beats high backlog card
  const highBacklog = db.createTask({ title: "urgent backlog", lane: "backlog", priority: "high" });
  const lowReview = db.createTask({ title: "low review", lane: "review", priority: "low" });

  const res4 = db.nextTask();
  expect(res4.task?.id).toBe(lowReview.id);
});

test("nextTask: skips blocked and counts", () => {
  // Blocker card in backlog, dependent card in review
  const blocker = db.createTask({ title: "blocker", lane: "backlog" });
  const reviewCard = db.createTask({ title: "blocked review", lane: "review" });
  db.setBlockedBy(reviewCard.id, [blocker.id]);

  const impCard = db.createTask({ title: "eligible implement", lane: "implement" });

  // Review lane is entirely blocked; next picks implement card and reports 0 blocked in implement
  const res = db.nextTask();
  expect(res.task?.id).toBe(impCard.id);
  expect(res.blocked).toBe(0);

  // Now add another card in implement, but blocked
  const impBlocked = db.createTask({ title: "blocked imp", lane: "implement" });
  db.setBlockedBy(impBlocked.id, [blocker.id]);

  const resImp = db.nextTask();
  expect(resImp.task?.id).toBe(impCard.id);
  expect(resImp.blocked).toBe(1);

  // Moving blocker to done unblocks dependents
  db.moveTask(blocker.id, "done");
  const resUnblocked = db.nextTask();
  // Review lane card is now unblocked and wins because review > implement
  expect(resUnblocked.task?.id).toBe(reviewCard.id);
  expect(resUnblocked.blocked).toBe(0);

  // Clean up
  db.moveTask(reviewCard.id, "done");
  db.moveTask(impCard.id, "done");
  db.moveTask(impBlocked.id, "done");

  // Nothing eligible anywhere -> task null + highest-priority lane's count
  // Blocker lives in a custom lane (not in NEXT_LANE_PRIORITY, but not done/archive)
  const extLane = db.createLane({ name: "External" });
  const blocker2 = db.createTask({ title: "active blocker", lane: extLane.id });
  const revBlocked1 = db.createTask({ title: "rev1", lane: "review" });
  const revBlocked2 = db.createTask({ title: "rev2", lane: "review" });
  db.setBlockedBy(revBlocked1.id, [blocker2.id]);
  db.setBlockedBy(revBlocked2.id, [blocker2.id]);

  // Review has 2 blocked cards, nothing eligible anywhere
  const resNone = db.nextTask();
  expect(resNone.task).toBeNull();
  expect(resNone.blocked).toBe(2);

  // Project filter respected
  const pA = db.createTask({ title: "proj A", lane: "plan", project: "alpha" });
  const pB = db.createTask({ title: "proj B", lane: "review", project: "beta" });
  db.setBlockedBy(pB.id, [blocker2.id]);

  // For project "beta", only review holds cards and it's blocked
  const resBeta = db.nextTask("beta");
  expect(resBeta.task).toBeNull();
  expect(resBeta.blocked).toBe(1);

  // For project "alpha", plan card is eligible
  const resAlpha = db.nextTask("alpha");
  expect(resAlpha.task?.id).toBe(pA.id);
  expect(resAlpha.blocked).toBe(0);
});
