import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitCheckout, gitInfo, gitStatusMap } from "../src/git";
import { KanbanError } from "../src/db";

let dir = "";

function run(...cmd: string[]) {
  return Bun.spawnSync({ cmd, cwd: dir, stdout: "ignore", stderr: "ignore" });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-git-"));
  run("git", "init", "-b", "main");
  run("git", "config", "user.email", "test@local");
  run("git", "config", "user.name", "test");
  writeFileSync(join(dir, "a.txt"), "main\n");
  run("git", "add", ".");
  run("git", "commit", "-m", "init");
  run("git", "branch", "feature");
  // diverge the branches: a.txt differs, so a dirty checkout between them is a real conflict
  run("git", "checkout", "feature");
  writeFileSync(join(dir, "a.txt"), "feature\n");
  run("git", "add", ".");
  run("git", "commit", "-m", "diverge");
  run("git", "checkout", "main");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("gitInfo reports branch list, one worktree, clean tree", async () => {
  const info = await gitInfo(dir);
  expect(info).toMatchObject({ repo: true, branch: "main", branches: ["feature", "main"], worktrees: 1, dirty: 0 });
});

test("gitInfo counts dirty entries", async () => {
  writeFileSync(join(dir, "b.txt"), "dirty\n");
  const info = await gitInfo(dir);
  expect(info).toMatchObject({ repo: true, dirty: 1 });
  rmSync(join(dir, "b.txt"));
});

test("gitInfo on a non-repo directory reports repo false", async () => {
  const plain = mkdtempSync(join(tmpdir(), "kanban-nogit-"));
  try {
    expect(await gitInfo(plain)).toEqual({ repo: false });
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test("gitCheckout switches branches; same-branch is a no-op", async () => {
  expect(await gitCheckout(dir, "feature")).toBe("feature");
  expect(await gitInfo(dir)).toMatchObject({ repo: true, branch: "feature" });
  expect(await gitCheckout(dir, "feature")).toBe("feature");
  await gitCheckout(dir, "main");
});

test("gitCheckout refuses refs that are not local branches", async () => {
  const e = gitCheckout(dir, "no-such-branch");
  await expect(e).rejects.toBeInstanceOf(KanbanError);
  await expect(e).rejects.toThrow("no local branch 'no-such-branch'");
});

test("gitCheckout surfaces git's own refusal when a dirty tree conflicts", async () => {
  writeFileSync(join(dir, "a.txt"), "uncommitted\n");
  try {
    const e = gitCheckout(dir, "feature");
    await expect(e).rejects.toBeInstanceOf(KanbanError);
    await expect(e).rejects.toThrow(/local changes/i);
  } finally {
    run("git", "checkout", "--", "a.txt");
  }
  expect(await gitInfo(dir)).toMatchObject({ repo: true, branch: "main", dirty: 0 });
});

test("gitStatusMap on a non-repo directory reports {}", async () => {
  const plain = mkdtempSync(join(tmpdir(), "kanban-nogit-status-"));
  try {
    expect(await gitStatusMap(plain)).toEqual({});
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test("gitStatusMap classifies M/A/D/R/U in a temp repo; renames keyed by new path", async () => {
  const testRepo = mkdtempSync(join(tmpdir(), "kanban-git-status-"));
  const sub = join(testRepo, "sub");
  const exec = (...cmd: string[]) => Bun.spawnSync({ cmd, cwd: testRepo, stdout: "ignore", stderr: "ignore" });

  try {
    exec("git", "init", "-b", "main");
    exec("git", "config", "user.email", "test@local");
    exec("git", "config", "user.name", "test");

    // Base files
    writeFileSync(join(testRepo, "f_mod.txt"), "mod v1\n");
    writeFileSync(join(testRepo, "f_del.txt"), "del v1\n");
    writeFileSync(join(testRepo, "f_ren_old.txt"), "ren v1\n");
    mkdirSync(sub);
    writeFileSync(join(sub, "sub_mod.txt"), "sub v1\n");

    exec("git", "add", ".");
    exec("git", "commit", "-m", "init");

    // M: modify
    writeFileSync(join(testRepo, "f_mod.txt"), "mod v2\n");
    writeFileSync(join(sub, "sub_mod.txt"), "sub v2\n");

    // D: delete
    exec("git", "rm", "f_del.txt");

    // R: rename
    exec("git", "mv", "f_ren_old.txt", "f_ren_new.txt");

    // A: stage add
    writeFileSync(join(testRepo, "f_add.txt"), "add\n");
    exec("git", "add", "f_add.txt");

    // U: untracked
    writeFileSync(join(testRepo, "f_untracked.txt"), "untracked\n");

    const rootMap = await gitStatusMap(testRepo);
    expect(rootMap).toEqual({
      "f_mod.txt": "M",
      "sub/sub_mod.txt": "M",
      "f_del.txt": "D",
      "f_ren_new.txt": "R",
      "f_add.txt": "A",
      "f_untracked.txt": "U",
    });

    // Subdirectory call drops entries outside cwd and rebases
    const subMap = await gitStatusMap(sub);
    expect(subMap).toEqual({
      "sub_mod.txt": "M",
    });
  } finally {
    rmSync(testRepo, { recursive: true, force: true });
  }
});
