import type { BoardStatsPayload, CardStats, Comment, KanbanDb, Lane, Task } from "./db";
import type { SearchResult } from "./search";
import { clockTime, formatDuration, KIND_TAG_COLORS, latestStateIndex, relTime, shortDate, wrapText } from "./thread";

const enabled = !!process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code: string, s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  dim: (s: string) => wrap("2", s),
  bold: (s: string) => wrap("1", s),
  red: (s: string) => wrap("31", s),
  green: (s: string) => wrap("32", s),
  hex: (hex: string, s: string) => {
    if (!enabled) return s;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
  },
};

export const LANE_COLORS = ["#7d8590", "#58a6ff", "#d29922", "#bc8cff", "#3fb950", "#ff7b72", "#39c5cf", "#e3b341"];

export function laneColor(index: number): string {
  return LANE_COLORS[index % LANE_COLORS.length];
}

function truncate(s: string, max: number): string {
  const lines = s.split("\n")[0] ?? "";
  return lines.length > max ? `${lines.slice(0, max - 1)}…` : lines;
}

/** Board overview: every lane (or one) with its tasks. */
export function listLanes(db: KanbanDb, laneRef?: string, project?: string): string {
  const all = db.lanes();
  const lanes = laneRef ? [db.resolveLane(laneRef)] : all;
  const width = process.stdout.columns ?? 80;
  const out: string[] = [];
  lanes.forEach((lane) => {
    const idx = all.findIndex((l) => l.id === lane.id);
    const color = laneColor(idx >= 0 ? idx : 0);
    const tasks = db
      .laneTasks(lane.id)
      .filter((t) => (project ? t.project === project : true));
    out.push(c.hex(color, `● ${lane.name}`) + c.dim(`  ${tasks.length}`));
    if (tasks.length === 0) {
      out.push(c.dim("  (empty)"));
    } else {
      // children nest under a parent visible in the same lane
      const visible = new Set(tasks.map((t) => t.id));
      const emit = (t: Task, depth: number): void => {
        const chip = t.project ? c.dim(` [${t.project}]`) : "";
        const titleWidth = Math.max(20, width - 10 - chip.length - depth * 4);
        const lead = depth === 0 ? "  " : `${"  ".repeat(depth)}└ `;
        const prio = t.priority === "high" ? `${c.red("▲")} ` : t.priority === "low" ? `${c.dim("▼")} ` : "";
        const blocked = db.isBlocked(t.id) ? ` ${c.hex("#d29922", "⊘")}` : "";
        const waiting = t.laneId === "waiting" ? ` ${c.hex("#bc8cff", "☉")}` : "";
        out.push(`${lead}${c.dim(t.id)}  ${prio}${truncate(t.title, titleWidth)}${blocked}${waiting}${chip}`);
        for (const child of db.childrenOf(t.id)) {
          if (visible.has(child.id)) emit(child, depth + 1);
        }
      };
      tasks.filter((t) => !(t.parentId && visible.has(t.parentId))).forEach((t) => emit(t, 0));
    }
    out.push("");
  });
  return out.join("\n");
}

/** Compact single-line summary of a task, e.g. after add/mv/edit. */
export function taskLine(db: KanbanDb, task: Task): string {
  const lanes = db.lanes();
  const lane = lanes.find((l) => l.id === task.laneId);
  const color = laneColor(lanes.indexOf(lane!));
  const chip = task.project ? c.dim(` [${task.project}]`) : "";
  return `${c.green("✓")} ${c.dim(task.id)}  ${task.title}${chip}  ${c.hex(color, `→ ${lane?.name ?? task.laneId}`)}`;
}

/** One-line confirmation after writing a comment. */
export function commentLine(comment: Comment): string {
  const kind = comment.kind === "comment" ? "" : ` ${c.dim(`(${comment.kind})`)}`;
  return `${c.green("✓")} ${c.dim(comment.id)}  ${comment.author}${kind}  ${truncate(comment.body, 60)}`;
}

