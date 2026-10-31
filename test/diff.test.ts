import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanDb, KanbanError } from "../src/db";
import { cardFileDiff, textDiff } from "../src/diff";

let dir = "";
let db: KanbanDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-diff-"));
  db = new KanbanDb(join(dir, "t.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("textDiff shells git --no-index with version labels; identical content is no-change", () => {
  const r = textDiff("a\nb\n", "a\nc\n", "v1", "v2");
  expect(r.supported).toBe(true);
  expect(r.patch).toContain("diff --git a/v1 b/v2");
  expect(r.patch).toContain("--- a/v1");
  expect(r.patch).toContain("+++ b/v2");
  expect(r.patch).toContain("-b");
  expect(r.patch).toContain("+c");

  const same = textDiff("a\nb\n", "a\nb\n", "v1", "v2");
  expect(same).toEqual({ supported: true, patch: "" });
});

test("cardFileDiff defaults to the latest adjacent pair; validates name, versions, range", () => {
  const t = db.createTask({ title: "diff host" });
  db.attach(t.id, "design", "design v1\n", "a.md");
  db.attach(t.id, "design", "design v2\n", "b.md");
  db.attach(t.id, "design", "design v3\n", "c.md");
  db.attach(t.id, "one", "only\n", "x.txt");

  const d = cardFileDiff(db, t.id, "design");
  expect(d.name).toBe("design");
  expect(d.from.version).toBe(2);
  expect(d.to.version).toBe(3);
  expect(d.patch).toContain("+design v3");
  expect(d.patch).toContain("-design v2");

  const any = cardFileDiff(db, t.id, "design", 1, 3);
  expect(any.from.version).toBe(1);
  expect(any.to.version).toBe(3);

  expect(() => cardFileDiff(db, t.id, "zz")).toThrow(
    new KanbanError("no file 'zz' on card — files: design, one", "not-found"),
  );
  expect(() => cardFileDiff(db, t.id, "one")).toThrow(
    new KanbanError("only v1 of 'one' — nothing to diff", "conflict"),
  );
  expect(() => cardFileDiff(db, t.id, "design", 9)).toThrow(
    new KanbanError("no v9 of 'design' — versions v1–v3", "not-found"),
  );
  expect(() => cardFileDiff(db, t.id, "design", 2, 1)).toThrow(
    new KanbanError("invalid range: v2 → v1 (from must be lower than to)", "invalid"),
  );
});
