import type { Task } from "../../../src/db";

/** One rendered row of the list view: a task at a depth, with subtree rollups. */
export interface ListRow {
  task: Task;
  /** Indentation level — 0 for roots (including orphans of archived parents). */
  depth: number;
  /** True when the task itself doesn't match the filter — kept only so matching descendants stay attached. */
  dim: boolean;
  /** Done descendants, any lane (archive included), matching the board's progress badge. */
  done: number;
  /** All descendants, any lane. */
  total: number;
  /** Latest update in the subtree — drives root ordering (active work bubbles up). */
  subtreeUpdated: number;
}

/**
 * Flatten tasks into hierarchy rows: subtasks nest under their parents
 * regardless of lane, archive stays out, and filters keep subtrees together.
 */
export function listRows(tasks: Task[], match: (t: Task) => boolean): ListRow[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));

  // children keyed over ALL tasks (archive included) so progress spans everything;
  // activeKids holds only what can render — archive stays off the list
  const kids = new Map<string, Task[]>();
  const activeKids = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!t.parentId || !byId.has(t.parentId)) continue;
    push(kids, t.parentId, t);
    if (t.laneId !== "archive") push(activeKids, t.parentId, t);
  }

  // subtree rollups: done/total descendants (any lane) and latest updatedAt
  const rollups = new Map<string, { done: number; total: number; updated: number }>();
  function rollup(id: string, seen: Set<string> = new Set()): { done: number; total: number; updated: number } {
    const memo = rollups.get(id);
    if (memo) return memo;
    const t = byId.get(id);
    let done = 0;
    let total = 0;
    let updated = t?.updatedAt ?? 0;
    if (t && !seen.has(id)) {
      seen.add(id); // cycle guard: a malformed parent loop can't recurse forever
      for (const child of kids.get(id) ?? []) {
        if (child.laneId === "done") done += 1;
        total += 1;
        const sub = rollup(child.id, seen);
        done += sub.done;
        total += sub.total;
        updated = Math.max(updated, child.updatedAt, sub.updated);
      }
    }
    const out = { done, total, updated };
    rollups.set(id, out);
    return out;
  }

  // inheritance: a matching task drags its whole subtree along as one unit
  const heirMemo = new Map<string, boolean>();
  function heirOf(id: string): boolean {
    const memo = heirMemo.get(id);
    if (memo !== undefined) return memo;
    const t = byId.get(id)!;
    const parent = t.parentId ? byId.get(t.parentId) : undefined;
    const out = !!parent && (match(parent) || heirOf(parent.id));
    heirMemo.set(id, out);
    return out;
  }

  // a task renders when it matches, inherits from a matched ancestor, or carries
  // a matching descendant — filters must not strand a match or orphan its context
  const visibleMemo = new Map<string, boolean>();
  function visible(id: string): boolean {
    const memo = visibleMemo.get(id);
    if (memo !== undefined) return memo;
    const t = byId.get(id)!;
    const out =
      t.laneId !== "archive" &&
      (match(t) || heirOf(id) || (activeKids.get(id) ?? []).some((c) => visible(c.id)));
    visibleMemo.set(id, out);
    return out;
  }

  // roots: no parent, or the parent is gone/archived (the board shows such
  // orphans loose in their lanes too — the list keeps the same convention)
  const roots = tasks.filter((t) => {
    if (t.laneId === "archive" || !visible(t.id)) return false;
    const parent = t.parentId ? byId.get(t.parentId) : undefined;
    return !parent || parent.laneId === "archive" || !visible(parent.id);
  });
  roots.sort(
    (a, b) =>
      rollup(b.id).updated - rollup(a.id).updated || a.updatedAt - b.updatedAt || a.id.localeCompare(b.id),
  );

  const rows: ListRow[] = [];
  const walk = (id: string, depth: number): void => {
    const t = byId.get(id)!;
    const { done, total, updated } = rollup(id);
    // dim marks pure context: kept only to lead to a match, not part of a matched unit
    rows.push({ task: t, depth, dim: !match(t) && !heirOf(id), done, total, subtreeUpdated: updated });
    const children = (activeKids.get(id) ?? [])
      .filter((c) => visible(c.id))
      .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (const child of children) walk(child.id, depth + 1);
  };
  for (const root of roots) walk(root.id, 0);
  return rows;
}

function push(map: Map<string, Task[]>, key: string, t: Task): void {
  const list = map.get(key);
  if (list) list.push(t);
  else map.set(key, [t]);
}
