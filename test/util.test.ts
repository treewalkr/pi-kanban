import { expect, test } from "bun:test";
import { queuedChip, roleVerb } from "../web/src/lib/util";

test("roleVerb maps each agent role to its chip verb", () => {
  expect(roleVerb("reviewer")).toBe("reviewing");
  expect(roleVerb("plan-reviewer")).toBe("checking plan");
  expect(roleVerb("planner")).toBe("planning");
  expect(roleVerb("builder")).toBe("building");
});

test("queuedChip renders the exact label and title", () => {
  expect(queuedChip({ taskId: "zbyb6", role: "planner", enqueuedAt: Date.now() })).toEqual({
    label: "⧗ queued · planning",
    title: "waiting for the running agent session — the loop is serial",
  });
});