/** A card's thread, oldest first — scannable day-grouped layout with kind tags and latest state marker. */
export function commentThread(
  comments: Comment[],
  width: number = process.stdout.columns ?? 80,
  now: number = Date.now(),
): string {
  if (comments.length === 0) return c.dim("no comments");

  const latestIdx = latestStateIndex(comments);
  const bodyWidth = Math.max(20, width - 2);

  const sameDay = (t1: number, t2: number): boolean => {
    const d1 = new Date(t1);
    const d2 = new Date(t2);
    return (
      d1.getFullYear() === d2.getFullYear() &&
      d1.getMonth() === d2.getMonth() &&
      d1.getDate() === d2.getDate()
    );
  };

  type CommentWithIndex = { comment: Comment; index: number };
  const groups: Array<{ dateLabel: string; items: CommentWithIndex[] }> = [];
  let currentItems: CommentWithIndex[] = [];

  for (let i = 0; i < comments.length; i++) {
    const com = comments[i]!;
    if (i > 0 && !sameDay(comments[i - 1]!.createdAt, com.createdAt)) {
      groups.push({
        dateLabel: shortDate(currentItems[0]!.comment.createdAt, now),
        items: currentItems,
      });
      currentItems = [];
    }
    currentItems.push({ comment: com, index: i });
  }
  if (currentItems.length > 0) {
    groups.push({
      dateLabel: shortDate(currentItems[0]!.comment.createdAt, now),
      items: currentItems,
    });
  }

  const renderedGroups = groups.map((group) => {
    const sep = c.dim(`── ${group.dateLabel}`);
    const commentBlocks = group.items.map(({ comment, index }) => {
      const isLatestState = index === latestIdx;
      const isLast = index === comments.length - 1;

      const parts: string[] = [
        c.dim(clockTime(comment.createdAt)),
        c.bold(comment.author),
      ];
      if (comment.kind !== "comment") {
        const color = KIND_TAG_COLORS[comment.kind] ?? "#7d8590";
        parts.push(c.hex(color, `[${comment.kind}]`));
      }
      if (isLast) {
        parts.push(c.dim(relTime(comment.createdAt, now)));
      }
      const meta = (isLatestState ? c.bold("▶ ") : "") + parts.join(" · ");
      const bodyLines = wrapText(comment.body, bodyWidth)
        .map((line) => `  ${line}`)
        .join("\n");
      return `${meta}\n${bodyLines}`;
    });
    return `${sep}\n${commentBlocks.join("\n\n")}`;
  });

  return renderedGroups.join("\n\n");
}

/** Ranked search results, best first — title rows read like `ls`, checklists keep their box. */
export function searchResults(db: KanbanDb, query: string, results: SearchResult[]): string {
  if (results.length === 0) return c.dim(`no matches for '${query}'`);
  const lanes = db.lanes();
  const width = process.stdout.columns ?? 80;
  const out: string[] = [c.dim(`${results.length} match${results.length === 1 ? "" : "es"} for '${query}'`)];
  for (const r of results) {
    const lane = lanes.find((l) => l.id === r.task.laneId);
    const chip = r.task.project ? c.dim(` [${r.task.project}]`) : "";
    const max = Math.max(20, width - 10 - chip.length);
    const text =
      r.kind === "checklist"
        ? `${c.dim(r.checked ? "[x]" : "[ ]")} ${truncate(r.text, max - 4)}`
        : r.kind === "tag"
          ? `${c.dim("tag:")} ${truncate(r.text, max - 5)}`
          : r.kind === "note"
            ? `${c.dim("note:")} ${truncate(r.text, max - 6)}`
            : r.kind === "plan"
              ? `${c.dim("plan:")} ${truncate(r.text, max - 6)}`
              : truncate(r.text, max);
    const arrow = c.hex(laneColor(lanes.indexOf(lane!)), `→ ${lane?.name ?? r.task.laneId}`);
    out.push(`  ${c.dim(r.task.id)}  ${text}${chip}  ${arrow}`);
  }
  return out.join("\n");
}

