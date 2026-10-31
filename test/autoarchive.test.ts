import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createApp } from "../src/app";
import { KanbanDb, KanbanError } from "../src/db";
import { runAutoArchive, startAutoArchiveSweep } from "../src/autoarchive";

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

test("runAutoArchive moves due cards to archive with cause auto-archive, actor system", () => {
  const now = Date.now();
  db.setAutoArchiveDays(7);
  const due = doneDaysAgo("done 8d ago", 8, now);
  const notDue = doneDaysAgo("done 1d ago", 1, now);

  const moved = runAutoArchive(db, now);
  expect(moved.map((t) => t.id)).toEqual([due.id]);
  expect(db.resolveTask(due.id).laneId).toBe("archive");

  // the move went through the normal write path: a lane event with the sweep's cause/actor
  const events = db.laneEvents(due.id);
  expect(events.at(-1)).toMatchObject({ toLaneId: "archive", cause: "auto-archive", actor: "system" });

  expect(db.resolveTask(notDue.id).laneId).toBe("done"); // untouched
});

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("startAutoArchiveSweep sweeps at boot and on interval; stop clears the timer", async () => {
  const now = Date.now();
  db.setAutoArchiveDays(7);
  const atBoot = doneDaysAgo("due before the sweep", 8, now);

  const logs: string[] = [];
  const sweep = startAutoArchiveSweep({ db, intervalMs: 20, log: (m) => logs.push(m) });

  // the boot sweep is synchronous — archived before we await anything
  expect(db.resolveTask(atBoot.id).laneId).toBe("archive");
  expect(logs).toEqual([`archived ${atBoot.id} — ${atBoot.title}`]);

  // a card becoming due mid-flight is swept by the interval tick
  const midFlight = doneDaysAgo("due mid-flight", 8, now);
  await settle(80);
  expect(db.resolveTask(midFlight.id).laneId).toBe("archive");

  // after stop() the interval no longer fires
  sweep.stop();
  sweep.stop(); // safe twice
  const afterStop = doneDaysAgo("due after stop", 8, now);
  await settle(80);
  expect(db.resolveTask(afterStop.id).laneId).toBe("done");
});

test("runAutoArchive with days=0 is a no-op", () => {
  const t = doneDaysAgo("done forever", 90, Date.now());
  db.setAutoArchiveDays(0);
  expect(runAutoArchive(db)).toEqual([]);
  expect(db.resolveTask(t.id).laneId).toBe("done");
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

// ---------- API ----------

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  app = createApp(db);
});

const apiCall = async (method: string, path: string, body?: unknown): Promise<Response> =>
  app.handle(new Request(`http://localhost${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  }));

test("GET/PUT /autoarchive round-trips days", async () => {
  const fresh = (await apiCall("GET", "/autoarchive")).json() as Promise<{ days: number }>;
  expect(await fresh).toEqual({ days: 7 });

  const put = (await apiCall("PUT", "/autoarchive", { days: 14 })).json() as Promise<{ days: number }>;
  expect(await put).toEqual({ days: 14 });
  expect(((await apiCall("GET", "/autoarchive")).json() as Promise<{ days: number }>)).resolves.toEqual({ days: 14 }); // persisted

  const off = (await apiCall("PUT", "/autoarchive", { days: 0 })).json() as Promise<{ days: number }>;
  expect(await off).toEqual({ days: 0 });
});

test("PUT /autoarchive rejects out-of-range and non-integer days", async () => {
  db.setAutoArchiveDays(3);
  for (const days of [366, -1, 1.5]) {
    const res = await apiCall("PUT", "/autoarchive", { days });
    expect(res.status).toBeGreaterThanOrEqual(400); // Elysia validation 422 or fail() 400
    expect(db.autoArchiveDays()).toBe(3); // the failed PUT changed nothing
  }
});
