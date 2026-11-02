import { join } from "node:path";

/** Single source for the CLI banner, `kanban version`, and /health — bump with package.json. */
export const VERSION = "0.8.0";

// anchored to this file, not cwd: the bin symlink resolves to the real checkout,
// and tests run from temp DBs without losing git context
const repoRoot = join(import.meta.dir, "..");

function gitOut(args: string[]): string | null {
  try {
    const r = Bun.spawnSync(["git", "-C", repoRoot, ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) return null;
    const out = r.stdout.toString().trim();
    return out || null;
  } catch {
    return null; // no git binary — callers treat everything as unknown
  }
}

/** Commit the running code was started from. Memoized on first call — boot() warms it at listen so it means boot-time HEAD, not first-request HEAD. */
let boot: string | null | undefined;
export function bootCommit(): string | null {
  if (boot === undefined) boot = gitOut(["rev-parse", "HEAD"]);
  return boot;
}

export interface HeadState {
  head: string | null;
  dirty: boolean;
}

// TTL cache: /health is polled every 30s per open tab — one git status per 10s is plenty
const HEAD_TTL_MS = 10_000;
let cached: { at: number; state: HeadState | null } | null = null;

/** Current HEAD + tracked-tree dirtiness. Untracked files are ignored — they never run. */
export function headState(): HeadState | null {
  if (cached && Date.now() - cached.at < HEAD_TTL_MS) return cached.state;
  const status = gitOut(["status", "--porcelain=v2", "--branch", "--untracked-files=no"]);
  const state = parseStatus(status);
  cached = { at: Date.now(), state };
  return state;
}

function parseStatus(status: string | null): HeadState | null {
  if (status === null) return null; // not a git checkout — nothing to compare
  const lines = status.split("\n");
  const oid = lines.find((l) => l.startsWith("# branch.oid "))?.slice("# branch.oid ".length).trim();
  const head = oid && /^[0-9a-f]{40}$/.test(oid) ? oid : null;
  return { head, dirty: lines.some((l) => l && !l.startsWith("#")) };
}

export interface ServeGit {
  commit: string | null;
  head: string | null;
  dirty: boolean;
}

/** What /health reports: boot commit vs live HEAD. Null when the checkout has no git — stale detection just turns off. */
export function serveGit(): ServeGit | null {
  const state = headState();
  if (state === null) return null;
  return { commit: bootCommit(), head: state.head, dirty: state.dirty };
}
