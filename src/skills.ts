import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** pi's skill catalog, surfaced for the agents panel's skill picker. */
export interface CatalogSkill {
  name: string; // frontmatter name:, else the skill dir's basename
  description: string; // frontmatter description: (folded/multiline collapsed), "" when absent, capped at 200 chars
  path: string; // spawn-ready: "~/…"-form when under $HOME, else absolute
}

/** Reads name/description from a SKILL.md's YAML frontmatter ("" when absent). */
export function parseSkillFrontmatter(content: string): { name: string; description: string } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "";
  const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? "";
  let description = /^description:\s*(.*)$/m.exec(fm)?.[1]?.trim() ?? "";
  if ([">", ">-", "|", "|-"].includes(description)) {
    const lines: string[] = [];
    for (const line of fm.slice(fm.indexOf("description:")).split("\n").slice(1)) {
      if (line.trim() !== "" && !/^\s/.test(line)) break;
      if (line.trim() !== "") lines.push(line.trim());
    }
    description = lines.join(" ");
  }
  return { name, description: description.replace(/\s+/g, " ").trim().slice(0, 200) };
}

function displayPath(skillDir: string): string {
  const home = homedir();
  return (skillDir === home || skillDir.startsWith(home + "/")) ? "~" + skillDir.slice(home.length) : skillDir;
}

/** Scans pi's skill root (default ~/.pi/agent/skills): entries holding a SKILL.md —
 *  real dirs AND symlinks (the read itself rejects plain files / broken links) —
 *  dot-entries skipped, sorted by name; missing root → []. */
export function listPiSkills(root: string = join(homedir(), ".pi", "agent", "skills")): CatalogSkill[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: CatalogSkill[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue; // dotfiles / .DS_Store
    const dir = join(root, name);
    let content: string;
    try {
      // the read is the filter: plain files → ENOTDIR, no SKILL.md or broken
      // symlink → ENOENT, symlinked dirs → resolved and read (matches the
      // 25/26 symlinked skills in ~/.pi/agent/skills)
      content = readFileSync(join(dir, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const { name: skillName, description } = parseSkillFrontmatter(content);
    out.push({ name: skillName || name, description, path: displayPath(dir) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
