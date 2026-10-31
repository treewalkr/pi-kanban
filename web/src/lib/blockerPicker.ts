import type { Task } from "../../../src/db";
import { searchBoard } from "../../../src/search";

/** Max candidates shown in the add-blocker dropdown. */
export const BLOCKER_PICKER_MAX = 8;

/** Add-blocker picker candidates: board tasks matching `query` by title or id
 *  (searchBoard ranking, title-kind rows only), excluding the card itself and
 *  its current blockers. Empty query → empty list (matches SearchBox). */
export function blockerCandidates(
  tasks: Task[],
  query: string,
  selfId: string,
  currentBlockerIds: string[],
): Task[] {
  const q = query.trim();
  if (!q) return [];
  const excluded = new Set([selfId, ...currentBlockerIds]);
  return searchBoard(tasks, q)
    .filter((r) => r.kind === "title" && !excluded.has(r.task.id))
    .map((r) => r.task)
    .slice(0, BLOCKER_PICKER_MAX);
}
