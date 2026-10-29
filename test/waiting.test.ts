import { expect, test } from "bun:test";
import { canResume, waitingBadge } from "../web/src/lib/waiting";
import type { WaitingState } from "../src/db";

test("waitingBadge renders each state with the exact label and title", () => {
  expect(waitingBadge("gate", false)).toEqual({
    state: "gate",
    label: "✓ ready — approve/reject",
    title: "plan passed review — approve or reject it",
  });
  expect(waitingBadge("question", false)).toEqual({
    state: "question",
    label: "? needs your answer",
    title: "open question — your comment re-arms the planner",
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
