import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanDb, KanbanError } from "../src/db";

let dir = "";
let db: KanbanDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-elaborate-"));
  db = new KanbanDb(join(dir, "t.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("elaborationRequests: queue → list → clear; on conflict updates timestamp", async () => {
  const t1 = db.createTask({ title: "First task" });
  const t2 = db.createTask({ title: "Second task" });

  expect(db.elaborationRequests()).toEqual([]);

  db.queueElaboration(t1.id);
  await new Promise((r) => setTimeout(r, 10));
  db.queueElaboration(t2.id);

  const reqs = db.elaborationRequests();
  expect(reqs.map((r) => r.taskId)).toEqual([t1.id, t2.id]);
  expect(reqs[0].requestedAt).toBeLessThanOrEqual(reqs[1].requestedAt);

  // on conflict update
  await new Promise((r) => setTimeout(r, 10));
  db.queueElaboration(t1.id);
  const updatedReqs = db.elaborationRequests();
  expect(updatedReqs.map((r) => r.taskId)).toEqual([t2.id, t1.id]);

  db.clearElaboration(t2.id);
  expect(db.elaborationRequests().map((r) => r.taskId)).toEqual([t1.id]);
  db.clearElaboration(t1.id);
  expect(db.elaborationRequests()).toEqual([]);
});

test("deleteTask cascades to elaboration_requests for task and descendants", () => {
  const parent = db.createTask({ title: "Parent task" });
  const child = db.createTask({ title: "Child task", parent: parent.id });

  db.queueElaboration(parent.id);
  db.queueElaboration(child.id);
  expect(db.elaborationRequests().length).toBe(2);

  db.deleteTask(parent.id, true);
  expect(db.elaborationRequests()).toEqual([]);
});

test("setAgentConfig accepts elaborator; invalid role error names elaborator", () => {
  const saved = db.setAgentConfig("elaborator", {
    model: "claude-haiku-3-5",
    thinking: "off",
  });
  expect(saved).toEqual({
    model: "claude-haiku-3-5",
    thinking: "off",
  });
  expect(db.agentConfig("elaborator")).toEqual(saved);

  expect(() => db.setAgentConfig("invalid-role", {})).toThrow(
    "unknown agent role 'invalid-role' (reviewer | builder | planner | plan-reviewer | elaborator)",
  );
});
