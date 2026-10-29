import { expect, test } from "bun:test";
import type { Task } from "../src/db";
import { listRows } from "../web/src/lib/listview";

function task(partial: Partial<Task> & { id: string; title: string }): Task {
  return {
    note: "",
    laneId: "backlog",
    project: "",
    parentId: null,
    priority: "normal",
    position: 100,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

test("nests children under parents regardless of lane", () => {
  const rows = listRows(
    [
      task({ id: "p", title: "parent", laneId: "backlog", updatedAt: 10 }),
      task({ id: "c", title: "child ahead", laneId: "implement", parentId: "p", updatedAt: 20 }),
      task({ id: "g", title: "grandchild", laneId: "done", parentId: "c", updatedAt: 30 }),
    ],
    () => true,
  );

  expect(rows.map((r) => r.task.id)).toEqual(["p", "c", "g"]);
  expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
});

test("orphans render as roots when the parent is archived or missing", () => {
  const rows = listRows(
    [
      task({ id: "ap", title: "archived parent", laneId: "archive" }),
      task({ id: "c1", title: "child of archived", parentId: "ap", updatedAt: 5 }),
      task({ id: "c2", title: "child of deleted", parentId: "gone", updatedAt: 6 }),
    ],
    () => true,
  );

  expect(rows.map((r) => r.task.id)).toEqual(["c2", "c1"]);
  expect(rows.every((r) => r.depth === 0)).toBe(true);
});

test("archive-lane tasks never render, but still count toward progress", () => {
  const rows = listRows(
    [
      task({ id: "p", title: "parent", laneId: "backlog" }),
      task({ id: "d", title: "done child", laneId: "done", parentId: "p" }),
      task({ id: "a", title: "archived child", laneId: "archive", parentId: "p" }),
    ],
    () => true,
  );

  expect(rows.map((r) => r.task.id)).toEqual(["p", "d"]);
  const parent = rows[0]!;
  expect(parent.total).toBe(2);
  expect(parent.done).toBe(1);
});

test("a parent's progress spans all descendants, any lane", () => {
  const rows = listRows(
    [
      task({ id: "p", title: "epic", laneId: "implement" }),
      task({ id: "s", title: "story", laneId: "implement", parentId: "p" }),
      task({ id: "w1", title: "done work", laneId: "done", parentId: "s" }),
      task({ id: "w2", title: "open work", laneId: "backlog", parentId: "s" }),
      task({ id: "solo", title: "childless", laneId: "plan" }),
    ],
    () => true,
  );

  const epic = rows.find((r) => r.task.id === "p")!;
  expect(epic.done).toBe(1);
  expect(epic.total).toBe(3);
  const childless = rows.find((r) => r.task.id === "solo")!;
  expect(childless.total).toBe(0);
});

test("filter keeps matching children with dimmed ancestors, hides the rest", () => {
  const rows = listRows(
    [
      task({ id: "p", title: "parent", laneId: "backlog" }),
      task({ id: "hit", title: "needle child", parentId: "p", laneId: "implement" }),
      task({ id: "miss", title: "other child", parentId: "p", laneId: "review" }),
    ],
    (t) => t.title.includes("needle"),
  );

  expect(rows.map((r) => r.task.id)).toEqual(["p", "hit"]);
  expect(rows[0]!.dim).toBe(true); // kept only as context
  expect(rows[1]!.dim).toBe(false);
});

test("a matching parent shows its whole subtree", () => {
  const rows = listRows(
    [
      task({ id: "p", title: "needle parent", laneId: "backlog" }),
      task({ id: "c", title: "no mention here", parentId: "p", laneId: "plan" }),
    ],
    (t) => t.title.includes("needle"),
  );

  expect(rows.map((r) => r.task.id)).toEqual(["p", "c"]);
  expect(rows.every((r) => !r.dim)).toBe(true);
});

test("returns nothing when nothing matches", () => {
  const rows = listRows(
    [task({ id: "p", title: "parent" }), task({ id: "c", title: "child", parentId: "p" })],
    () => false,
  );
  expect(rows).toEqual([]);
});

test("roots sort by subtree recency, children by position", () => {
  const rows = listRows(
    [
      task({ id: "quiet", title: "quiet parent", laneId: "backlog", updatedAt: 50 }),
      task({ id: "active", title: "active parent", laneId: "plan", updatedAt: 10 }),
      task({ id: "busy", title: "busy child", laneId: "implement", parentId: "active", position: 200, updatedAt: 90 }),
      task({ id: "idle", title: "idle child", laneId: "backlog", parentId: "active", position: 100, updatedAt: 20 }),
    ],
    () => true,
  );

  // active's subtree (max updatedAt 90) outranks quiet (50)
  expect(rows.map((r) => r.task.id)).toEqual(["active", "idle", "busy", "quiet"]);
  const active = rows[0]!;
  expect(active.subtreeUpdated).toBe(90);
});
