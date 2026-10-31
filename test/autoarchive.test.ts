import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { KanbanDb, KanbanError } from "../src/db";

let dir = "";
let dbFile = "";
let db: KanbanDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-autoarchive-"));
  dbFile = join(dir, "t.db");
  db = new KanbanDb(dbFile);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;

/** Backdate rows directly — lane ages are day-granular and real time-travel is not an option. */
function backdate(sql: string, ...params: (string | number)[]): void {
  const raw = new Database(dbFile);
  raw.run(sql, params);
  raw.close();
}

/** moveTask to done, then stamp the card's latest done-entry `daysAgo` days back. */
function doneDaysAgo(title: string, daysAgo: number, now: number): ReturnType<typeof db.createTask> {
  const t = db.createTask({ title });
  db.moveTask(t.id, "done");
  backdate("UPDATE lane_events SET created_at = ? WHERE id = (SELECT MAX(id) FROM lane_events WHERE task_id = ? AND to_lane_id = 'done')", now - daysAgo * DAY, t.id);
  return db.resolveTask(t.id);
}

test("dueForAutoArchive selects done cards past N days by latest done-entry", () => {
  const now = Date.now();
  db.setAutoArchiveDays(7);
  const due = doneDaysAgo("done 8d ago", 8, now);
  const fresh = doneDaysAgo("done 6d ago", 6, now);
  const working = db.createTask({ title: "still implement", lane: "implement" });

  expect(db.dueForAutoArchive(now).map((t) => t.id)).toEqual([due.id]);

  // widening the window past the card's age drops it
  db.setAutoArchiveDays(9);
  expect(db.dueForAutoArchive(now)).toEqual([]);

  // 7-day window again, narrowing to 8 keeps exactly the 8d-old card
  db.setAutoArchiveDays(8);
  expect(db.dueForAutoArchive(now).map((t) => t.id)).toEqual([due.id]);

  // non-done lanes are never swept
  expect(db.resolveTask(fresh.id).laneId).toBe("done");
  expect(db.resolveTask(working.id).laneId).toBe("implement");
});

test("dueForAutoArchive uses the latest done-entry, not the first", () => {
  const now = Date.now();
  db.setAutoArchiveDays(7);
  const t = doneDaysAgo("bounced done", 8, now); // first done-entry: 8d old (would be due)
  db.moveTask(t.id, "implement"); // bounce out…
  db.moveTask(t.id, "done"); // …and back in just now
  expect(db.dueForAutoArchive(now)).toEqual([]); // clock restarted with the second done-entry
});

test("autoArchiveDays defaults to 7; setAutoArchiveDays validates 0–365", () => {
  expect(db.autoArchiveDays()).toBe(7); // absent board_state key

  db.setAutoArchiveDays(0);
  expect(db.autoArchiveDays()).toBe(0);
  const t = db.createTask({ title: "done card", lane: "done" });
  expect(db.dueForAutoArchive()).toEqual([]); // 0 disables the sweep entirely

  db.setAutoArchiveDays(365);
  expect(db.autoArchiveDays()).toBe(365);

  for (const bad of [366, -1, 1.5]) {
    try {
      db.setAutoArchiveDays(bad);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(KanbanError);
      expect((e as KanbanError).message).toBe("auto-archive days must be between 0 and 365");
      expect((e as KanbanError).code).toBe("invalid");
    }
  }
});

test("dueForAutoArchive falls back to updated_at when no done event exists", () => {
  const now = Date.now();
  db.setAutoArchiveDays(7);
  const t = db.createTask({ title: "pre-events done card", lane: "done" });
  // strip its history: the board wrote no done-entry for this card
  backdate("DELETE FROM lane_events WHERE task_id = ?", t.id);

  expect(db.dueForAutoArchive(now)).toEqual([]); // updated_at is fresh

  backdate("UPDATE tasks SET updated_at = ? WHERE id = ?", now - 8 * DAY, t.id);
  expect(db.dueForAutoArchive(now).map((x) => x.id)).toEqual([t.id]);
});
