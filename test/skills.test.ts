import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { listPiSkills, parseSkillFrontmatter } from "../src/skills";

const tempDirs: string[] = [];
function makeTemp(prefix: string, parent: string = tmpdir()): string {
  const d = mkdtempSync(join(parent, prefix));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

test("parseSkillFrontmatter reads single-line, folded, and absent metadata", () => {
  const single = `---
name: tdd
description: Test-driven development. Use when the user wants to build features.
---
# Body`;
  expect(parseSkillFrontmatter(single)).toEqual({
    name: "tdd",
    description: "Test-driven development. Use when the user wants to build features.",
  });

  const folded = `---
name: caveman
description: >
  Terse caveman voice: answer first, fluff gone, every technical fact kept.
  Use for /caveman, "caveman mode", "talk like caveman".
---
# Body`;
  expect(parseSkillFrontmatter(folded)).toEqual({
    name: "caveman",
    description: 'Terse caveman voice: answer first, fluff gone, every technical fact kept. Use for /caveman, "caveman mode", "talk like caveman".',
  });

  expect(parseSkillFrontmatter("# Just markdown\nNo frontmatter here.")).toEqual({
    name: "",
    description: "",
  });

  const longDesc = "a".repeat(350);
  const longFm = `---
name: pi-kanban
description: ${longDesc}
---
# Body`;
  const parsed = parseSkillFrontmatter(longFm);
  expect(parsed.name).toBe("pi-kanban");
  expect(parsed.description.length).toBe(200);
  expect(parsed.description).toBe("a".repeat(200));
});

test("listPiSkills scans a root, skips non-skills, sorts by name", () => {
  const root = makeTemp("kanban-skills-test-");

  // skill with frontmatter (named "zebra")
  const skillZ = join(root, "z-dir");
  mkdirSync(skillZ);
  writeFileSync(join(skillZ, "SKILL.md"), "---\nname: zebra\ndescription: last skill\n---\n");

  // skill with no frontmatter (name defaults to dir basename "alpha")
  const skillA = join(root, "alpha");
  mkdirSync(skillA);
  writeFileSync(join(skillA, "SKILL.md"), "# No frontmatter");

  // dir without SKILL.md
  const notASkill = join(root, "empty-dir");
  mkdirSync(notASkill);

  // plain file
  writeFileSync(join(root, "regular-file.txt"), "hello");

  // dot-entry
  const dotDir = join(root, ".hidden");
  mkdirSync(dotDir);
  writeFileSync(join(dotDir, "SKILL.md"), "---\nname: hidden\n---\n");

  const skills = listPiSkills(root);
  expect(skills.map((s) => s.name)).toEqual(["alpha", "zebra"]);
  expect(skills[0]).toEqual({
    name: "alpha",
    description: "",
    path: skillA,
  });
  expect(skills[1]).toEqual({
    name: "zebra",
    description: "last skill",
    path: skillZ,
  });

  // nonexistent root returns []
  expect(listPiSkills(join(root, "does-not-exist"))).toEqual([]);
});

test("listPiSkills catalogs symlinked skill dirs and skips broken symlinks", () => {
  const root = makeTemp("kanban-skills-root-");
  const outside = makeTemp("kanban-skills-outside-");

  // real skill dir created outside the root
  const realSkill = join(outside, "real-skill");
  mkdirSync(realSkill);
  writeFileSync(join(realSkill, "SKILL.md"), "---\nname: linked-skill\ndescription: real skill content\n---\n");

  // symlink to real skill inside root
  symlinkSync(realSkill, join(root, "linked"), "dir");

  // symlink to nonexistent target inside root
  symlinkSync(join(outside, "ghost"), join(root, "broken-link"), "dir");

  // plain file entry in root
  writeFileSync(join(root, "not-a-dir.txt"), "text");

  const skills = listPiSkills(root);
  expect(skills).toHaveLength(1);
  expect(skills[0].name).toBe("linked-skill");
  expect(skills[0].description).toBe("real skill content");
  expect(skills[0].path).toBe(join(root, "linked"));
});

test("listPiSkills returns ~-relative paths under $HOME and absolute elsewhere", () => {
  // temp under homedir()
  const homeTemp = makeTemp("kanban-home-skill-", homedir());
  const skillHome = join(homeTemp, "my-skill");
  mkdirSync(skillHome);
  writeFileSync(join(skillHome, "SKILL.md"), "---\nname: home-skill\n---\n");

  const homeSkills = listPiSkills(homeTemp);
  expect(homeSkills).toHaveLength(1);
  expect(homeSkills[0].path.startsWith("~/")).toBe(true);
  expect(homeSkills[0].path).not.toContain(homedir());

  // temp under tmpdir()
  const tmpTemp = makeTemp("kanban-tmp-skill-", tmpdir());
  const skillTmp = join(tmpTemp, "other-skill");
  mkdirSync(skillTmp);
  writeFileSync(join(skillTmp, "SKILL.md"), "---\nname: tmp-skill\n---\n");

  const tmpSkills = listPiSkills(tmpTemp);
  expect(tmpSkills).toHaveLength(1);
  // tmpdir is not under homedir on macOS (/var/folders/... or /tmp)
  if (!tmpTemp.startsWith(homedir())) {
    expect(tmpSkills[0].path.startsWith("/")).toBe(true);
    expect(tmpSkills[0].path.startsWith("~/")).toBe(false);
  }
});
