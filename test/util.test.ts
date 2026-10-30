import { expect, test } from "bun:test";
import { canPromoteToPlan, queuedChip, roleAuthor, roleVerb } from "../web/src/lib/util";

test("roleVerb maps each agent role to its chip verb", () => {
  expect(roleVerb("reviewer")).toBe("reviewing");
  expect(roleVerb("plan-reviewer")).toBe("checking plan");
  expect(roleVerb("planner")).toBe("planning");
  expect(roleVerb("elaborator")).toBe("elaborating");
  expect(roleVerb("builder")).toBe("building");
});

test("roleAuthor maps each agent role to its agent name", () => {
  expect(roleAuthor("reviewer")).toBe("pi-reviewer");
  expect(roleAuthor("plan-reviewer")).toBe("pi-plan-reviewer");
  expect(roleAuthor("planner")).toBe("pi-planner");
  expect(roleAuthor("elaborator")).toBe("pi-elaborator");
  expect(roleAuthor("builder")).toBe("pi-builder");
});

test("queuedChip renders the exact label and title", () => {
  expect(queuedChip({ taskId: "zbyb6", role: "planner", enqueuedAt: Date.now() })).toEqual({
    label: "⧗ queued · planning",
    title: "waiting for the running agent session — the loop is serial",
  });
});

test("canPromoteToPlan is true only for Backlog cards when a Plan lane exists", () => {
  const lane = (id: string) => ({ id });
  const lanes = [lane("backlog"), lane("plan")];

  expect(canPromoteToPlan({ laneId: "backlog" }, lanes)).toBe(true);
  for (const laneId of ["waiting", "implement", "review", "done", "archive", "custom-x"]) {
    expect(canPromoteToPlan({ laneId }, lanes)).toBe(false);
  }
});

test("canPromoteToPlan is false when no plan lane exists", () => {
  const lane = (id: string) => ({ id });
  const task = { laneId: "backlog" };

  expect(canPromoteToPlan(task, [])).toBe(false);
  expect(canPromoteToPlan(task, [lane("backlog")])).toBe(false);
  expect(canPromoteToPlan(task, [lane("backlog"), lane("implement")])).toBe(false);
  expect(canPromoteToPlan(task, [lane("backlog"), lane("implement"), lane("plan")])).toBe(true);
});
