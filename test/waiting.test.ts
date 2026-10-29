import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanDb, type WaitingState } from "../src/db";
import { canResume, waitingBadge } from "../web/src/lib/waiting";

test("waitingBadge renders each state with the exact label and title", () => {
  expect(waitingBadge("gate", false)).toEqual({
    state: "gate",
    label: "✓ ready — approve/reject",
    title: "plan passed review — approve or reject it",
  });
  expect(waitingBadge("question", false)).toEqual({
    state: "question",
    label: "? needs your answer",
    title: "open question — your comment returns the card and re-arms its agent",
  });
  expect(waitingBadge("rerun", false)).toEqual({
    state: "rerun",
    label: "↻ comment to re-run",
    title: "review session ended without a verdict — comment to re-run it",
  });
  expect(waitingBadge("capped", false)).toEqual({
    state: "capped",
    label: "‖ needs a human",
    title: "review cap reached — reject to re-plan, or comment to re-run",
  });
});

test("waitingBadge yields to the live chip and hides absent states", () => {
  // the ◌ working chip owns card-meta while an agent session is live
  expect(waitingBadge("gate", true)).toBeNull();
  expect(waitingBadge("capped", true)).toBeNull();
  expect(waitingBadge("dead", true)).toBeNull();
  // no state → nothing to show
  expect(waitingBadge(undefined, false)).toBeNull();
  expect(waitingBadge(undefined, true)).toBeNull();
});

test("dead badge renders with the exact label and title and yields to the live chip", () => {
  expect(waitingBadge("dead", false)).toEqual({
    state: "dead",
    label: "✗ session died",
    title: "agent session died — open the thread for the reason; comment to re-run it",
  });
  expect(waitingBadge("dead", true)).toBeNull();
});

test("every WaitingState has badge copy (compile-time-complete map)", () => {
  for (const state of ["gate", "question", "rerun", "capped", "dead"] as WaitingState[]) {
    expect(waitingBadge(state, false)?.state).toBe(state);
  }
});

test("canResume is true only for dead-and-not-busy", () => {
  expect(canResume("dead", false)).toBe(true);
  for (const state of ["gate", "question", "rerun", "capped"] as WaitingState[]) {
    expect(canResume(state, false)).toBe(false);
    expect(canResume(state, true)).toBe(false);
  }
  expect(canResume("dead", true)).toBe(false);
  expect(canResume(undefined, false)).toBe(false);
  expect(canResume(undefined, true)).toBe(false);
});

test("db.comment parks on question and returns on human reply", () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-waiting-test-"));
  const db = new KanbanDb(join(dir, "t.db"));
  try {
    const custom = db.createLane({ name: "Custom" });
    for (const lane of ["plan", "implement", "review", custom.id]) {
      const task = db.createTask({ title: `task in ${lane}`, lane });
      const parkRes = db.comment(task.id, { kind: "question", body: "need input", author: "pi-planner" });
      expect(parkRes.moved).toBe("parked");
      expect(parkRes.task.laneId).toBe("waiting");
      expect(parkRes.task.previousLane).toBe(lane);
      expect(db.comments(task.id)).toHaveLength(1);

      const returnRes = db.comment(task.id, { body: "here is input", author: "user" });
      expect(returnRes.moved).toBe("returned");
      expect(returnRes.task.laneId).toBe(lane);
      expect(returnRes.task.previousLane).toBeNull();
      expect(db.comments(task.id)).toHaveLength(2);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleared previous_lane never bounces", () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-waiting-test-"));
  const db = new KanbanDb(join(dir, "t.db"));
  try {
    const task = db.createTask({ title: "roundtrip", lane: "implement" });
    db.comment(task.id, { kind: "question", body: "question?" });
    const returned = db.comment(task.id, { body: "answer" });
    expect(returned.task.laneId).toBe("implement");
    expect(returned.task.previousLane).toBeNull();

    db.moveTask(task.id, "waiting");
    const inWaiting = db.resolveTask(task.id);
    expect(inWaiting.laneId).toBe("waiting");
    expect(inWaiting.previousLane).toBeNull();

    const commentRes = db.comment(task.id, { body: "another human comment" });
    expect(commentRes.moved).toBeNull();
    expect(commentRes.task.laneId).toBe("waiting");
    expect(commentRes.task.previousLane).toBeNull();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("park/return edge rules", () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-waiting-test-"));
  const db = new KanbanDb(join(dir, "t.db"));
  try {
    const manual = db.createTask({ title: "manual", lane: "backlog" });
    db.moveTask(manual.id, "waiting");
    expect(db.resolveTask(manual.id).previousLane).toBeNull();
    const c1 = db.comment(manual.id, { body: "hello", author: "human" });
    expect(c1.moved).toBeNull();
    expect(c1.task.laneId).toBe("waiting");

    const parked = db.createTask({ title: "parked", lane: "implement" });
    db.comment(parked.id, { kind: "question", body: "question?" });
    const piComment = db.comment(parked.id, { body: "agent chatting", author: "pi-builder" });
    expect(piComment.moved).toBeNull();
    expect(piComment.task.laneId).toBe("waiting");
    expect(piComment.task.previousLane).toBe("implement");

    const q2 = db.comment(parked.id, { kind: "question", body: "second question?", author: "user" });
    expect(q2.moved).toBeNull();
    expect(q2.task.laneId).toBe("waiting");
    expect(q2.task.previousLane).toBe("implement");

    for (const lane of ["done", "archive"]) {
      const card = db.createTask({ title: `in ${lane}`, lane });
      const qDone = db.comment(card.id, { kind: "question", body: "question on done" });
      expect(qDone.moved).toBeNull();
      expect(qDone.task.laneId).toBe(lane);
      expect(qDone.task.previousLane).toBeNull();
    }

    const customLane = db.createLane({ name: "Temporary" });
    const customCard = db.createTask({ title: "in temp", lane: customLane.id });
    db.comment(customCard.id, { kind: "question", body: "temp question?" });
    expect(db.resolveTask(customCard.id).laneId).toBe("waiting");
    expect(db.resolveTask(customCard.id).previousLane).toBe(customLane.id);
    db.deleteLane(customLane.id);
    const deletedReturn = db.comment(customCard.id, { body: "answer after lane deleted" });
    expect(deletedReturn.moved).toBe("returned");
    expect(deletedReturn.task.laneId).toBe("backlog");
    expect(deletedReturn.task.previousLane).toBeNull();

    const parkedForStates = db.createTask({ title: "states", lane: "implement" });
    db.comment(parkedForStates.id, { kind: "question", body: "states?" });
    expect(db.waiting(parkedForStates.id)).toBe("question");
    expect(db.waitingStates()[parkedForStates.id]).toBe("question");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
