import { KanbanError } from "./db";

/** What the sidebar's branch row needs about the repo the board serves. */
export interface GitInfo {
  repo: true;
  /** Current branch name, or the literal "HEAD" when detached (render @ + head). */
  branch: string;
  /** Short sha of HEAD, so a detached row can show something stable. */
  head: string;
  /** Local branch names, git's order. */
  branches: string[];
  /** Number of linked worktrees (the main checkout counts). */
  worktrees: number;
  /** Count of dirty entries from `git status --porcelain`. */
  dirty: number;
}

/** Run git in cwd and return trimmed stdout; git's stderr becomes the error message. */
async function git(cwd: string, args: string[], code: "invalid" | "conflict" = "invalid"): Promise<string> {
  const proc = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) {
    throw new KanbanError(err.trim() || `git ${args[0]} failed`, code);
  }
  return out.trim();
}

/** Repo state for the branch row; not-a-repo (or no git binary) is a normal "hide it" state. */
export async function gitInfo(cwd: string): Promise<GitInfo | { repo: false }> {
  const inside = Bun.spawnSync({ cmd: ["git", "rev-parse", "--is-inside-work-tree"], cwd, stdout: "pipe", stderr: "pipe" });
  if (inside.exitCode !== 0) return { repo: false };
  const [branch, head, branchOut, worktreeOut, statusOut] = await Promise.all([
    git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(cwd, ["rev-parse", "--short", "HEAD"]),
    git(cwd, ["branch", "--format=%(refname:short)"]),
    git(cwd, ["worktree", "list", "--porcelain"]),
    git(cwd, ["status", "--porcelain"]),
  ]);
  return {
    repo: true,
    branch,
    head,
    branches: branchOut ? branchOut.split("\n") : [],
    worktrees: worktreeOut.split("\n").filter((l) => l.startsWith("worktree ")).length,
    dirty: statusOut ? statusOut.split("\n").length : 0,
  };
}

/** `git checkout` a known local branch; returns the branch now on. */
export async function gitCheckout(cwd: string, branch: string): Promise<string> {
  const info = await gitInfo(cwd);
  if (!info.repo) throw new KanbanError(`not a git repo: ${cwd}`, "invalid");
  if (!info.branches.includes(branch)) {
    throw new KanbanError(`no local branch '${branch}'`, "invalid");
  }
  if (branch === info.branch) return branch;
  await git(cwd, ["checkout", branch], "conflict");
  return branch;
}
