import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanDb, KanbanError } from "../src/db";

describe("card workspace field contract", () => {
  let tmpDir = "";
  let db: KanbanDb;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kanban-db-ws-test-"));
    db = new KanbanDb(join(tmpDir, "test.db"));
  });

  afterEach(() => {
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
