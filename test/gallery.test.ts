import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("gallery seed loads the skill catalog for the picker", () => {
  const mocksPath = join(import.meta.dir, "..", "web", "src", "gallery", "mocks.ts");
  const content = readFileSync(mocksPath, "utf8");

  expect(content).toContain("agents.skills = [");
  expect(content).toContain('path: "~/.pi/agent/skills/tdd"');
  expect(content).toContain("caveman");

  const seedBlock = content.slice(content.indexOf("agents.skills = ["));
  const arrayContent = seedBlock.slice(0, seedBlock.indexOf("];") + 2);
  const pathMatches = arrayContent.match(/path:\s*"/g);
  expect(pathMatches ? pathMatches.length : 0).toBeGreaterThanOrEqual(2);
});
