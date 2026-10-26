import { expect, test } from "bun:test";
import { waitingBadge } from "../web/src/lib/waiting";
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
    label: "⏸ needs a human",
    title: "review cap reached — reject to re-plan, or comment to re-run",
  });
});

test("waitingBadge yields to the live chip and hides absent states", () => {
  // the ◌ working chip owns card-meta while an agent session is live
  expect(waitingBadge("gate", true)).toBeNull();
  expect(waitingBadge("capped", true)).toBeNull();
  // no state → nothing to show
  expect(waitingBadge(undefined, false)).toBeNull();
  expect(waitingBadge(undefined, true)).toBeNull();
});

test("every WaitingState has badge copy (compile-time-complete map)", () => {
  for (const state of ["gate", "question", "rerun", "capped"] as WaitingState[]) {
    expect(waitingBadge(state, false)?.state).toBe(state);
  }
});
