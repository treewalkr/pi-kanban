import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { KanbanDb, EPICS_LANE_ID, epicPlanContext, epicPlanContextFor, type LaneContext } from "../src/db";

let dir = "";
let db: KanbanDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-epics-"));
  db = new KanbanDb(join(dir, "t.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function mkEpic(): { epic: string; c1: string; c2: string; defer: string } {
  const epic = db.createTask({ title: "epic", lane: "plan" });
  const c1 = db.createTask({ title: "c1", lane: "backlog", parent: epic.id });
  const c2 = db.createTask({ title: "c2", lane: "backlog", parent: epic.id });
  const defer = db.createTask({ title: "defer", lane: "backlog", parent: epic.id });
  return { epic: epic.id, c1: c1.id, c2: c2.id, defer: defer.id };
}

// A. the lane seeds on fresh boards and adopts on boards that predate it

test("a fresh board seeds the Epics fixed lane between Backlog and Plan", () => {
  const lanes = db.lanes();
  expect(lanes.map((l) => l.id)).toEqual(["waiting", "backlog", "epics", "plan", "implement", "review", "done", "archive"]);
  expect(lanes.find((l) => l.id === EPICS_LANE_ID)!.fixed).toBe(1);
});

test("an existing board without the lane gains it between Backlog and Plan (seed-adopt)", () => {
  const dbPath = join(dir, "old.db");
  const old = new KanbanDb(dbPath); // seeds the lane like any fresh board
  old.close();
  const raw = new Database(dbPath); // then strip it, as a pre-ceqfq board would be
  raw.run("DELETE FROM lanes WHERE id = 'epics'");
  raw.close();
  const reopened = new KanbanDb(dbPath);
  const lanes = reopened.lanes();
  const order = lanes.map((l) => l.id);
  expect(order.indexOf("backlog")).toBeLessThan(order.indexOf("epics"));
  expect(order.indexOf("epics")).toBeLessThan(order.indexOf("plan"));
  reopened.close();
});

// B/C. the charter swap

test("epicPlanContext swaps the charter in but keeps gates and exits", () => {
  const base = db.laneContext("plan")!;
  const epic = epicPlanContext();
  expect(epic.template).toContain("Boundary contracts");
  expect(epic.template).not.toContain(base.template);
  const planner = epic.actors.find((a) => a.id === "planner")!;
  expect(planner.instructions).toContain("decomposition charter");
  expect(epic.exits).toEqual(base.exits);
  expect(epic.gate?.approveTarget).toBe(base.gate?.approveTarget); // the branch is per-card, in approveTask
});

test("epicPlanContextFor charters a custom plan-like lane without discarding its workflow", () => {
  const custom: LaneContext = {
    artifact: "spec",
    template: "# build template",
    actors: [
      { id: "planner", author: "pi-planner", instructions: "build template instructions" },
      { id: "critic", author: "pi-critic", instructions: "custom critic" },
    ],
    triggers: [{ kind: "on-enter" }],
    gate: { approveTarget: "implement", rejectPrefix: "spec rejected" },
  };
  const chartered = epicPlanContextFor(custom);
  expect(chartered.template).toContain("Boundary contracts");
  expect(chartered.artifact).toBe("spec"); // the lane keeps its own artifact name
  expect(chartered.gate).toBe(custom.gate); // and its own gate
  const critic = chartered.actors.find((a) => a.id === "critic")!;
  expect(critic.instructions).toBe("custom critic"); // unknown actors untouched
  const planner = chartered.actors.find((a) => a.id === "planner")!;
  expect(planner.instructions).toContain("decomposition charter"); // seeded ids still swap
});

// D. the gate: approve arms epics into Epics, unarmed

test("approve on an epic parks it in Epics with no owner; a childless card still arms to implement", () => {
  const { epic } = mkEpic();
  const solo = db.createTask({ title: "solo", lane: "plan" });
  db.attach(epic, "plan", "# charter");
  db.attach(solo.id, "plan", "# plan");

  const approvedEpic = db.approveTask(epic);
  expect(approvedEpic.task.laneId).toBe(EPICS_LANE_ID);
  expect(approvedEpic.task.owner).toBe(null); // nothing arms a builder for an epic
  expect(approvedEpic.comment.body).toContain("decomposition locked");

  const approvedSolo = db.approveTask(solo.id);
  expect(approvedSolo.task.laneId).toBe("implement");
  expect(approvedSolo.task.owner).toBe("pi-builder");
});

// E. auto-done

test("an epic in Epics auto-dones when its last in-flight child lands; Backlog defers never block", () => {
  const { epic, c1, c2, defer } = mkEpic();
  db.updateTask(epic, { lane: EPICS_LANE_ID });
  db.updateTask(c1, { lane: "implement" });
  db.updateTask(c2, { lane: "review" });
  expect(db.resolveTask(epic).laneId).toBe(EPICS_LANE_ID);

  db.updateTask(c1, { lane: "done" }); // c2 still in review
  expect(db.resolveTask(epic).laneId).toBe(EPICS_LANE_ID);

  db.updateTask(c2, { lane: "done" }); // only the Backlog defer remains
  expect(db.resolveTask(epic).laneId).toBe("done");
  expect(db.resolveTask(defer).laneId).toBe("backlog"); // the defer survives, parked
  const comments = db.comments(epic);
  expect(comments.some((c) => c.body.includes("epic complete"))).toBe(true);
});

test("a supervising child epic counts as in flight for its grandparent", () => {
  const grand = db.createTask({ title: "grand", lane: "plan" });
  const mid = db.createTask({ title: "mid", lane: "plan", parent: grand.id });
  const leaf = db.createTask({ title: "leaf", lane: "backlog", parent: mid.id });
  db.updateTask(grand.id, { lane: EPICS_LANE_ID });
  db.updateTask(mid.id, { lane: EPICS_LANE_ID });
  db.updateTask(leaf.id, { lane: "implement" });
  expect(db.resolveTask(mid.id).laneId).toBe(EPICS_LANE_ID);
  db.updateTask(leaf.id, { lane: "done" });
  // leaf done → mid auto-dones; mid done → grand auto-dones transitively
  expect(db.resolveTask(mid.id).laneId).toBe("done");
  expect(db.resolveTask(grand.id).laneId).toBe("done");
});

// E2. entry auto-done: an epic arriving in Epics with its children already settled
// completes on arrival, not only on the next child move (review blocker, ceqfq)

test("an epic approved with settled children auto-dones on entry, authored kanban", () => {
  const epic = db.createTask({ title: "epic", lane: "plan" });
  const c1 = db.createTask({ title: "c1", lane: "backlog", parent: epic.id });
  const defer = db.createTask({ title: "defer", lane: "backlog", parent: epic.id });
  db.updateTask(c1.id, { lane: "done" });
  db.attach(epic.id, "plan", "# charter");
  const approved = db.approveTask(epic.id, { author: "user" });
  expect(approved.task.laneId).toBe("done"); // nothing in flight, a child settled
  const note = db.comments(epic.id).find((c) => c.body.includes("epic complete"));
  expect(note?.author).toBe("kanban"); // a board action, not a user comment
  expect(db.resolveTask(defer.id).laneId).toBe("backlog"); // the defer survives
});

test("an epic approved with only Backlog children still parks in Epics to supervise", () => {
  const epic = db.createTask({ title: "epic", lane: "plan" });
  db.createTask({ title: "c1", lane: "backlog", parent: epic.id });
  db.attach(epic.id, "plan", "# charter");
  const approved = db.approveTask(epic.id, { author: "user" });
  expect(approved.task.laneId).toBe(EPICS_LANE_ID); // waves unreleased — no insta-complete
});

test("a hand mv into Epics with settled children auto-dones; deleting the last in-flight child does too", () => {
  const epic = db.createTask({ title: "epic", lane: "plan" });
  const c1 = db.createTask({ title: "c1", lane: "backlog", parent: epic.id });
  const defer = db.createTask({ title: "defer", lane: "backlog", parent: epic.id });
  db.updateTask(c1.id, { lane: "done" });
  db.moveTask(epic.id, EPICS_LANE_ID);
  expect(db.resolveTask(epic.id).laneId).toBe("done");

  // same for the delete path: an in-flight child removed from an Epics epic
  const epic2 = db.createTask({ title: "epic2", lane: "plan" });
  const c2 = db.createTask({ title: "c2", lane: "backlog", parent: epic2.id });
  db.createTask({ title: "defer2", lane: "backlog", parent: epic2.id });
  db.updateTask(epic2.id, { lane: EPICS_LANE_ID }); // parks: c2 in backlog
  db.updateTask(c2.id, { lane: "implement" }); // now in flight
  expect(db.resolveTask(epic2.id).laneId).toBe(EPICS_LANE_ID);
  db.deleteTask(c2.id, true);
  expect(db.resolveTask(epic2.id).laneId).toBe("done"); // last in-flight child deleted
  void defer;
});

// F. check invariants

test("check: epic in Epics with children in workflow lanes is clean; epic in implement warns; defers under a done epic are fine", () => {
  const { epic, c1, defer } = mkEpic();
  db.updateTask(epic, { lane: EPICS_LANE_ID });
  db.updateTask(c1, { lane: "implement" });
  let v = db.boardViolations().filter((x) => x.kind === "child-behind-parent" || x.kind === "done-parent-active-children");
  expect(v).toEqual([]); // children ahead of a supervising epic = correct, not a warning

  db.updateTask(c1, { lane: "done" });
  v = db.boardViolations().filter((x) => x.kind === "done-parent-active-children");
  expect(v).toEqual([]); // the Backlog defer doesn't keep the (auto-doned) epic flagged

  const stray = db.createTask({ title: "stray epic", lane: "implement" });
  db.createTask({ title: "stray child", lane: "backlog", parent: stray.id });
  const hit = db.boardViolations().find((x) => x.kind === "epic-in-workflow-lane" && x.cardId === stray.id);
  expect(hit).toBeTruthy();
  void defer;
});
