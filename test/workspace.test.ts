import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = join(import.meta.dir, "..", "scripts", "workspace.sh");

interface WorkspaceResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  if (!proc.success) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim();
}

async function runWorkspace(cwd: string, args: string[]): Promise<WorkspaceResult> {
  const proc = Bun.spawn(["bash", scriptPath, ...args], {
    cwd,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    signal: AbortSignal.timeout(30_000),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("scripts/workspace.sh", () => {
  let container = "";
  let repo = "";

  beforeEach(() => {
    container = realpathSync(mkdtempSync(join(tmpdir(), "kanban-wt-test-")));
    repo = join(container, "repo");
    mkdirSync(repo);

    runGit(repo, ["init", "-b", "main"]);
    runGit(repo, ["config", "user.name", "test"]);
    runGit(repo, ["config", "user.email", "test@test.com"]);
    writeFileSync(join(repo, "README.md"), "# fixture\n");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "initial commit"]);
  });

  afterEach(() => {
    rmSync(container, { recursive: true, force: true });
  });

  test("new creates a sibling worktree on a new branch from main HEAD", async () => {
    const res = await runWorkspace(repo, ["new", "acme"]);
    expect(res.code).toBe(0);

    const wt = join(container, "repo-acme");
    expect(res.stdout).toContain(`workspace: created ${wt} on branch acme`);
    expect(existsSync(wt)).toBe(true);

    const mainHead = runGit(repo, ["rev-parse", "HEAD"]);
    const wtHead = runGit(wt, ["rev-parse", "HEAD"]);
    expect(wtHead).toBe(mainHead);

    const wtBranch = runGit(wt, ["branch", "--show-current"]);
    expect(wtBranch).toBe("acme");
  });

  test("new rejects bad slugs, existing paths, and existing branches", async () => {
    // Bad slugs
    const badSlugs = ["BAD", "foo_bar", "-lead", "slug with spaces", "a".repeat(41), ""];
    for (const slug of badSlugs) {
      const res = await runWorkspace(repo, ["new", slug]);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain(
        `workspace: slug must be 1-40 chars of lowercase alphanumerics and dashes — got '${slug}'`,
      );
    }

    // Existing path
    const wtPath = join(container, "repo-acme");
    mkdirSync(wtPath);
    const pathRes = await runWorkspace(repo, ["new", "acme"]);
    expect(pathRes.code).toBe(1);
    expect(pathRes.stderr).toContain(`workspace: ${wtPath} already exists — pick another slug`);
    rmSync(wtPath, { recursive: true, force: true });

    // Existing branch
    runGit(repo, ["branch", "acme"]);
    const branchRes = await runWorkspace(repo, ["new", "acme"]);
    expect(branchRes.code).toBe(1);
    expect(branchRes.stderr).toContain("workspace: branch acme already exists — pick another slug");
  });

  test("done merges, removes the worktree, deletes the branch, leaves main clean", async () => {
    const createRes = await runWorkspace(repo, ["new", "acme"]);
    expect(createRes.code).toBe(0);
    const wt = join(container, "repo-acme");

    writeFileSync(join(wt, "feature.txt"), "feature content\n");
    runGit(wt, ["add", "."]);
    runGit(wt, ["commit", "-m", "feat: acme feature"]);

    const doneRes = await runWorkspace(repo, ["done", "acme"]);
    expect(doneRes.code).toBe(0);
    expect(doneRes.stdout.trim().endsWith("— main tree clean")).toBe(true);
    expect(doneRes.stdout).toContain("workspace: acme merged and removed — main tree clean");

    expect(existsSync(wt)).toBe(false);

    const worktrees = runGit(repo, ["worktree", "list", "--porcelain"]);
    const wtCount = (worktrees.match(/^worktree /gm) || []).length;
    expect(wtCount).toBe(1);

    const branches = runGit(repo, ["branch", "--list", "acme"]);
    expect(branches).toBe("");

    const lastSubject = runGit(repo, ["log", "-1", "--format=%s"]);
    expect(lastSubject).toBe("merge: acme");

    expect(existsSync(join(repo, "feature.txt"))).toBe(true);

    const status = runGit(repo, ["status", "--porcelain"]);
    expect(status).toBe("");
  });

  test("done refuses a dirty workspace or dirty main", async () => {
    const createRes = await runWorkspace(repo, ["new", "acme"]);
    expect(createRes.code).toBe(0);
    const wt = join(container, "repo-acme");

    // Dirty workspace
    writeFileSync(join(wt, "uncommitted.txt"), "dirty workspace\n");
    const dirtyWtRes = await runWorkspace(repo, ["done", "acme"]);
    expect(dirtyWtRes.code).toBe(1);
    expect(dirtyWtRes.stderr).toContain(
      `workspace: ${wt} has uncommitted changes — commit or stash inside it first`,
    );
    expect(existsSync(wt)).toBe(true);
    expect(runGit(repo, ["branch", "--list", "acme"])).not.toBe("");
    rmSync(join(wt, "uncommitted.txt"));

    // Dirty main
    writeFileSync(join(repo, "uncommitted.txt"), "dirty main\n");
    const dirtyMainRes = await runWorkspace(repo, ["done", "acme"]);
    expect(dirtyMainRes.code).toBe(1);
    expect(dirtyMainRes.stderr).toContain(
      `workspace: main tree is dirty — commit or stash in ${repo} before merging`,
    );
    expect(existsSync(wt)).toBe(true);
    expect(runGit(repo, ["branch", "--list", "acme"])).not.toBe("");
    rmSync(join(repo, "uncommitted.txt"));
  });

  test("done names a missing workspace and unknown subcommands fail", async () => {
    const missingWt = join(container, "repo-nonexistent");
    const missingRes = await runWorkspace(repo, ["done", "nonexistent"]);
    expect(missingRes.code).toBe(1);
    expect(missingRes.stderr).toContain(`workspace: no workspace at ${missingWt} — try git worktree list`);

    const unknownRes = await runWorkspace(repo, ["bogus", "acme"]);
    expect(unknownRes.code).toBe(1);
    expect(unknownRes.stderr).toContain("workspace: usage: scripts/workspace.sh <new|done> <slug>");

    const tooFewArgsRes = await runWorkspace(repo, ["new"]);
    expect(tooFewArgsRes.code).toBe(1);
    expect(tooFewArgsRes.stderr).toContain("workspace: usage: scripts/workspace.sh <new|done> <slug>");
  });
});
