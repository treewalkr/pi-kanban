import { realpathSync } from "node:fs";
import * as path from "node:path";
import { KanbanError, type CardWorkspace } from "./db";

export type GitFileCode = "M" | "A" | "D" | "R" | "U";

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function classifyGitCode(xy: string): GitFileCode {
  if (xy === "??" || xy.trim() === "?") return "U";
  if (CONFLICT_CODES.has(xy)) return "U";
  if (xy.includes("D")) return "D";
  if (xy.includes("R")) return "R";
  if (xy.includes("A")) return "A";
  return "M";
}

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

/** List worktrees via `git worktree list --porcelain`; [] on non-repo or git failure. */
export async function listWorktrees(
  cwd: string,
): Promise<Array<{ path: string; branch: string | null }>> {
  try {
    const inside = Bun.spawnSync({ cmd: ["git", "rev-parse", "--is-inside-work-tree"], cwd, stdout: "pipe", stderr: "pipe" });
    if (inside.exitCode !== 0) return [];
    const out = await git(cwd, ["worktree", "list", "--porcelain"]);
    if (!out) return [];

    const entries: Array<{ path: string; branch: string | null }> = [];
    let currentPath: string | null = null;
    let currentBranch: string | null = null;

    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (currentPath) {
          entries.push({ path: currentPath, branch: currentBranch });
          currentPath = null;
          currentBranch = null;
        }
        continue;
      }
      if (trimmed.startsWith("worktree ")) {
        if (currentPath) {
          entries.push({ path: currentPath, branch: currentBranch });
          currentBranch = null;
        }
        currentPath = trimmed.slice("worktree ".length).trim();
      } else if (trimmed.startsWith("branch ")) {
        const ref = trimmed.slice("branch ".length).trim();
        currentBranch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      }
    }
    if (currentPath) {
      entries.push({ path: currentPath, branch: currentBranch });
    }
    return entries;
  } catch {
    return [];
  }
}

/** Resolve given branch names against live git worktrees and branches. Keyed by branch name. */
export async function resolveWorkspaces(
  cwd: string,
  branches: string[],
): Promise<Record<string, CardWorkspace>> {
  const uniqueBranches = Array.from(new Set(branches.filter(Boolean)));
  if (uniqueBranches.length === 0) return {};

  try {
    const inside = Bun.spawnSync({ cmd: ["git", "rev-parse", "--is-inside-work-tree"], cwd, stdout: "pipe", stderr: "pipe" });
    if (inside.exitCode !== 0) return {};

    const [worktrees, branchOut] = await Promise.all([
      listWorktrees(cwd),
      git(cwd, ["branch", "--format=%(refname:short)"]),
    ]);

    const localBranches = new Set(
      branchOut ? branchOut.split("\n").map((b) => b.trim()).filter(Boolean) : [],
    );

    const wtByBranch = new Map<string, string>();
    for (const wt of worktrees) {
      if (wt.branch) {
        wtByBranch.set(wt.branch, wt.path);
      }
    }

    const result: Record<string, CardWorkspace> = {};
    for (const b of uniqueBranches) {
      if (wtByBranch.has(b)) {
        result[b] = { branch: b, path: wtByBranch.get(b)! };
      } else if (localBranches.has(b)) {
        result[b] = { branch: b, path: null };
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** Per-file git status map (M/A/D/R/U) relative to cwd; non-repo or failure returns {}. */
export async function gitStatusMap(cwd: string): Promise<Record<string, GitFileCode>> {
  try {
    const inside = Bun.spawnSync({
      cmd: ["git", "rev-parse", "--is-inside-work-tree"],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (inside.exitCode !== 0) return {};

    const [topLevelRaw, statusRaw] = await Promise.all([
      git(cwd, ["rev-parse", "--show-toplevel"]),
      new Promise<string>((resolve, reject) => {
        const proc = Bun.spawn({
          cmd: ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        });
        Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
          .then(([out, err, code]) => {
            if (code !== 0) reject(new Error(err));
            else resolve(out);
          })
          .catch(reject);
      }),
    ]);

    const topLevel = realpathSync(path.resolve(topLevelRaw.trim()));
    const cwdResolved = realpathSync(path.resolve(cwd));

    const map: Record<string, GitFileCode> = {};
    const tokens = statusRaw.split("\0");

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token || token.length < 4) continue;
      const xy = token.slice(0, 2);
      const rawPath = token.slice(3);
      if (xy.includes("R") || xy.includes("C")) {
        i++;
      }
      const fullPath = path.resolve(topLevel, rawPath);
      const relToCwd = path.relative(cwdResolved, fullPath);
      if (
        !relToCwd ||
        relToCwd === ".." ||
        relToCwd.startsWith(".." + path.sep) ||
        relToCwd.startsWith("../") ||
        path.isAbsolute(relToCwd)
      ) {
        continue;
      }

      const normalizedRel = relToCwd.split(path.sep).join("/");
      map[normalizedRel] = classifyGitCode(xy);
    }

    return map;
  } catch {
    return {};
  }
}
