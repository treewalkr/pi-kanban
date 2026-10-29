import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanDb, KanbanError, UNBLOCKED_LANES } from "../src/db";

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
