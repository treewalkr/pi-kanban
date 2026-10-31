import type { Attachment, Lane, Task } from "../../../src/db";
import { searchBoard } from "../../../src/search";

export const PALETTE_MAX = 20;

export type PaletteAction =
  | { type: "jump"; taskId: string }
  | { type: "project"; name: string } // "" = all projects
  | { type: "lane-go"; laneId: string }
  | { type: "lane-move"; laneId: string; dir: -1 | 1 }
  | { type: "archive-toggle"; open: boolean };

export interface PaletteItem {
  kind: "card" | "project" | "lane";
  /** Unique render key: `${kind}:${action stable form}` (+ matched text for card rows). */
  key: string;
  /** Primary matched/display text. */
  label: string;
  /** Secondary line. */
  detail: string;
  score: number;
  action: PaletteAction;
}

export interface PaletteInput {
  query: string;
  tasks: Task[];
  plans: Record<string, Attachment>;
  /** Pass board.projects verbatim (sorted, "" excluded). */
  projects: string[];
  projectFilter: string;
  /** Pass board.lanes verbatim (order = board order). */
  lanes: Lane[];
  archiveOpen: boolean;
}

/** Lane name + ancestor titles, root first, joined with " · " — "" if unknown. */
export function laneCrumb(tasks: Task[], lanes: Lane[], taskId: string): string {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return "";
  const lane = lanes.find((l) => l.id === task.laneId)?.name ?? task.laneId;
  const titles: string[] = [];
  const byId = (id: string) => tasks.find((t) => t.id === id);
  let cur = task;
  while (cur.parentId) {
    const parent = byId(cur.parentId);
    if (!parent) break;
    titles.unshift(parent.title);
    cur = parent;
  }
  return [lane, ...titles].join(" · ");
}

function projectLabel(name: string): string {
  return name === "" ? "all projects" : `~/${name}`;
}

function matchScore(label: string, q: string, startsWith: number, includes: number): number | null {
  const l = label.toLowerCase();
  if (l.startsWith(q)) return startsWith;
  if (l.includes(q)) return includes;
  return null;
}

/** One merged, deterministic item list for the ⌘K palette. */
export function paletteItems(input: PaletteInput): PaletteItem[] {
  const { query, tasks, plans, projects, projectFilter, lanes, archiveOpen } = input;
  const q = query.trim().toLowerCase();
  const laneCount = (laneId: string) => tasks.filter((t) => t.laneId === laneId).length;

  const projectItems = (blank: boolean): PaletteItem[] =>
    ["", ...projects]
      .map((name): PaletteItem | null => {
        const label = projectLabel(name);
        const score = blank ? 0 : matchScore(label, q, 95, 75);
        if (score === null) return null;
        return {
          kind: "project",
          key: `project:${name}`,
          label,
          detail: name === projectFilter ? "current" : "switch",
          score,
          action: { type: "project", name },
        };
      })
      .filter((i): i is PaletteItem => i !== null);

  const laneItems = (blank: boolean): PaletteItem[] => {
    const out: PaletteItem[] = [];
    lanes.forEach((lane, index) => {
      const candidates: Array<{ label: string; action: PaletteAction; detail: string }> = [
        { label: `go to ${lane.name}`, action: { type: "lane-go", laneId: lane.id }, detail: `${laneCount(lane.id)} cards` },
      ];
      if (index > 0)
        candidates.push({
          label: `move ${lane.name} left`,
          action: { type: "lane-move", laneId: lane.id, dir: -1 },
          detail: "lane",
        });
      if (index < lanes.length - 1)
        candidates.push({
          label: `move ${lane.name} right`,
          action: { type: "lane-move", laneId: lane.id, dir: 1 },
          detail: "lane",
        });
      if (lane.id === "archive")
        candidates.push({
          label: archiveOpen ? "collapse archive" : "expand archive",
          action: { type: "archive-toggle", open: !archiveOpen },
          detail: "lane",
        });
      for (const c of candidates) {
        const score = blank ? 0 : matchScore(c.label, q, 90, 70);
        if (score === null) continue;
        const a = c.action;
        let key: string;
        if (a.type === "lane-go") key = `lane:go:${a.laneId}`;
        else if (a.type === "lane-move") key = `lane:move:${a.laneId}:${a.dir}`;
        else if (a.type === "archive-toggle") key = `lane:archive:${a.open}`;
        else continue; // jump/project never appear in lane candidates
        out.push({
          kind: "lane",
          key,
          label: c.label,
          detail: c.detail,
          score,
          action: c.action,
        });
      }
    });
    return out;
  };

  if (q === "") {
    return [...projectItems(true), ...laneItems(true)].slice(0, PALETTE_MAX);
  }

  const cardItems: PaletteItem[] = searchBoard(tasks, query, plans).map((r) => ({
    kind: "card",
    key: `card:jump:${r.task.id}:${r.text}`,
    label: r.text,
    detail: laneCrumb(tasks, lanes, r.task.id),
    score: r.score,
    action: { type: "jump", taskId: r.task.id },
  }));

  const kindOrder = { card: 0, project: 1, lane: 2 } as const;
  return [...cardItems, ...projectItems(false), ...laneItems(false)]
    .sort(
      (a, b) =>
        b.score - a.score ||
        kindOrder[a.kind] - kindOrder[b.kind] ||
        (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
    )
    .slice(0, PALETTE_MAX);
}
