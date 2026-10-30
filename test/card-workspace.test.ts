import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { KanbanDb, KanbanError, type BoardPayload } from "../src/db";
import { listWorktrees } from "../src/git";

function runGit(cwd: string, args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  if (!proc.success) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim();
}

describe("card workspace field contract", () => {
  let tmpDir = "";
  let db: KanbanDb;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kanban-db-ws-test-"));
    db = new KanbanDb(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("updateTask workspace set/clear/validate", () => {
    const task = db.createTask({ title: "Task 1" });
    expect(task.workspace).toBeNull();

    // set -> roundtrip trimmed
    const updated = db.updateTask(task.id, { workspace: "  feat/my-branch  " });
    expect(updated.workspace).toBe("feat/my-branch");

    // null clears
    const cleared = db.updateTask(task.id, { workspace: null });
    expect(cleared.workspace).toBeNull();

    // validation: empty or whitespace only
    expect(() => db.updateTask(task.id, { workspace: "   " })).toThrow(
      new KanbanError("workspace must be a non-empty branch name without whitespace", "invalid"),
    );

    // validation: contains internal whitespace
    expect(() => db.updateTask(task.id, { workspace: "a b" })).toThrow(
      new KanbanError("workspace must be a non-empty branch name without whitespace", "invalid"),
    );

    // validation: > 200 chars
    const tooLong = "a".repeat(201);
    expect(() => db.updateTask(task.id, { workspace: tooLong })).toThrow(
      new KanbanError("workspace must be a non-empty branch name without whitespace", "invalid"),
    );

    // 200 chars is allowed
    const maxLen = "a".repeat(200);
    const validMax = db.updateTask(task.id, { workspace: maxLen });
    expect(validMax.workspace).toBe(maxLen);
  });
});

describe("board workspaces integration (AC1-AC5)", () => {
  let containerDir = "";
  let repoDir = "";
  let wtDir = "";
  let db: KanbanDb;

  beforeEach(() => {
    containerDir = realpathSync(mkdtempSync(join(tmpdir(), "kanban-board-ws-test-")));
    repoDir = join(containerDir, "repo");
    wtDir = join(containerDir, "repo-acme");
    mkdirSync(repoDir);

    runGit(repoDir, ["init", "-b", "main"]);
    runGit(repoDir, ["config", "user.name", "test"]);
    runGit(repoDir, ["config", "user.email", "test@test.com"]);
    writeFileSync(join(repoDir, "README.md"), "# repo\n");
    runGit(repoDir, ["add", "."]);
    runGit(repoDir, ["commit", "-m", "initial commit"]);

    db = new KanbanDb(join(containerDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(containerDir, { recursive: true, force: true });
  });

  test("/board joins a recorded workspace with the live worktree", async () => {
    runGit(repoDir, ["worktree", "add", wtDir, "-b", "acme"]);
    const wts = await listWorktrees(repoDir);
    const acmeWt = wts.find((w) => w.branch === "acme");
    expect(acmeWt).toBeDefined();

    const task = db.createTask({ title: "Task on acme" });
    const app = createApp(db, { filesRoot: repoDir });

    const patchRes = await app.handle(
      new Request(`http://localhost/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: "acme" }),
      }),
    );
    expect(patchRes.status).toBe(200);

    const boardRes = await app.handle(new Request("http://localhost/board"));
    expect(boardRes.status).toBe(200);
    const payload = (await boardRes.json()) as BoardPayload;

    expect(payload.workspaces[task.id]).toEqual({
      branch: "acme",
      path: acmeWt!.path,
    });
  });

  test("branch without a worktree resolves path null", async () => {
    runGit(repoDir, ["branch", "solo"]);
    const task = db.createTask({ title: "Task on solo" });
    db.updateTask(task.id, { workspace: "solo" });

    const app = createApp(db, { filesRoot: repoDir });
    const boardRes = await app.handle(new Request("http://localhost/board"));
    const payload = (await boardRes.json()) as BoardPayload;

    expect(payload.workspaces[task.id]).toEqual({
      branch: "solo",
      path: null,
    });
  });

  test("no recorded workspace or gone branch shows nothing", async () => {
    runGit(repoDir, ["worktree", "add", wtDir, "-b", "acme"]);
    const taskFresh = db.createTask({ title: "Fresh task without workspace" });
    const taskWithWs = db.createTask({ title: "Task with acme" });
    db.updateTask(taskWithWs.id, { workspace: "acme" });

    const app = createApp(db, { filesRoot: repoDir });

    // fresh task has no workspace key
    let boardRes = await app.handle(new Request("http://localhost/board"));
    let payload = (await boardRes.json()) as BoardPayload;
    expect(payload.workspaces[taskFresh.id]).toBeUndefined();
    expect(payload.workspaces[taskWithWs.id]).toBeDefined();

    // Remove worktree and delete branch
    runGit(repoDir, ["worktree", "remove", "--force", wtDir]);
    runGit(repoDir, ["branch", "-D", "acme"]);

    boardRes = await app.handle(new Request("http://localhost/board"));
    payload = (await boardRes.json()) as BoardPayload;
    expect(payload.workspaces[taskWithWs.id]).toBeUndefined();

    // Card with workspace null is absent
    const taskNull = db.createTask({ title: "Task with null ws" });
    db.updateTask(taskNull.id, { workspace: null });
    boardRes = await app.handle(new Request("http://localhost/board"));
    payload = (await boardRes.json()) as BoardPayload;
    expect(payload.workspaces[taskNull.id]).toBeUndefined();
  });

  test("workspace updates as the git state changes", async () => {
    runGit(repoDir, ["worktree", "add", wtDir, "-b", "acme"]);
    runGit(repoDir, ["branch", "solo"]);
    const wts = await listWorktrees(repoDir);
    const acmeWt = wts.find((w) => w.branch === "acme")!;

    const task = db.createTask({ title: "Dynamic ws task" });
    db.updateTask(task.id, { workspace: "acme" });

    const app = createApp(db, { filesRoot: repoDir });

    // 1. worktree exists -> shows { branch: "acme", path }
    let boardRes = await app.handle(new Request("http://localhost/board"));
    let payload = (await boardRes.json()) as BoardPayload;
    expect(payload.workspaces[task.id]).toEqual({ branch: "acme", path: acmeWt.path });

    // 2. PATCH to another live branch solo -> shows { branch: "solo", path: null }
    const patchRes = await app.handle(
      new Request(`http://localhost/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: "solo" }),
      }),
    );
    expect(patchRes.status).toBe(200);

    boardRes = await app.handle(new Request("http://localhost/board"));
    payload = (await boardRes.json()) as BoardPayload;
    expect(payload.workspaces[task.id]).toEqual({ branch: "solo", path: null });

    // 3. remove solo branch -> shows nothing
    runGit(repoDir, ["branch", "-D", "solo"]);
    boardRes = await app.handle(new Request("http://localhost/board"));
    payload = (await boardRes.json()) as BoardPayload;
    expect(payload.workspaces[task.id]).toBeUndefined();
  });
});
