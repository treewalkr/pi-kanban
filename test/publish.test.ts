import { expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseSkillFrontmatter } from "../src/skills";

const root = join(import.meta.dir, "..");

/** Directories that are personal and must never be tracked in the published tree. */
const PERSONAL_DIRS = [/^contribution-graph\//, /^\.zcode\//, /^\.playwright-cli\//, /^docs\//];

test("no personal files are tracked in the published tree", () => {
  const files = execSync("git ls-files", { cwd: root, encoding: "utf8" }).split("\n");
  const offenders = files.filter((file) => PERSONAL_DIRS.some((re) => re.test(file)));
  expect(offenders).toEqual([]);
});

test("an MIT LICENSE with the copyright line is present", () => {
  const license = readFileSync(join(root, "LICENSE"), "utf8");
  expect(license).toContain("MIT License");
  expect(license).toContain("Copyright (c) 2026 treewalkr");

  const pkg = readFileSync(join(root, "package.json"), "utf8");
  expect(pkg).toContain('"license": "MIT"');
});

test("the skill leads with the kanban CLI requirement and repo url", () => {
  const skill = readFileSync(join(root, "skills", "pi-kanban", "SKILL.md"), "utf8");
  const head = skill.slice(0, skill.indexOf("#"));
  expect(head).toContain("Requires the kanban CLI");
  expect(head).toContain("https://github.com/treewalkr/pi-kanban");
});

test("the skill frontmatter meets the skills.sh contract", () => {
  const skillPath = join(root, "skills", "pi-kanban", "SKILL.md");
  const skill = readFileSync(skillPath, "utf8");
  const { name, description } = parseSkillFrontmatter(skill);

  expect(name).toBe("pi-kanban");
  expect(name).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
  expect(name).toBe(basename(dirname(skillPath)));

  // parseSkillFrontmatter collapses whitespace and caps at 200; the raw
  // frontmatter value is what the skills CLI sees, so bound it there.
  const rawDescription = /^description:\s*(.+)$/m.exec(skill)?.[1]?.trim() ?? "";
  expect(rawDescription.length).toBeGreaterThanOrEqual(1);
  expect(rawDescription.length).toBeLessThanOrEqual(1024);
  expect(description.length).toBeGreaterThanOrEqual(1);

  // A root SKILL.md would shadow skills/ in skills.sh discovery.
  expect(existsSync(join(root, "SKILL.md"))).toBe(false);
});
