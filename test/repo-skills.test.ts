import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseSkillFrontmatter } from "../src/skills";

const root = join(import.meta.dir, "..");
const skillsDir = join(root, "skills");

/** The starter set from card csw7q: pi-kanban + five distilled procedures. */
const EXPECTED_SKILLS = ["e2e-verify", "overnight", "release", "repro", "resume-build", "pi-kanban"].sort();

/** Pinned trigger sentences (plan csw7q, Interfaces & contracts) — descriptions must lead with them. */
const TRIGGERS: Record<string, string> = {
  "e2e-verify":
    "Use when manually verifying kanban web UI changes in a real browser (agent-driven), reproducing a visual or interaction bug, or screenshotting UI state.",
  repro: "Use when reproducing board behavior or testing server changes on a throwaway kanban board.",
  overnight: "Use when the user asks for work to continue overnight or while they are away.",
  "resume-build":
    "Use when picking up a card whose builder session died mid-build (kanban ps shows an abandoned lease, or the thread says a session died).",
  release: "Use when cutting a release of pi-kanban (version bump, wiring checks, tag, GitHub release).",
  "pi-kanban": "Track and manage task state on the Kanban board",
};

const skillBody = (name: string) => readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");

test("every skills dir carries skills.sh-contract frontmatter", () => {
  const dirs = readdirSync(skillsDir).filter((d) => !d.startsWith(".")).sort();
  expect(dirs).toEqual(EXPECTED_SKILLS);

  // A root SKILL.md would shadow skills/ in skills.sh discovery.
  expect(existsSync(join(root, "SKILL.md"))).toBe(false);

  for (const dir of dirs) {
    const skill = skillBody(dir);
    const skillPath = join(skillsDir, dir, "SKILL.md");
    const { name, description } = parseSkillFrontmatter(skill);

    expect(name, dir).toBe(dir);
    expect(name, dir).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
    expect(name, dir).toBe(basename(dirname(skillPath)));

    // parseSkillFrontmatter collapses whitespace and caps at 200; the raw
    // frontmatter value is what the skills CLI sees, so bound it there.
    const rawDescription = /^description:\s*(.+)$/m.exec(skill)?.[1]?.trim() ?? "";
    expect(rawDescription.length, dir).toBeGreaterThanOrEqual(1);
    expect(rawDescription.length, dir).toBeLessThanOrEqual(1024);
    expect(description.length, dir).toBeGreaterThanOrEqual(1);
    expect(rawDescription.startsWith(TRIGGERS[dir]), `${dir} description leads with its pinned trigger`).toBe(true);

    // New-skill contract (plan csw7q): a procedure stays skimmable, not a manual.
    // pi-kanban predates the card and keeps its existing length.
    if (dir !== "pi-kanban") {
      expect(skill.split("\n").length, `${dir} body ≤ 120 lines`).toBeLessThanOrEqual(121);
    }
  }
});

test("each skill teaches its pinned procedure points", () => {
  // repro: isolation rules
  const repro = skillBody("repro");
  expect(repro).toContain("4611");
  expect(repro).toContain("PORT=4600");
  expect(repro).toContain("KANBAN_SHARE_PORT");
  expect(/before the session ends/i.test(repro)).toBe(true);

  // e2e-verify: temp-DB dev board + churn rules
  const e2e = skillBody("e2e-verify");
  expect(e2e).toContain("KANBAN_DB");
  expect(e2e).toContain("exact: true");
  expect(e2e).toContain("devicePixelRatio");
  expect(/rm <id> --force|rm .*--force/.test(e2e)).toBe(true);

  // overnight: watcher snippet + state file + gate handover
  const overnight = skillBody("overnight");
  expect(overnight).toContain("kill -0");
  expect(overnight).toContain("data/overnight.state");
  expect(/never run\s+`(kanban )?approve`\/`reject`/s.test(overnight)).toBe(true);

  // resume-build: never respawn + stash check + resume seam
  const resume = skillBody("resume-build");
  expect(resume).toContain("never respawn");
  expect(resume).toContain("git stash list");
  expect(resume).toContain("POST /tasks/:id/resume");

  // release: two-file bump + tag + GitHub release
  const release = skillBody("release");
  expect(release).toContain("src/version.ts");
  expect(release).toContain("package.json");
  expect(release).toContain("git tag");
  expect(release).toContain("gh release create");
});

test("AGENTS.md carries the split rule and Layout points at skills/", () => {
  const agents = readFileSync(join(root, "AGENTS.md"), "utf8");

  const section = agents.split("## Where knowledge lives")[1]?.split("## ")[0];
  expect(section, "## Where knowledge lives section present").toBeDefined();
  expect(section).toContain("`AGENTS.md`");
  expect(section).toContain("`skills/<name>/SKILL.md`");
  expect(section).toContain("`REVIEW.md`");
  expect(section).toMatch(/memory/i);

  const layout = agents.split("## Layout")[1].split("## ")[0];
  expect(layout).toContain("`skills/`");
  expect(layout).toContain("~/.agents/skills");
});

test("GLOSSARY.md defines Repo skill with avoid-terms", () => {
  const glossary = readFileSync(join(root, "GLOSSARY.md"), "utf8");
  const term = glossary.split("**Repo skill**:")[1]?.split(/\n\*\*/)[0] ?? "";
  expect(term, "**Repo skill** term present").toBeDefined();
  expect(term).toContain("skills/<name>/");
  expect(term).toContain("Avoid");
});
