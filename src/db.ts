import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { newId, slugify } from "./ids";

/** Identity of one server/loop instance for agent session leases. */
export interface LeaseOwner {
  pid: number;
  bootId: number;
}

/** A held agent session lease — one agent works a card at a time, process-wide. */
export interface AgentLease {
  taskId: string;
  role: string;
  ownerPid: number;
  bootId: number;
  heartbeatAt: number;
}

export interface Lane {
  id: string;
  name: string;
  description: string;
  position: number;
  fixed: number;
}

export interface Task {
  id: string;
  title: string;
  note: string;
  laneId: string;
  project: string;
  parentId: string | null;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface Attachment {
  id: string;
  taskId: string;
  kind: string; // "plan" today; the table is generic for future artifact kinds
  version: number;
  content: string;
  source: string; // path the content was read from, informational only
  createdAt: number;
}

export type CommentKind = "comment" | "review" | "handoff" | "approval" | "rejection" | "question";

/** Why a Plan-lane card (or any-lane dead-session card) is waiting on the human (from its thread's last comment). */
export type WaitingState = "gate" | "question" | "rerun" | "capped" | "dead";

/** Author of plan-review verdicts/failure comments — shared by the loop and the waiting classifier. */
export const PLAN_REVIEWER_AUTHOR = "pi-plan-reviewer";

export type AgentRole = "reviewer" | "builder" | "planner" | "plan-reviewer";

export type AgentThinking = "" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Per-role pi agent settings for the auto-review loop; stored as one JSON blob per role. */
export interface AgentConfig {
  provider?: string;
  model?: string;
  thinking?: AgentThinking;
  skills?: string[]; // paths passed to pi as --skill
  context?: string; // passed as --append-system-prompt
  tools?: string;
  extraArgs?: string[]; // raw pi flags
  timeoutMs?: number;
}

export interface Comment {
  id: string;
  taskId: string;
  author: string;
  kind: CommentKind;
  body: string;
  createdAt: number;
}

export interface Board {
  lanes: Lane[];
  tasks: Task[];
  plans: Record<string, Attachment>;
  /** Plan-lane cards waiting on the human, keyed by task id (sparse — absent key = not waiting). */
  waiting: Record<string, WaitingState>;
}

export interface TaskPatch {
  title?: string;
  note?: string;
  project?: string;
  lane?: string; // lane ref: id, id prefix, name prefix, or 1-based ordinal
  parent?: string | null; // task ref to attach under; null detaches
  index?: number; // 0-based position within the target lane; omit to append
}

export interface LanePatch {
  name?: string;
  description?: string;
  index?: number; // 0-based position among lanes
}

export type KanbanErrorCode = "not-found" | "conflict" | "invalid";

export class KanbanError extends Error {
  constructor(
    message: string,
    public code: KanbanErrorCode = "invalid",
  ) {
    super(message);
  }
}

const GAP = 100;
const MIN_GAP = 0.01;

const COMMENT_KINDS: ReadonlySet<string> = new Set(["comment", "review", "handoff", "approval", "rejection", "question"]);
const AGENT_ROLES: ReadonlySet<string> = new Set(["reviewer", "builder", "planner", "plan-reviewer"]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lanes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position REAL NOT NULL,
  fixed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  lane_id TEXT NOT NULL REFERENCES lanes (id),
  project TEXT NOT NULL DEFAULT '',
  parent_id TEXT REFERENCES tasks (id),
  position REAL NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_lane_order ON tasks (lane_id, position);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks (parent_id);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES tasks (id),
  kind TEXT NOT NULL DEFAULT 'plan',
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS attachments_card_kind_version ON attachments (card_id, kind, version);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES tasks (id),
  author TEXT NOT NULL DEFAULT 'user',
  kind TEXT NOT NULL DEFAULT 'comment',
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_card ON comments (card_id, created_at);
CREATE TABLE IF NOT EXISTS agent_configs (
  role TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_leases (
  task_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  boot_id INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS board_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const DEFAULT_LANES: Array<Omit<Lane, "position">> = [
  { id: "backlog", name: "Backlog", description: "Waiting work, nothing started", fixed: 1 },
  { id: "plan", name: "Plan", description: "Scoping and design before code", fixed: 0 },
  { id: "implement", name: "Test + Implement", description: "Build it, test as you go", fixed: 0 },
  { id: "review", name: "Review", description: "Verify, polish, get sign-off", fixed: 0 },
  { id: "done", name: "Done", description: "Finished", fixed: 1 },
  { id: "archive", name: "Archive", description: "Kept out of the way", fixed: 1 },
];

/** Lane priority for "what's next": Review → Test + Implement → Plan → Backlog (skill contract). */
export const NEXT_LANE_PRIORITY = ["review", "implement", "plan", "backlog"] as const;

export function defaultDbPath(): string {
  return process.env.KANBAN_DB ?? join(import.meta.dir, "..", "data", "kanban.db");
}

interface LaneRow {
  id: string;
  name: string;
  description: string;
  position: number;
  fixed: number;
}

interface TaskRow {
  id: string;
  title: string;
  note: string;
  lane_id: string;
  project: string;
  parent_id: string | null;
  position: number;
  created_at: number;
  updated_at: number;
}

interface AttachmentRow {
  id: string;
  card_id: string;
  kind: string;
  version: number;
  content: string;
  source: string;
  created_at: number;
}

interface CommentRow {
  id: string;
  card_id: string;
  author: string;
  kind: string;
  body: string;
  created_at: number;
}

const rowToLane = (r: LaneRow): Lane => ({ ...r });
const rowToTask = (r: TaskRow): Task => ({
  id: r.id,
  title: r.title,
  note: r.note,
  laneId: r.lane_id,
  project: r.project,
  parentId: r.parent_id,
  position: r.position,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const rowToAttachment = (r: AttachmentRow): Attachment => ({
  id: r.id,
  taskId: r.card_id,
  kind: r.kind,
  version: r.version,
  content: r.content,
  source: r.source,
  createdAt: r.created_at,
});

const rowToComment = (r: CommentRow): Comment => ({
  id: r.id,
  taskId: r.card_id,
  author: r.author,
  kind: r.kind as CommentKind,
  body: r.body,
  createdAt: r.created_at,
});

/**
 * The waiting state a card's *last* comment implies, mirroring the loop's
 * `roleFor` semantics: question kind → asking; session-death prefix → dead;
 * reviewer pass verdict → gate; reviewer cap comment → capped; any other reviewer
 * comment (failed session, cannot evaluate) → rerun; everything else (no comments,
 * block verdicts, handoffs, human/planner comments) → null — an agent turn is coming
 * or nothing is owed.
 */
export function waitingFromLastComment(last: Pick<Comment, "author" | "kind" | "body">): WaitingState | null {
  if (last.kind === "question") return "question";
  if (last.kind === "comment" && last.body.startsWith(KanbanDb.SESSION_DIED_PREFIX)) return "dead";
  if (last.author !== PLAN_REVIEWER_AUTHOR) return null;
  if (last.kind === "review" && last.body.startsWith(KanbanDb.PLAN_REVIEW_PASS)) return "gate";
  if (last.kind === "comment") {
    if (last.body.startsWith(KanbanDb.PLAN_REVIEW_CAP)) return "capped";
    return "rerun";
  }
  return null;
}

export class KanbanDb {
  private db: Database;
  private stmts = new Map<string, ReturnType<Database["prepare"]>>();

  constructor(path: string = defaultDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.ensureParentColumn();
    this.db.exec(SCHEMA);
    this.seedLanes();
    this.ensureArchiveLane();
    this.migratePlansTable();
  }

  private watchers = new Set<() => void>();

  close(): void {
    for (const stop of this.watchers) stop();
    this.watchers.clear();
    this.db.close();
  }

  /**
   * Fire `cb` when another process writes the DB — PRAGMA data_version only
   * changes on commits from other connections, so same-connection writes
   * (the API's own routes) don't fire it. Returns a stopper.
   */
  watch(cb: () => void, intervalMs = 300): () => void {
    let version = (this.q("PRAGMA data_version").get() as { data_version: number }).data_version;
    const timer = setInterval(() => {
      const current = (this.q("PRAGMA data_version").get() as { data_version: number }).data_version;
      if (current !== version) {
        version = current;
        cb();
      }
    }, intervalMs);
    timer.unref();
    const stop = () => {
      clearInterval(timer);
      this.watchers.delete(stop);
    };
    this.watchers.add(stop); // close() stops the pollers so a closed db can't throw later
    return stop;
  }

  private q(sql: string): ReturnType<Database["prepare"]> {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private seedLanes(): void {
    const count = this.q("SELECT COUNT(*) AS n FROM lanes").get() as { n: number };
    if (count.n > 0) return;
    const insert = this.q("INSERT INTO lanes (id, name, description, position, fixed) VALUES (?, ?, ?, ?, ?)");
    DEFAULT_LANES.forEach((lane, i) => insert.run(lane.id, lane.name, lane.description, (i + 1) * GAP, lane.fixed));
  }

  // boards created before task hierarchy existed need the column added once;
  // runs before exec(SCHEMA) so the tasks_parent index never sees a missing column
  private ensureParentColumn(): void {
    const table = this.q("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get() as
      | { name: string }
      | null;
    if (!table) return; // fresh db: SCHEMA creates the table with the column
    const cols = this.q("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (cols.some((col) => col.name === "parent_id")) return;
    this.db.exec("ALTER TABLE tasks ADD COLUMN parent_id TEXT REFERENCES tasks (id)");
  }

  // boards created before the archive lane existed need it appended once
  private ensureArchiveLane(): void {
    const row = this.q("SELECT COUNT(*) AS n FROM lanes WHERE id = 'archive'").get() as { n: number };
    if (row.n > 0) return;
    const last = this.q("SELECT MAX(position) AS p FROM lanes").get() as { p: number | null };
    this.q("INSERT INTO lanes (id, name, description, position, fixed) VALUES (?, ?, ?, ?, ?)").run(
      "archive",
      "Archive",
      "Kept out of the way",
      (last.p ?? 0) + GAP,
      1,
    );
  }

  // one dev database carried a hand-made `plans` prototype table; fold its rows
  // into attachments (keeping ids and versions) and drop it
  private migratePlansTable(): void {
    const table = this.q("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plans'").get() as
      | { name: string }
      | null;
    if (!table) return;
    this.q(
      `INSERT OR IGNORE INTO attachments (id, card_id, kind, version, content, source, created_at)
       SELECT id, task_id, 'plan', version, content, source, created_at FROM plans`,
    ).run();
    this.db.exec("DROP TABLE plans");
  }

  // ---------- reads ----------

  lanes(): Lane[] {
    return (this.q("SELECT * FROM lanes ORDER BY position, id").all() as LaneRow[]).map(rowToLane);
  }

  tasks(): Task[] {
    return (this.q("SELECT * FROM tasks ORDER BY created_at, id").all() as TaskRow[]).map(rowToTask);
  }

  /**
   * The skill's "what's next" card: first lane in NEXT_LANE_PRIORITY present on the
   * board that holds a (project-matching) task; within it the smallest (created_at, id).
   */
  nextTask(project?: string): Task | null {
    const present = new Set(this.lanes().map((l) => l.id));
    for (const laneId of NEXT_LANE_PRIORITY) {
      if (!present.has(laneId)) continue;
      const row = (
        project !== undefined
          ? this.q("SELECT * FROM tasks WHERE lane_id = ? AND project = ? ORDER BY created_at, id LIMIT 1").get(
              laneId,
              project,
            )
          : this.q("SELECT * FROM tasks WHERE lane_id = ? ORDER BY created_at, id LIMIT 1").get(laneId)
      ) as TaskRow | null;
      if (row) return rowToTask(row);
    }
    return null;
  }

  board(): Board {
    const laneOrder = new Map(this.lanes().map((l, i) => [l.id, i]));
    const tasks = this.tasks().sort(
      (a, b) => (laneOrder.get(a.laneId) ?? 0) - (laneOrder.get(b.laneId) ?? 0) || a.position - b.position,
    );
    return { lanes: this.lanes(), tasks, plans: this.latestPlans(), waiting: this.waitingStates() };
  }

  laneTasks(laneId: string): Task[] {
    return (
      this.q("SELECT * FROM tasks WHERE lane_id = ? ORDER BY position, created_at").all(laneId) as TaskRow[]
    ).map(rowToTask);
  }

  taskCount(laneId: string): number {
    const row = this.q("SELECT COUNT(*) AS n FROM tasks WHERE lane_id = ?").get(laneId) as { n: number };
    return row.n;
  }

  childrenOf(taskId: string): Task[] {
    return (
      this.q("SELECT * FROM tasks WHERE parent_id = ? ORDER BY position, created_at").all(taskId) as TaskRow[]
    ).map(rowToTask);
  }

  // ---------- resolution ----------

  resolveLane(ref: string): Lane {
    const lanes = this.lanes();
    const exact = lanes.find((l) => l.id === ref || l.name.toLowerCase() === ref.toLowerCase());
    if (exact) return exact;
    const byId = lanes.filter((l) => l.id.startsWith(ref.toLowerCase()));
    if (byId.length === 1) return byId[0];
    if (byId.length > 1) {
      throw new KanbanError(`ambiguous lane '${ref}': ${byId.map((l) => l.id).join(", ")}`, "conflict");
    }
    const byName = lanes.filter((l) => l.name.toLowerCase().startsWith(ref.toLowerCase()));
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      throw new KanbanError(`ambiguous lane '${ref}': ${byName.map((l) => l.name).join(", ")}`, "conflict");
    }
    if (/^\d+$/.test(ref)) {
      const n = Number(ref);
      if (n >= 1 && n <= lanes.length) return lanes[n - 1];
    }
    throw new KanbanError(`no lane matching '${ref}'`, "not-found");
  }

  resolveTask(prefix: string): Task {
    const tasks = this.tasks();
    const exact = tasks.find((t) => t.id === prefix);
    if (exact) return exact;
    const matches = tasks.filter((t) => t.id.startsWith(prefix));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new KanbanError(`ambiguous task id '${prefix}': ${matches.map((t) => t.id).join(", ")}`, "conflict");
    }
    throw new KanbanError(`no task matching '${prefix}'`, "not-found");
  }

  // ---------- task writes ----------

  createTask(input: { title: string; note?: string; lane?: string; project?: string; parent?: string | null; index?: number }): Task {
    const title = input.title.trim();
    if (!title) throw new KanbanError("title must not be empty", "invalid");
    const parent = this.resolveParent(null, input.parent);
    const lane = input.lane ? this.resolveLane(input.lane) : parent ? this.resolveLane(parent.laneId) : this.lanes()[0];
    if (!lane) throw new KanbanError("board has no lanes", "invalid");
    const now = Date.now();
    const position = this.insertPosition(lane.id, input.index, null);
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newId();
      try {
        this.q(
          "INSERT INTO tasks (id, title, note, lane_id, project, parent_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(id, title, input.note ?? "", lane.id, input.project ?? "", parent?.id ?? null, position, now, now);
        this.renormalizeIfTight(lane.id);
        return this.resolveTask(id);
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("UNIQUE"))) throw err;
      }
    }
    throw new KanbanError("could not generate a unique id", "conflict");
  }

  updateTask(prefix: string, patch: TaskPatch): Task {
    const task = this.resolveTask(prefix);
    const laneId = patch.lane ? this.resolveLane(patch.lane).id : task.laneId;
    const hasIndex = patch.index !== undefined;
    const position = patch.lane || hasIndex ? this.insertPosition(laneId, patch.index, task.id) : task.position;
    const parentId =
      patch.parent === undefined ? task.parentId : (this.resolveParent(task.id, patch.parent)?.id ?? null);

    const title = patch.title?.trim();
    if (patch.title !== undefined && !title) throw new KanbanError("title must not be empty", "invalid");

    this.q(
      `UPDATE tasks SET
        title = ?, note = ?, lane_id = ?, project = ?, parent_id = ?, position = ?, updated_at = ?
      WHERE id = ?`,
    ).run(
      title ?? task.title,
      patch.note ?? task.note,
      laneId,
      patch.project ?? task.project,
      parentId,
      position,
      Date.now(),
      task.id,
    );
    this.renormalizeIfTight(laneId);
    return this.resolveTask(task.id);
  }

  moveTask(prefix: string, laneRef: string, index?: number): Task {
    return this.updateTask(prefix, { lane: laneRef, index });
  }

  deleteTask(prefix: string, force = false): Task {
    const task = this.resolveTask(prefix);
    const ids = this.descendantIds(task.id);
    if (ids.length > 0 && !force) {
      throw new KanbanError(`task '${task.id}' has ${ids.length} descendant(s); pass force to delete them too`, "conflict");
    }
    const del = this.q("DELETE FROM tasks WHERE id = ?");
    const delAttachments = this.q("DELETE FROM attachments WHERE card_id = ?");
    const delComments = this.q("DELETE FROM comments WHERE card_id = ?");
    for (const id of [task.id, ...ids]) {
      del.run(id);
      delAttachments.run(id);
      delComments.run(id);
    }
    return task;
  }

  // ---------- hierarchy ----------

  /**
   * Resolve and validate a parent for `taskId` (null for a fresh task); returns the
   * parent task, or null to detach. Enforces epic → story → subtask via
   * depth(parent) + 1 + subtreeHeight(task) ≤ 2, which also rejects self/cycle links.
   */
  private resolveParent(taskId: string | null, ref: string | null | undefined): Task | null {
    if (ref === null || ref === undefined || ref === "") return null;
    const parent = this.resolveTask(ref);
    if (taskId && parent.id === taskId) throw new KanbanError("a task cannot be its own parent", "invalid");
    const parentDepth = this.ancestorDepth(parent.id, taskId ?? undefined);
    const height = taskId ? this.subtreeHeight(taskId) : 0;
    if (parentDepth + 1 + height > 2) {
      throw new KanbanError("hierarchy is limited to epic → story → subtask", "invalid");
    }
    return parent;
  }

  /** Depth of `taskId` below its root; throws if `stopAt` shows up (would cycle). */
  private ancestorDepth(taskId: string, stopAt?: string): number {
    const seen = new Set<string>([taskId]);
    const parentOf = this.q("SELECT parent_id AS p FROM tasks WHERE id = ?");
    let depth = 0;
    let cur: string | null = taskId;
    for (;;) {
      const next: string | null = cur ? ((parentOf.get(cur) as { p: string | null } | null)?.p ?? null) : null;
      if (next === null) return depth;
      if (stopAt && next === stopAt) throw new KanbanError("cannot attach a task under its own descendant", "invalid");
      if (!seen.add(next)) throw new KanbanError(`parent cycle detected at '${next}'`, "conflict");
      depth++;
      cur = next;
    }
  }

  /** Longest chain below `taskId` (0 = leaf). */
  private subtreeHeight(taskId: string): number {
    const children = this.childrenOf(taskId);
    if (children.length === 0) return 0;
    return 1 + Math.max(...children.map((c) => this.subtreeHeight(c.id)));
  }

  /** All descendant ids of a task (children, grandchildren, …), breadth-first. */
  private descendantIds(taskId: string): string[] {
    const out: string[] = [];
    const queue = [taskId];
    while (queue.length > 0) {
      for (const child of this.childrenOf(queue.shift()!)) {
        out.push(child.id);
        queue.push(child.id);
      }
    }
    return out;
  }

  // ---------- attachments ----------

  /** Attach `content` as the next version of `kind` on a card; returns the stored row. */
  attach(taskRef: string, kind: string, content: string, source = ""): Attachment {
    const task = this.resolveTask(taskRef);
    if (!content.trim()) throw new KanbanError("attachment content must not be empty", "invalid");
    for (let attempt = 0; attempt < 5; attempt++) {
      const version =
        (
          this.q("SELECT MAX(version) AS v FROM attachments WHERE card_id = ? AND kind = ?").get(task.id, kind) as {
            v: number | null;
          }
        ).v ?? 0;
      try {
        this.q(
          "INSERT INTO attachments (id, card_id, kind, version, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(newId(), task.id, kind, version + 1, content, source, Date.now());
        return this.attachment(task.id, kind)!;
      } catch (err) {
        // two connections can pick the same (card, kind, version); recompute with a fresh id
        if (!(err instanceof Error && err.message.includes("UNIQUE"))) throw err;
      }
    }
    throw new KanbanError("could not attach without a version collision", "conflict");
  }

  /** Latest attachment of `kind` on a card, or null. */
  attachment(taskId: string, kind: string): Attachment | null {
    const row = this.q(
      "SELECT * FROM attachments WHERE card_id = ? AND kind = ? ORDER BY version DESC LIMIT 1",
    ).get(taskId, kind) as AttachmentRow | null;
    return row ? rowToAttachment(row) : null;
  }

  /** Every version of `kind` on a card, oldest first — e.g. the session-log history. */
  attachments(taskRef: string, kind: string): Attachment[] {
    const task = this.resolveTask(taskRef);
    return (
      this.q("SELECT * FROM attachments WHERE card_id = ? AND kind = ? ORDER BY version ASC").all(task.id, kind) as
        AttachmentRow[]
    ).map(rowToAttachment);
  }

  latestPlan(taskRef: string): Attachment | null {
    return this.attachment(this.resolveTask(taskRef).id, "plan");
  }

  /** Latest plan per card, keyed by task id — the shape the board payload ships. */
  latestPlans(): Record<string, Attachment> {
    const rows = this.q(
      `SELECT a.* FROM attachments a
       JOIN (SELECT card_id, MAX(version) AS v FROM attachments WHERE kind = 'plan' GROUP BY card_id) m
         ON a.card_id = m.card_id AND a.version = m.v
       WHERE a.kind = 'plan'`,
    ).all() as AttachmentRow[];
    return Object.fromEntries(rows.map((r) => [r.card_id, rowToAttachment(r)]));
  }

  // ---------- waiting state ----------

  /** Why this card waits on the human; null unless it is a Plan-lane card or has a dead session. */
  waiting(taskRef: string): WaitingState | null {
    const task = this.resolveTask(taskRef);
    const last = this.comments(task.id).at(-1);
    const state = last ? waitingFromLastComment(last) : null;
    return task.laneId === "plan" || state === "dead" ? state : null;
  }

  /** Waiting state per card (non-null only, plan lane or dead session), keyed by task id — the shape the board payload ships. */
  waitingStates(): Record<string, WaitingState> {
    // MAX(rowid) picks the last-posted comment per card — comments are append-only
    const rows = this.q(
      `SELECT t.id AS task_id, t.lane_id, c.author, c.kind, c.body
       FROM tasks t
       JOIN (SELECT card_id, MAX(rowid) AS rid FROM comments GROUP BY card_id) m
         ON m.card_id = t.id
       JOIN comments c ON c.rowid = m.rid`,
    ).all() as Array<{ task_id: string; lane_id: string; author: string; kind: string; body: string }>;
    const out: Record<string, WaitingState> = {};
    for (const r of rows) {
      const state = waitingFromLastComment({ author: r.author, kind: r.kind as CommentKind, body: r.body });
      if (state && (r.lane_id === "plan" || state === "dead")) out[r.task_id] = state;
    }
    return out;
  }

  // ---------- comments ----------

  /** Append to a card's thread; kind and author are normalized here so every writer agrees. */
  createComment(taskRef: string, input: { author?: string; kind?: string; body: string }): Comment {
    const task = this.resolveTask(taskRef);
    const body = input.body.trim();
    if (!body) throw new KanbanError("comment body must not be empty", "invalid");
    const kind = input.kind ?? "comment";
    if (!COMMENT_KINDS.has(kind)) {
      throw new KanbanError(`unknown comment kind '${kind}' (comment | review | handoff | approval | rejection | question)`, "invalid");
    }
    const author = input.author?.trim() || "user";
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newId();
      try {
        this.q("INSERT INTO comments (id, card_id, author, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
          id,
          task.id,
          author,
          kind,
          body,
          Date.now(),
        );
        return rowToComment(this.q("SELECT * FROM comments WHERE id = ?").get(id) as CommentRow);
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("UNIQUE"))) throw err;
      }
    }
    throw new KanbanError("could not generate a unique id", "conflict");
  }

  /** A card's thread, oldest first (rowid keeps same-millisecond posts in order). */
  comments(taskRef: string): Comment[] {
    const task = this.resolveTask(taskRef);
    return (
      this.q("SELECT * FROM comments WHERE card_id = ? ORDER BY created_at, rowid").all(task.id) as CommentRow[]
    ).map(rowToComment);
  }

  /**
   * Atomic baton pass: lane move (plus optional review findings appended to the
   * note as checklist lines) and the thread record commit together or not at all.
   */
  handoff(
    taskRef: string,
    laneRef: string,
    input: { author?: string; kind?: string; message: string; findings?: string[] },
  ): { task: Task; comment: Comment } {
    const task = this.resolveTask(taskRef);
    const kind = input.kind ?? "handoff";
    const findings = (input.findings ?? []).map((f) => f.trim()).filter(Boolean);
    return this.db.transaction((): { task: Task; comment: Comment } => {
      const note = findings.length > 0 ? `${task.note}\n${findings.map((f) => `- [ ] ${f}`).join("\n")}` : undefined;
      const moved = this.updateTask(task.id, { ...(note !== undefined ? { note } : {}), lane: laneRef });
      const comment = this.createComment(task.id, { author: input.author, kind, body: input.message });
      return { task: moved, comment };
    })();
  }

  /** The plan gate: approve the card's attached plan — comment + move to Implement, atomically. */
  approveTask(taskRef: string, input: { author?: string; message?: string } = {}): { task: Task; comment: Comment } {
    const task = this.resolveTask(taskRef);
    if (task.laneId !== "plan") {
      throw new KanbanError(`card '${task.id}' is not in the plan lane (it is in '${task.laneId}')`, "conflict");
    }
    const plan = this.attachment(task.id, "plan");
    if (!plan) throw new KanbanError(`card '${task.id}' has no attached plan to approve`, "conflict");
    return this.db.transaction((): { task: Task; comment: Comment } => {
      const task2 = this.updateTask(task.id, { lane: "implement" });
      const comment = this.createComment(task.id, {
        author: input.author,
        kind: "approval",
        body: input.message?.trim() || `plan v${plan.version} approved — build it`,
      });
      return { task: task2, comment };
    })();
  }

  /** The other gate arm: reject with feedback — comment stays, card stays in Plan; the feedback steers the next plan. */
  rejectTask(taskRef: string, message: string, input: { author?: string } = {}): Comment {
    const task = this.resolveTask(taskRef);
    if (task.laneId !== "plan") {
      throw new KanbanError(`card '${task.id}' is not in the plan lane (it is in '${task.laneId}')`, "conflict");
    }
    const body = message.trim();
    if (!body) throw new KanbanError("rejection feedback must not be empty — it steers the next plan", "invalid");
    return this.createComment(task.id, { author: input.author, kind: "rejection", body: `plan rejected: ${body}` });
  }

  /** Plan-review verdict prefixes — the autoreview loop arms on these exact strings. */
  static readonly PLAN_REVIEW_PASS = "plan review: pass";
  static readonly PLAN_REVIEW_BLOCK = "plan review: block";
  /** Prefix of the plan-review cap comment body — autoreview builds its body from this. */
  static readonly PLAN_REVIEW_CAP = "plan review cap reached";
  /** Prefix of agent session-death failure comments — board waiting state keys on this. */
  static readonly SESSION_DIED_PREFIX = "session died: ";

  /** The plan reviewer's verdict: pass leaves the card at the human gate, block sends it back to the planner. Never moves the card. */
  planReview(
    taskRef: string,
    input: { verdict: "pass" | "block"; message?: string; findings?: string[]; author?: string },
  ): Comment {
    const task = this.resolveTask(taskRef);
    if (task.laneId !== "plan") {
      throw new KanbanError(`card '${task.id}' is not in the plan lane (it is in '${task.laneId}')`, "conflict");
    }
    if (!this.attachment(task.id, "plan")) throw new KanbanError(`card '${task.id}' has no attached plan to review`, "conflict");
    const message = input.message?.trim() ?? "";
    const findings = (input.findings ?? []).map((f) => f.trim()).filter(Boolean);
    if (!message && (input.verdict === "pass" || findings.length === 0)) {
      throw new KanbanError("plan review needs a message (block: message or findings)", "invalid");
    }
    const prefix = input.verdict === "pass" ? KanbanDb.PLAN_REVIEW_PASS : KanbanDb.PLAN_REVIEW_BLOCK;
    const body = `${prefix}${message ? ` — ${message}` : ""}${findings.map((f) => `\n- ${f}`).join("")}`;
    return this.createComment(task.id, { author: input.author, kind: "review", body });
  }

  // ---------- agent configs ----------

  /** The stored agent config for a role, or null when never set. */
  agentConfig(role: string): AgentConfig | null {
    const row = this.q("SELECT config FROM agent_configs WHERE role = ?").get(role) as { config: string } | null;
    return row ? (JSON.parse(row.config) as AgentConfig) : null;
  }

  // ---------- board state ----------

  /** True when agent sessions are paused: every auto-agent loop (any process) must refuse to spawn until cleared. */
  agentsPaused(): boolean {
    const row = this.q("SELECT value FROM board_state WHERE key = 'agents_paused'").get() as { value: string } | undefined;
    return row?.value === "1";
  }

  setAgentsPaused(paused: boolean): boolean {
    this.q(
      "INSERT INTO board_state (key, value) VALUES ('agents_paused', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(paused ? "1" : "0");
    return this.agentsPaused();
  }

  // ---------- agent session leases ----------
  // One agent works a card at a time — across every server process. A loop takes
  // the lease before spawning and releases it when the session ends; a lease
  // whose heartbeat went stale (owner killed hard, no graceful release) is
  // reclaimable by any other process.

  tryTakeLease(taskId: string, role: string, owner: LeaseOwner, staleAfterMs: number): boolean {
    const now = Date.now();
    return this.db.transaction((): boolean => {
      const row = this.q("SELECT heartbeat_at FROM agent_leases WHERE task_id = ?").get(taskId) as
        | { heartbeat_at: number }
        | undefined;
      if (row && now - row.heartbeat_at < staleAfterMs) return false; // a live owner holds it
      this.q(
        "INSERT OR REPLACE INTO agent_leases (task_id, role, owner_pid, boot_id, heartbeat_at) VALUES (?, ?, ?, ?, ?)",
      ).run(taskId, role, owner.pid, owner.bootId, now);
      return true;
    })();
  }

  heartbeatLease(taskId: string, owner: LeaseOwner): void {
    this.q(
      "UPDATE agent_leases SET heartbeat_at = ? WHERE task_id = ? AND owner_pid = ? AND boot_id = ?",
    ).run(Date.now(), taskId, owner.pid, owner.bootId);
  }

  releaseLease(taskId: string, owner: LeaseOwner): void {
    this.q("DELETE FROM agent_leases WHERE task_id = ? AND owner_pid = ? AND boot_id = ?").run(
      taskId,
      owner.pid,
      owner.bootId,
    );
  }

  releaseLeases(owner: LeaseOwner): void {
    this.q("DELETE FROM agent_leases WHERE owner_pid = ? AND boot_id = ?").run(owner.pid, owner.bootId);
  }

  leaseFor(taskId: string, staleAfterMs?: number): AgentLease | null {
    const row = this.q("SELECT * FROM agent_leases WHERE task_id = ?").get(taskId) as
      | { task_id: string; role: string; owner_pid: number; boot_id: number; heartbeat_at: number }
      | undefined;
    if (!row) return null;
    if (staleAfterMs !== undefined && Date.now() - row.heartbeat_at >= staleAfterMs) return null;
    return {
      taskId: row.task_id,
      role: row.role,
      ownerPid: row.owner_pid,
      bootId: row.boot_id,
      heartbeatAt: row.heartbeat_at,
    };
  }

  /** Full replace of a role's config; empty strings/arrays drop out. */
  setAgentConfig(role: string, config: AgentConfig): AgentConfig {
    if (!AGENT_ROLES.has(role)) {
      throw new KanbanError(`unknown agent role '${role}' (reviewer | builder | planner | plan-reviewer)`, "invalid");
    }
    const clean: AgentConfig = {};
    if (config.provider?.trim()) clean.provider = config.provider.trim();
    if (config.model?.trim()) clean.model = config.model.trim();
    if (config.thinking) clean.thinking = config.thinking;
    const skills = (config.skills ?? []).map((s) => s.trim()).filter(Boolean);
    if (skills.length > 0) clean.skills = skills;
    if (config.context?.trim()) clean.context = config.context.trim();
    if (config.tools?.trim()) clean.tools = config.tools.trim();
    const extraArgs = (config.extraArgs ?? []).map((a) => a.trim()).filter(Boolean);
    if (extraArgs.length > 0) clean.extraArgs = extraArgs;
    if (config.timeoutMs !== undefined) clean.timeoutMs = config.timeoutMs;
    this.q(
      `INSERT INTO agent_configs (role, config, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(role) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
    ).run(role, JSON.stringify(clean), Date.now());
    return this.agentConfig(role)!;
  }

  // ---------- lane writes ----------

  createLane(input: { name: string; description?: string; index?: number }): Lane {
    const name = input.name.trim();
    if (!name) throw new KanbanError("lane name must not be empty", "invalid");
    let id = slugify(name);
    const existing = new Set(this.lanes().map((l) => l.id));
    for (let n = 2; existing.has(id); n++) id = `${slugify(name)}-${n}`;
    const lanes = this.lanes();
    let position: number;
    if (input.index === undefined || input.index >= lanes.length) {
      position = (lanes.at(-1)?.position ?? 0) + GAP;
    } else {
      const clamped = Math.max(0, Math.floor(input.index));
      const before = lanes[clamped];
      position = clamped === 0 ? before.position / 2 : (lanes[clamped - 1].position + before.position) / 2;
    }
    this.q("INSERT INTO lanes (id, name, description, position, fixed) VALUES (?, ?, ?, ?, 0)").run(
      id,
      name,
      input.description ?? "",
      position,
    );
    return this.lanes().find((l) => l.id === id)!;
  }

  updateLane(prefix: string, patch: LanePatch): Lane {
    const lane = this.resolveLane(prefix);
    const name = patch.name?.trim();
    if (patch.name !== undefined && !name) throw new KanbanError("lane name must not be empty", "invalid");
    if (patch.index === undefined) {
      this.q("UPDATE lanes SET name = ?, description = ? WHERE id = ?").run(
        name ?? lane.name,
        patch.description ?? lane.description,
        lane.id,
      );
    } else {
      const lanes = this.lanes().filter((l) => l.id !== lane.id);
      const clamped = Math.max(0, Math.min(Math.floor(patch.index), lanes.length));
      const position =
        clamped === 0
          ? (lanes[0]?.position ?? 0) / 2
          : clamped >= lanes.length
            ? (lanes.at(-1)?.position ?? 0) + GAP
            : (lanes[clamped - 1].position + lanes[clamped].position) / 2;
      this.q("UPDATE lanes SET name = ?, description = ?, position = ? WHERE id = ?").run(
        name ?? lane.name,
        patch.description ?? lane.description,
        position,
        lane.id,
      );
    }
    return this.resolveLane(lane.id);
  }

  deleteLane(prefix: string, force = false): Lane {
    const lane = this.resolveLane(prefix);
    if (lane.fixed) throw new KanbanError(`lane '${lane.id}' is fixed and cannot be deleted`, "conflict");
    const count = this.taskCount(lane.id);
    if (count > 0) {
      if (!force) throw new KanbanError(`lane '${lane.id}' still holds ${count} task(s); pass force to delete them too`, "conflict");
      // delete whole subtrees so no task elsewhere keeps a dangling parent
      const del = this.q("DELETE FROM tasks WHERE id = ?");
      const delAttachments = this.q("DELETE FROM attachments WHERE card_id = ?");
      const delComments = this.q("DELETE FROM comments WHERE card_id = ?");
      for (const t of this.laneTasks(lane.id)) {
        for (const id of [t.id, ...this.descendantIds(t.id)]) {
          del.run(id);
          delAttachments.run(id);
          delComments.run(id);
        }
      }
    }
    this.q("DELETE FROM lanes WHERE id = ?").run(lane.id);
    return lane;
  }

  // ---------- ordering ----------

  /** Fractional position for inserting at `index` within a lane (append if undefined). */
  private insertPosition(laneId: string, index: number | undefined, excludeTaskId: string | null): number {
    const tasks = this.laneTasks(laneId).filter((t) => t.id !== excludeTaskId);
    if (tasks.length === 0 || index === undefined || index >= tasks.length) {
      return (tasks.at(-1)?.position ?? 0) + GAP;
    }
    const clamped = Math.max(0, Math.floor(index));
    if (clamped === 0) return tasks[0].position / 2;
    return (tasks[clamped - 1].position + tasks[clamped].position) / 2;
  }

  /** Rewrite a lane's positions as 100/200/... when midpoint halving gets too tight. */
  private renormalizeIfTight(laneId: string): void {
    const tasks = this.laneTasks(laneId);
    let tight = false;
    for (let i = 1; i < tasks.length; i++) {
      if (tasks[i].position - tasks[i - 1].position < MIN_GAP) {
        tight = true;
        break;
      }
    }
    if (!tight) return;
    const update = this.q("UPDATE tasks SET position = ? WHERE id = ?");
    tasks.forEach((t, i) => update.run((i + 1) * GAP, t.id));
  }
}
