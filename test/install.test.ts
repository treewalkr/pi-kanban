import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

interface InstallResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runInstall(repo: string, home: string): InstallResult {
  const proc = Bun.spawnSync(["bash", join(repo, "scripts", "install.sh")], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, HOME: home },
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** Minimal clone-shaped repo: real scripts/ (install.sh + hooks), stub cli + skill files. */
function makeRepoSandbox(): { container: string; repo: string; home: string } {
  const container = realpathSync(mkdtempSync(join(tmpdir(), "kanban-install-test-")));
  const repo = join(container, "repo");
  const home = join(container, "home");
  mkdirSync(repo);
  mkdirSync(home);

  const git = (args: string[]) => {
    const proc = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  };
  git(["init", "-b", "main"]);
  git(["config", "user.name", "test"]);
  git(["config", "user.email", "test@test.com"]);

  const cp = Bun.spawnSync(["cp", "-R", join(repoRoot, "scripts"), join(repo, "scripts")]);
  if (cp.exitCode !== 0) throw new Error(cp.stderr.toString());
  mkdirSync(join(repo, "skills", "pi-kanban"), { recursive: true });
  writeFileSync(join(repo, "skills", "pi-kanban", "SKILL.md"), "# skill\n");
  writeFileSync(join(repo, "skills", "pi-kanban", "plan-template.md"), "# plan template\n");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "cli.ts"), "#!/usr/bin/env bun\n");
  writeFileSync(join(repo, "src", "notice.ts"), "// notice extension stub\n");
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  git(["add", "."]);
  git(["commit", "--no-verify", "-m", "initial commit"]);

  return { container, repo, home };
}

describe("scripts/install.sh (gate wiring)", () => {
  let container = "";
  let repo = "";
  let home = "";

  beforeEach(() => {
    ({ container, repo, home } = makeRepoSandbox());
  });

  afterEach(() => {
    rmSync(container, { recursive: true, force: true });
  });

  test("install.sh wires the gate and stays idempotent", () => {
    const first = runInstall(repo, home);

    expect(first.code).toBe(0);
    expect(first.stdout).toContain("installed:");
    // Existing behavior unbroken: cli symlink + skill files.
    const binLink = join(home, ".bun", "bin", "kanban");
    accessSync(binLink, constants.F_OK);
    const skillDir = join(home, ".pi", "agent", "skills", "pi-kanban");
    accessSync(join(skillDir, "SKILL.md"), constants.F_OK);
    accessSync(join(skillDir, "plan-template.md"), constants.F_OK);

    // Gate wiring: hooksPath set, hook files executable, reported in the list.
    const gitConfig = (args: string[]) =>
      Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
    expect(gitConfig(["config", "core.hooksPath"])).toBe("scripts/hooks");
    for (const hook of ["pre-commit", "pre-merge-commit", "gate.sh"]) {
      accessSync(join(repo, "scripts", "hooks", hook), constants.X_OK);
    }
    expect(first.stdout).toContain("core.hooksPath scripts/hooks");

    // Notice extension symlinked into the pi extensions dir.
    const noticeLink = join(home, ".pi", "agent", "extensions", "kanban-notice.ts");
    accessSync(noticeLink, constants.F_OK);
    const target = readlinkSync(noticeLink);
    expect(target).toBe(join(repo, "src", "notice.ts"));
    expect(first.stdout).toContain("notice");

    // Idempotent: second run exits 0 with the same wiring.
    const second = runInstall(repo, home);
    expect(second.code).toBe(0);
    expect(gitConfig(["config", "core.hooksPath"])).toBe("scripts/hooks");
    accessSync(binLink, constants.F_OK);
  });

  test("README documents the hook wiring", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf-8");
    expect(readme).toContain("git config core.hooksPath scripts/hooks");
  });

  test("AGENTS.md documents the gate and bypass", () => {
    const agentsMd = readFileSync(join(repoRoot, "AGENTS.md"), "utf-8");
    expect(agentsMd).toContain("## Commits");

    const section = agentsMd.split("## Commits")[1].split("## ")[0];
    expect(section).toContain("scripts/hooks/");
    expect(section).toContain("--no-verify");
  });
});