/** Human byte size for file listings — 999b, then 1.4k. */
export function fileSize(len: number): string {
  return len > 1024 ? `${(len / 1024).toFixed(1)}k` : `${len}b`;
}

/** Full detail view of one task. */
export function taskDetail(db: KanbanDb, task: Task): string {
  const lanes = db.lanes();
  const lane = lanes.find((l) => l.id === task.laneId);
  const color = laneColor(lanes.indexOf(lane!));
  const out = [c.bold(task.title), `${c.dim("id:")}      ${task.id}`];
  if (task.parentId) {
    const parent = db.tasks().find((t) => t.id === task.parentId);
    out.push(`${c.dim("parent:")}  ${parent ? `${c.dim(parent.id)}  ${parent.title}` : c.dim(task.parentId)}`);
  }
  if (task.laneId === "waiting" && task.previousLane) {
    const fromLane = db.lanes().find((l) => l.id === task.previousLane);
    out.push(`${c.dim("from:")}    ${fromLane ? `${fromLane.name} (${fromLane.id})` : task.previousLane}`);
  }
  if (task.priority !== "normal") {
    out.push(`${c.dim("priority:")} ${task.priority}`);
  }
  const blockers = db.blockers(task.id);
  for (const b of blockers) {
    out.push(`${c.dim("blocked by:")} ${c.dim(b.id)}  ${b.title}`);
  }
  const blocking = db.blocking(task.id);
  for (const b of blocking) {
    out.push(`${c.dim("blocking:")}   ${c.dim(b.id)}  ${b.title}`);
  }
  const links = db.linksOf(task.id);
  for (const l of links) {
    out.push(`${c.dim("linked:")}     ${c.dim(l.id)}  ${l.title}`);
  }
  out.push(
    `${c.dim("lane:")}    ${c.hex(color, lane?.name ?? task.laneId)}${lane ? c.dim(` (${lane.id})`) : ""}`,
    `${c.dim("project:")} ${task.project || c.dim("—")}`,
    `${c.dim("workspace:")} ${task.workspace ?? c.dim("—")}`,
    `${c.dim("created:")} ${new Date(task.createdAt).toLocaleString()}`,
    `${c.dim("updated:")} ${new Date(task.updatedAt).toLocaleString()}`,
  );
  if (task.note) {
    out.push(c.dim("note:"));
    for (const line of task.note.split("\n")) out.push(`  ${line}`);
  }
  const plan = db.latestPlan(task.id);
  if (plan) {
    const meta = [`v${plan.version}`, plan.source, new Date(plan.createdAt).toLocaleString()].filter(Boolean).join(" · ");
    out.push(`${c.dim("plan:")} ${c.dim(meta)}`);
    for (const line of plan.content.split("\n")) out.push(`  ${line}`);
  }
  const files = db.latestFiles(task.id).filter((f) => f.kind !== "plan");
  if (files.length > 0) {
    out.push(c.dim("files:"));
    for (const f of files) {
      out.push(`  ${f.kind} ${c.dim(`v${f.version} · ${fileSize(f.content.length)}${f.source ? ` · ${f.source}` : ""}`)}`);
    }
    out.push(c.dim("  (kanban cat <id> <name> prints one)"));
  }
  const sessions = db.attachments(task.id, "session");
  if (sessions.length > 0) {
    out.push(c.dim("sessions:"));
    for (const s of sessions) {
      const firstLine = s.content.split("\n")[0];
      out.push(`  ${c.dim(firstLine)}`);
    }
  }
  const comments = db.comments(task.id);
  if (comments.length > 0) {
    out.push(c.dim("thread:"));
    out.push(commentThread(comments));
  }
  const children = db.childrenOf(task.id);
  if (children.length > 0) {
    out.push(c.dim("children:"));
    const emit = (t: Task, depth: number): void => {
      const cl = lanes.find((l) => l.id === t.laneId);
      const cc = laneColor(lanes.indexOf(cl!));
      out.push(
        `${"  ".repeat(depth + 1)}${c.dim(t.id)}  ${truncate(t.title, 60)}  ${c.hex(cc, `→ ${cl?.name ?? t.laneId}`)}`,
      );
      db.childrenOf(t.id).forEach((gc) => emit(gc, depth + 1));
    };
    children.forEach((child) => emit(child, 0));
  }
  return out.join("\n");
}

