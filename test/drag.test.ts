import { beforeEach, describe, expect, test } from "bun:test";
import { drag, DRAG_THRESHOLD_PX, TOUCH_HOLD_MS, TOUCH_SLACK_PX, FLIP_DURATION_MS } from "../web/src/lib/drag.svelte";
import { board } from "../web/src/lib/board.svelte";
import type { Lane, Task } from "../src/db";

function makeLane(id: string, name: string): Lane {
  return {
    id,
    name,
    description: "",
    position: 0,
    fixed: 0,
    wipLimit: null,
  };
}

function makeTask(partial: Partial<Task> & { id: string; title: string; laneId: string }): Task {
  return {
    note: "",
    project: "",
    tags: [],
    parentId: null,
    previousLane: null,
    workspace: null,
    owner: null,
    priority: "normal",
    position: 100,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

describe("drag module constants and state", () => {
  test("constants are exported with expected values", () => {
    expect(DRAG_THRESHOLD_PX).toBe(4);
    expect(TOUCH_HOLD_MS).toBe(250);
    expect(TOUCH_SLACK_PX).toBe(8);
    expect(FLIP_DURATION_MS).toBe(180);
  });

  test("lifted derives from taskId !== null", () => {
    drag.taskId = null;
    expect(drag.lifted).toBe(false);
    drag.taskId = "card-1";
    expect(drag.lifted).toBe(true);
    drag.taskId = null;
  });

  test("press ignores non-primary buttons and interactive targets", () => {
    const task = makeTask({ id: "X", title: "X", laneId: "backlog" });
    const fakeEventRightClick = {
      button: 2,
      target: { closest: () => null },
      stopPropagation: () => {},
    } as any;
    drag.press(task, fakeEventRightClick);
    expect(drag.taskId).toBeNull();

    const fakeEventButton = {
      button: 0,
      target: { closest: (sel: string) => (sel.includes("button") ? {} : null) },
      stopPropagation: () => {},
    } as any;
    drag.press(task, fakeEventButton);
    expect(drag.taskId).toBeNull();
  });
});

describe("drag displayTasks", () => {
  const lane1 = "backlog";
  const lane2 = "plan";

  const taskA = makeTask({ id: "A", title: "Card A", laneId: lane1, position: 10 });
  const taskB = makeTask({ id: "B", title: "Card B", laneId: lane1, position: 20 });
  const taskC = makeTask({ id: "C", title: "Card C", laneId: lane1, position: 30 });
  const taskD = makeTask({ id: "D", title: "Card D", laneId: lane2, position: 10 });

  beforeEach(() => {
    board.lanes = [makeLane(lane1, "Backlog"), makeLane(lane2, "Plan")];
    board.tasks = [taskA, taskB, taskC, taskD];
    board.search = "";
    board.projectFilter = "";
    drag.taskId = null;
    drag.hint = null;
  });

  test("displayTasks re-inserts the dragged card at the top hint and keeps others keyed", () => {
    // no drag → [A, B, C]
    expect(drag.displayTasks(lane1).map((t) => t.id)).toEqual(["A", "B", "C"]);

    // drag.taskId = A, hint { kind: "top", laneId: "backlog", index: 2 } → [B, C, A]
    drag.taskId = "A";
    drag.hint = { kind: "top", laneId: lane1, index: 2 };
    expect(drag.displayTasks(lane1).map((t) => t.id)).toEqual(["B", "C", "A"]);

    // hint { kind: "top", laneId: "backlog", index: 1 } → [B, A, C]
    drag.hint = { kind: "top", laneId: lane1, index: 1 };
    expect(drag.displayTasks(lane1).map((t) => t.id)).toEqual(["B", "A", "C"]);

    // cross-lane: source lane omits A, target lane gains A at index
    drag.hint = { kind: "top", laneId: lane2, index: 0 };
    expect(drag.displayTasks(lane1).map((t) => t.id)).toEqual(["B", "C"]);
    expect(drag.displayTasks(lane2).map((t) => t.id)).toEqual(["A", "D"]);

    drag.hint = { kind: "top", laneId: lane2, index: 1 };
    expect(drag.displayTasks(lane2).map((t) => t.id)).toEqual(["D", "A"]);
  });
});

describe("drag displayNest", () => {
  const lane = "backlog";
  const epic = makeTask({ id: "epic", title: "Epic", laneId: lane, position: 10 });
  const c1 = makeTask({ id: "c1", title: "Child 1", laneId: lane, parentId: "epic", position: 10 });
  const c2 = makeTask({ id: "c2", title: "Child 2", laneId: lane, parentId: "epic", position: 20 });
  const c3 = makeTask({ id: "c3", title: "Child 3", laneId: lane, parentId: "epic", position: 30 });

  beforeEach(() => {
    board.lanes = [makeLane(lane, "Backlog")];
    board.tasks = [epic, c1, c2, c3];
    board.search = "";
    board.projectFilter = "";
    drag.taskId = null;
    drag.hint = null;
  });

  test("displayNest reorders siblings on a child hint and drops the child on a top hint", () => {
    // no drag → [c1, c2, c3]
    expect(drag.displayNest(epic).map((t) => t.id)).toEqual(["c1", "c2", "c3"]);

    drag.taskId = "c1";

    // child hint before c3 → [c2, c1, c3]
    drag.hint = { kind: "child", parentId: "epic", before: "c3" };
    expect(drag.displayNest(epic).map((t) => t.id)).toEqual(["c2", "c1", "c3"]);

    // child hint append → [c2, c3, c1]
    drag.hint = { kind: "child", parentId: "epic", before: undefined };
    expect(drag.displayNest(epic).map((t) => t.id)).toEqual(["c2", "c3", "c1"]);

    // child hint before c2 → [c1, c2, c3]
    drag.hint = { kind: "child", parentId: "epic", before: "c2" };
    expect(drag.displayNest(epic).map((t) => t.id)).toEqual(["c1", "c2", "c3"]);

    // top-kind hint → c1 absent from nest
    drag.hint = { kind: "top", laneId: lane, index: 1 };
    expect(drag.displayNest(epic).map((t) => t.id)).toEqual(["c2", "c3"]);
  });
});
