import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoHooks = join(import.meta.dir, "..", "scripts", "hooks");

/** Temp dirs created by makeSandbox; afterEach removes them all. */
const containers: string[] = [];

interface CmdResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(cwd: string, args: string[]): CmdResult {
  const proc = Bun.spawnSync(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: process.env,
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function runGit(cwd: string, args: string[]): CmdResult {
  return run(cwd, ["git", ...args]);
}

/** git forwards hook output to its own streams; assert against the combined text. */
function text(res: CmdResult): string {
  return res.stdout + res.stderr;
}

interface Sandbox {
  container: string;
  repo: string;
  gateLog: string;
}

interface SandboxOpts {
  checkFails?: boolean;
  testFails?: boolean;
  /** false: leave the repo with no commits (for the initial-commit test). */
  initialCommit?: boolean;
  /** Override the stub check script (defaults to appending "check" to gate.log). */
  checkCmd?: string;
}

/**
 * Temp repo with the real scripts/hooks wired via core.hooksPath and stub
 * package.json scripts that append to gate.log (echo + optional exit 1).
 * Follows the run-the-real-script pattern from test/workspace.test.ts.
 */
function makeSandbox(opts: SandboxOpts = {}): Sandbox {
  const { checkFails = false, testFails = false, initialCommit = true, checkCmd } = opts;
  const container = realpathSync(mkdtempSync(join(tmpdir(), "kanban-gate-test-")));
  containers.push(container);
  const repo = join(container, "repo");
  const gateLog = join(repo, "gate.log");
  mkdirSync(repo);

  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.name", "test"]);
  runGit(repo, ["config", "user.email", "test@test.com"]);

  cpSync(repoHooks, join(repo, "scripts", "hooks"), { recursive: true });
  for (const hook of ["pre-commit", "pre-merge-commit", "gate.sh"]) {
    chmodSync(join(repo, "scripts", "hooks", hook), 0o755);
  }
  runGit(repo, ["config", "core.hooksPath", "scripts/hooks"]);

  const resolvedCheckCmd =
    checkCmd ?? (checkFails ? "echo check >> gate.log && exit 1" : "echo check >> gate.log");
  const testCmd = "echo test >> gate.log";
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify(
      { name: "sandbox", private: true, type: "module", scripts: { check: resolvedCheckCmd, test: testCmd } },
      null,
      2,
    ) + "\n",
  );

  const smokeAppend = `import { appendFileSync } from "node:fs";
import { test } from "bun:test";
appendFileSync("gate.log", "test\\n");
`;
  // gate.sh runs `bun test --parallel` (the built-in runner), never `bun run test` —
  // so the stub test file itself appends "test" to gate.log when it runs.
  const smokeBody =
    smokeAppend +
    (testFails
      ? `test("smoke", () => { throw new Error("boom"); });
`
      : `test("smoke", () => {});
`);
  mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "test", "smoke.test.ts"), smokeBody);

  if (initialCommit) {
    writeFileSync(join(repo, "README.md"), "# fixture\n");
    runGit(repo, ["add", "."]);
    // Hooks are wired but the fixture commit must not gate: bypass on purpose.
    runGit(repo, ["commit", "--no-verify", "-m", "initial commit"]);
  }

  return { container, repo, gateLog };
}

