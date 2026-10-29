import { expect, test } from "bun:test";
import { queuedChip, roleAuthor, roleVerb } from "../web/src/lib/util";

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
