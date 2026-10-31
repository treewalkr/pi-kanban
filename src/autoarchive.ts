import { KanbanDb, type Task } from "./db";

export interface AutoArchiveOptions {
  db: KanbanDb;
  /** Sweep cadence after the boot sweep; default hourly. */
  intervalMs?: number;
  log?: (message: string) => void;
}

export const DEFAULT_AUTO_ARCHIVE_INTERVAL_MS = 3_600_000;

/**
 * Archive every done card past its auto-archive window, through the normal
 * moveTask write path (so each move is a lane_events row with cause
 * "auto-archive", actor "system"). Pure: no logging, no timers.
 */
export function runAutoArchive(db: KanbanDb, now: number = Date.now()): Task[] {
  const moved: Task[] = [];
  for (const t of db.dueForAutoArchive(now)) {
    moved.push(db.moveTask(t.id, "archive", undefined, { cause: "auto-archive", actor: "system" }));
  }
  return moved;
}

/**
 * Sweep once at boot (covers the time the server was down), then every
 * intervalMs. The interval timer is unref()d — a sweep must never keep a
 * process alive by itself; stop() clears it and is safe to call twice.
 */
export function startAutoArchiveSweep(opts: AutoArchiveOptions): { stop(): void } {
  const log = opts.log ?? (() => {});
  const sweep = (): void => {
    for (const t of runAutoArchive(opts.db)) {
      log(`archived ${t.id} — ${t.title}`);
    }
  };
  sweep();
  const timer = setInterval(sweep, opts.intervalMs ?? DEFAULT_AUTO_ARCHIVE_INTERVAL_MS);
  timer.unref?.();
  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
