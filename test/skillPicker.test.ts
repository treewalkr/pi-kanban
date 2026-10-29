import { expect, test } from "bun:test";
import type { CatalogSkill } from "../src/skills";
import { filterSkills, offerCustomPath, skillLabel, toggleSkill } from "../web/src/lib/skillPicker";

const catalog: CatalogSkill[] = [
  { name: "tdd", description: "Test-driven development. Red-green-refactor.", path: "~/.pi/agent/skills/tdd" },
  { name: "caveman", description: "Terse caveman voice: answer first.", path: "~/.pi/agent/skills/caveman" },
  { name: "pi-kanban", description: "Board task management.", path: "~/.pi/agent/skills/pi-kanban" },
];

test("filterSkills matches name or description case-insensitively; blank query returns all", () => {
  // blank / whitespace query returns all
  expect(filterSkills(catalog, "")).toEqual(catalog);
  expect(filterSkills(catalog, "   ")).toEqual(catalog);

  // query hitting only description matches
  const descMatch = filterSkills(catalog, "refactor");
  expect(descMatch).toHaveLength(1);
  expect(descMatch[0].name).toBe("tdd");

  // mixed-case query matches lower-case fields
  const mixedCase = filterSkills(catalog, "CaVeMaN");
  expect(mixedCase).toHaveLength(1);
  expect(mixedCase[0].name).toBe("caveman");

  // no match returns []
  expect(filterSkills(catalog, "nonexistent-skill-query")).toEqual([]);
});

test("toggleSkill appends at the end, removes in place, never duplicates", () => {
  const initial = ["~/.pi/agent/skills/tdd", "~/.pi/agent/skills/caveman"];

  // absent path appended at end
  const added = toggleSkill(initial, "~/.pi/agent/skills/pi-kanban");
  expect(added).toEqual([
    "~/.pi/agent/skills/tdd",
    "~/.pi/agent/skills/caveman",
    "~/.pi/agent/skills/pi-kanban",
  ]);

  // present path removed preserving order
  const removed = toggleSkill(initial, "~/.pi/agent/skills/tdd");
  expect(removed).toEqual(["~/.pi/agent/skills/caveman"]);

  // toggling an already-present path removes it
  const toggledBack = toggleSkill(added, "~/.pi/agent/skills/pi-kanban");
  expect(toggledBack).toEqual(initial);
});

test("offerCustomPath only when the query is non-blank and nothing matched", () => {
  expect(offerCustomPath("tdd", 1)).toBe(false);
  expect(offerCustomPath("tdd", 0)).toBe(true);
  expect(offerCustomPath("", 0)).toBe(false);
  expect(offerCustomPath("   ", 0)).toBe(false);
  expect(offerCustomPath("", 1)).toBe(false);
});

test("skillLabel resolves catalog names and flags unknown paths", () => {
  expect(skillLabel("~/.pi/agent/skills/tdd", catalog)).toEqual({
    label: "tdd",
    known: true,
  });
  expect(skillLabel("/custom/path/to/skill", catalog)).toEqual({
    label: "/custom/path/to/skill",
    known: false,
  });
});
