import type { BoardStatsPayload, Lane, Task } from "../../../src/db";
import { formatDuration } from "../../../src/thread";

export interface ThroughputBar {
  weekStart: number;
  done: number;
  heightPct: number;
}

/** Normalized done-per-week bars (payload order, oldest first); null stats -> []. */
export function throughputBars(stats: BoardStatsPayload | null): ThroughputBar[] {
  if (!stats) return [];
  const weeks = stats.board.throughput;
  const maxDone = Math.max(...weeks.map((w) => w.done), 0);
  return weeks.map((w) => ({
    weekStart: w.weekStart,
    done: w.done,
    heightPct: maxDone === 0 ? 0 : Math.round((w.done / maxDone) * 100),
  }));
}

export interface LaneCycleRow {
  laneId: string;
  name: string;
  avgMs: number;
  cards: number;
  widthPct: number;
}

/** Per-lane average-dwell rows in board lane order (visited lanes only); null stats -> []. */
export function laneCycleRows(stats: BoardStatsPayload | null, lanes: Lane[]): LaneCycleRow[] {
  if (!stats) return [];
  const dwell = stats.board.laneDwell;
  const rows: LaneCycleRow[] = [];
  for (const lane of lanes) {
    const d = dwell[lane.id];
    if (!d || d.cards === 0) continue;
    rows.push({ laneId: lane.id, name: lane.name, avgMs: d.avgMs, cards: d.cards, widthPct: 0 });
  }
  const maxAvg = Math.max(...rows.map((r) => r.avgMs), 0);
  for (const r of rows) {
    r.widthPct = maxAvg === 0 ? 0 : Math.round((r.avgMs / maxAvg) * 100);
  }
  return rows;
}

export function laneDwellLabel(stats: BoardStatsPayload | null, laneId: string): string | null {
  if (!stats) return null;
  const dwell = stats.board.laneDwell[laneId];
  if (!dwell || dwell.cards === 0) return null;
  return `${formatDuration(dwell.avgMs)} avg`;
}

export function cycleChip(stats: BoardStatsPayload | null, task: Task): { label: string; title: string } | null {
  if (!stats || !stats.cards[task.id]) return null;
  const card = stats.cards[task.id];
  const label = formatDuration(card.cycleMs);
  const title = card.reachedDone ? "cycle time — created → first done" : "age — created → now";
  return { label, title };
}
