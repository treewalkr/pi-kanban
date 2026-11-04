import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Skill activation: a configured skill's SKILL.md body is injected into the
 * harness system prompt so the skill is active from the first token instead of
 * waiting for the model to open the file. Harness-agnostic — pi and Claude Code
 * both receive the same <skill> block as appended system-prompt text.
 */

/** Max characters of a SKILL.md body injected into the system prompt (argv safety). */
export const MAX_SKILL_CHARS = 64 * 1024;

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

/**
 * Reads every configured skill path (directory → its SKILL.md, or the file
 * itself; `~` expanded), strips YAML frontmatter, and wraps the body in pi's
 * own <skill> block shape — the format `/skill:name` expands to, mirroring
 * pi's _expandSkillCommand. Unreadable paths warn via onWarn and are skipped;
 * a spawn never dies on a skill.
 */
export function skillActivationPrompt(skills: string[], onWarn?: (message: string) => void): string {
  const blocks: string[] = [];
  for (const raw of skills) {
    const base = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
    let filePath = base;
    try {
      if (statSync(base).isDirectory()) filePath = join(base, "SKILL.md");
    } catch {
      onWarn?.(`skill ${raw} not found — skipped`);
      continue;
    }
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (err) {
      onWarn?.(`skill ${raw} unreadable (${(err as Error).message}) — skipped`);
      continue;
    }
    const stripped = stripFrontmatter(content).trim();
    const body = stripped.slice(0, MAX_SKILL_CHARS);
    if (body.length < stripped.length) onWarn?.(`skill ${raw} truncated at ${MAX_SKILL_CHARS} chars`);
    const name = /^name:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? basename(dirname(filePath));
    blocks.push(`<skill name="${name}" location="${filePath}">\nReferences are relative to ${dirname(filePath)}.\n\n${body}\n</skill>`);
  }
  return blocks.join("\n\n");
}
