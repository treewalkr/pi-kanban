import type { BoardStatsPayload, Task } from "../../../src/db";
import { formatDuration } from "../../../src/thread";

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