describe("scripts/hooks (git gate)", () => {
  let sandbox: Sandbox;

  afterEach(() => {
    for (const container of containers.splice(0)) {
      rmSync(container, { recursive: true, force: true });
    }
  });

  function head(repo: string): string {
    const res = runGit(repo, ["rev-parse", "HEAD"]);
    if (res.code !== 0) throw new Error(`rev-parse HEAD failed: ${res.stderr}`);
    return res.stdout.trim();
  }

  function gateLogLines(s: Sandbox): string[] {
    return readFileSync(s.gateLog, "utf-8").trim().split("\n");
  }

  /** rev-list --parents output includes HEAD itself; parents = tokens - 1. */
  function parentCount(repo: string): number {
    const out = runGit(repo, ["rev-list", "--parents", "-n", "1", "HEAD"]).stdout.trim().split(" ");
    return out.length - 1;
  }

  test("hook files are executable", () => {
    for (const hook of ["pre-commit", "pre-merge-commit", "gate.sh"]) {
      // Git silently skips a non-executable hook — the exec bit is the contract.
      accessSync(join(repoHooks, hook), constants.X_OK);
    }
  });

  test("code commit with failing check is blocked", () => {
    sandbox = makeSandbox({ checkFails: true });
    const before = head(sandbox.repo);
    writeFileSync(join(sandbox.repo, "src-a.ts"), "export const a = 1;\n");
    runGit(sandbox.repo, ["add", "src-a.ts"]);

    const res = runGit(sandbox.repo, ["commit", "-m", "red code"]);

    expect(res.code).not.toBe(0);
    expect(text(res)).toContain("pre-commit: blocked — fix above, or bypass with: git commit --no-verify");
    expect(head(sandbox.repo)).toBe(before); // no commit landed
    expect(gateLogLines(sandbox)).toEqual(["check"]); // fail-fast: check ran, test never started
  });

  test("code commit with failing bun test is blocked", () => {
    sandbox = makeSandbox({ testFails: true });
    const before = head(sandbox.repo);
    writeFileSync(join(sandbox.repo, "src-a.ts"), "export const a = 1;\n");
    runGit(sandbox.repo, ["add", "src-a.ts"]);

    const res = runGit(sandbox.repo, ["commit", "-m", "red test"]);

    expect(res.code).not.toBe(0);
    expect(text(res)).toContain("pre-commit: blocked — fix above, or bypass with: git commit --no-verify");
    expect(head(sandbox.repo)).toBe(before);
    expect(gateLogLines(sandbox)).toEqual(["check", "test"]); // both ran
  });

  test("green code commit passes through the gate", () => {
    sandbox = makeSandbox();
    const before = head(sandbox.repo);
    writeFileSync(join(sandbox.repo, "src-a.ts"), "export const a = 1;\n");
    runGit(sandbox.repo, ["add", "src-a.ts"]);

    const res = runGit(sandbox.repo, ["commit", "-m", "green code"]);

    expect(res.code).toBe(0);
    expect(head(sandbox.repo)).not.toBe(before); // HEAD advanced
    expect(gateLogLines(sandbox)).toEqual(["check", "test"]);
  });

  test("initial commit runs the full gate", () => {
    sandbox = makeSandbox({ initialCommit: false });

    // No HEAD exists yet; a code commit must still gate (fail closed).
    writeFileSync(join(sandbox.repo, "src-a.ts"), "export const a = 1;\n");
    runGit(sandbox.repo, ["add", "."]);
    const res = runGit(sandbox.repo, ["commit", "-m", "initial code commit"]);

    expect(res.code).toBe(0);
    expect(gateLogLines(sandbox)).toEqual(["check", "test"]);
  });

  test("red merge is blocked and left conclude-able", () => {
    sandbox = makeSandbox({ testFails: true });
    const repo = sandbox.repo;

    // The WIP valve: a red code commit sneaks past pre-commit via --no-verify.
    runGit(repo, ["checkout", "-b", "feature"]);
    writeFileSync(join(repo, "src-a.ts"), "export const a = 1;\n");
    runGit(repo, ["add", "src-a.ts"]);
    expect(runGit(repo, ["commit", "--no-verify", "-m", "wip red"]).code).toBe(0);

    runGit(repo, ["checkout", "main"]);
    rmSync(sandbox.gateLog, { force: true });

    const res = runGit(repo, ["merge", "--no-ff", "feature", "-m", "merge feature"]);

    expect(res.code).not.toBe(0);
    expect(text(res)).toContain(
      "pre-merge-commit: blocked — fix above, then git commit to conclude (bypass: git commit --no-verify)",
    );
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(true); // conclude-able
    expect(parentCount(repo)).toBeLessThan(2); // no merge commit yet
    expect(gateLogLines(sandbox)).toContain("check");

    // Conclude with --no-verify: the merge commit lands with two parents.
    const conclude = runGit(repo, ["commit", "--no-verify", "-m", "merge feature"]);
    expect(conclude.code).toBe(0);
    expect(parentCount(repo)).toBe(2);
  });

  test("green merge passes the gate", () => {
    sandbox = makeSandbox();
    const repo = sandbox.repo;

    runGit(repo, ["checkout", "-b", "feature"]);
    writeFileSync(join(repo, "src-a.ts"), "export const a = 1;\n");
    runGit(repo, ["add", "src-a.ts"]);
    expect(runGit(repo, ["commit", "--no-verify", "-m", "feature"]).code).toBe(0);

    runGit(repo, ["checkout", "main"]);
    rmSync(sandbox.gateLog, { force: true });

    const res = runGit(repo, ["merge", "--no-ff", "feature", "-m", "merge feature"]);

    expect(res.code).toBe(0);
    expect(parentCount(repo)).toBe(2);
    expect(gateLogLines(sandbox)).toEqual(["check", "test"]);
  });

  test("docs-only branch merge is still gated", () => {
    sandbox = makeSandbox();
    const repo = sandbox.repo;

    // The docs-only branch commit takes the pre-commit skip path.
    runGit(repo, ["checkout", "-b", "docs-branch"]);
    writeFileSync(join(repo, "README.md"), "# fixture — updated\n");
    runGit(repo, ["add", "README.md"]);
    const docsCommit = runGit(repo, ["commit", "-m", "docs change"]);
    expect(docsCommit.code).toBe(0);
    expect(text(docsCommit)).toContain("pre-commit: docs-only change, skipping check + test");
    expect(existsSync(sandbox.gateLog)).toBe(false);

    runGit(repo, ["checkout", "main"]);

    // But the merge itself always runs the full gate (decision 2).
    const res = runGit(repo, ["merge", "--no-ff", "docs-branch", "-m", "merge docs"]);

    expect(res.code).toBe(0);
    expect(gateLogLines(sandbox)).toEqual(["check", "test"]);
  });

  test("gate strips git env vars before running the suite", () => {
    // git invokes hooks with GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE set to the
    // hooking repo; leaked into `bun test`, sandboxed git calls in suites hit
    // the wrong repo. The gate must unset them (real bug caught by dogfood).
    sandbox = makeSandbox({
      checkCmd: 'echo "GIT_DIR=${GIT_DIR-unset} GIT_INDEX_FILE=${GIT_INDEX_FILE-unset} GIT_WORK_TREE=${GIT_WORK_TREE-unset}" >> gate.log',
    });
    writeFileSync(join(sandbox.repo, "src-a.ts"), "export const a = 1;\n");
    runGit(sandbox.repo, ["add", "src-a.ts"]);

    const res = runGit(sandbox.repo, ["commit", "-m", "env probe"]);

    expect(res.code).toBe(0);
    expect(gateLogLines(sandbox)[0]).toBe("GIT_DIR=unset GIT_INDEX_FILE=unset GIT_WORK_TREE=unset");
  });

  test("docs-only commit skips the gate", () => {
    sandbox = makeSandbox();
    writeFileSync(join(sandbox.repo, "README.md"), "# fixture — updated\n");
    runGit(sandbox.repo, ["add", "README.md"]);

    const res = runGit(sandbox.repo, ["commit", "-m", "docs change"]);

    expect(res.code).toBe(0);
    expect(text(res)).toContain("pre-commit: docs-only change, skipping check + test");
    expect(existsSync(sandbox.gateLog)).toBe(false); // no check/test ran → sub-second commit
  });
});