/** Lane list for `kanban lane ls`. */
export function laneList(db: KanbanDb): string {
  return db
    .lanes()
    .map((l, i) => {
      const n = db.taskCount(l.id);
      const fixed = l.fixed ? c.dim(" · fixed") : "";
      return `${c.dim(`${i + 1}.`)} ${c.hex(laneColor(i), l.name)}${c.dim(` (${l.id})`)}  ${n}${fixed}`;
    })
    .join("\n");
}

export function statsCard(db: KanbanDb, task: Task, stats: CardStats): string {
  const lanes = db.lanes();
  const laneMap = new Map(lanes.map((l) => [l.id, l.name]));
  const currentLaneName = laneMap.get(task.laneId) ?? task.laneId;

  const out: string[] = [
    c.bold(task.title),
    `${c.dim("id:")}           ${c.dim(task.id)}`,
    `${c.dim("cycle:")}        ${formatDuration(stats.cycleMs)} ${stats.reachedDone ? "(created → first done)" : "(created → now, not done yet)"}`,
    `${c.dim("current lane:")} ${currentLaneName} ${formatDuration(stats.currentLaneMs)}`,
    `${c.dim("gate wait:")}    ${formatDuration(stats.gateWaitMs)}`,
  ];

  if (stats.reviewToDoneMs !== null) {
    out.push(`${c.dim("review → done:")} ${formatDuration(stats.reviewToDoneMs)}`);
  }

  out.push(c.dim("lane times:"));
  for (const lt of stats.laneTimes) {
    const name = laneMap.get(lt.laneId) ?? lt.laneId;
    out.push(`  ${name} · ${formatDuration(lt.ms)}`);
  }

  const loopHealth = `${stats.planReviewBlocks} plan-review blocks · ${stats.reviewBlocks} review blocks · ${stats.cappedHits} cap hits · ${stats.planVersions} plan versions · ${stats.sessions.count} sessions (${formatDuration(stats.sessions.totalMs)})`;
  out.push(`${c.dim("loop health:")} ${loopHealth}`);

  return out.join("\n");
}

export function statsBoard(db: KanbanDb, payload: BoardStatsPayload): string {
  const lanes = db.lanes();
  const laneMap = new Map(lanes.map((l) => [l.id, l.name]));

  const wipLine =
    payload.board.cycleAvgMs !== null
      ? `${c.dim("wip:")} ${payload.board.wip} · avg cycle ${formatDuration(payload.board.cycleAvgMs)}`
      : `${c.dim("wip:")} ${payload.board.wip}`;

  const out: string[] = [wipLine];

  out.push(c.dim("throughput (done/week):"));
  for (const tw of payload.board.throughput) {
    out.push(`  ${shortDate(tw.weekStart, payload.generatedAt)} · ${tw.done}`);
  }

  out.push(c.dim("lane dwell:"));
  for (const lane of lanes) {
    const dwell = payload.board.laneDwell[lane.id];
    if (dwell) {
      out.push(`  ${lane.name} · ${formatDuration(dwell.avgMs)} avg · ${dwell.cards} cards`);
    }
  }
  for (const [laneId, dwell] of Object.entries(payload.board.laneDwell)) {
    if (!laneMap.has(laneId)) {
      out.push(`  ${laneId} · ${formatDuration(dwell.avgMs)} avg · ${dwell.cards} cards`);
    }
  }

  out.push(c.dim("projects:"));
  for (const p of payload.board.projects) {
    const projName = p.project === "" ? "(none)" : p.project;
    out.push(`  ${projName} · ${p.total} total · ${p.active} active · ${p.done} done`);
  }

  return out.join("\n");
}
