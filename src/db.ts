import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
  /** Max cards this lane may hold (advisory warn); null = unlimited. */
  wipLimit: number | null;
}

export interface Task {
  id: string;
  title: string;
  note: string;
  laneId: string;
  project: string;
  tags: string[];
  parentId: string | null;
  previousLane: string | null;
  workspace: string | null;
  owner: string | null;
  priority: Priority;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface Attachment {
  id: string;
  taskId: string;
  kind: string; // the file name slot — "plan"/"session" are reserved, any other matching FILE_NAME_RE is a card file
  version: number;
  content: string;
  source: string; // path the content was read from, informational only
  createdAt: number;
}

/**
 * Card-file names: lowercase kebab, up to 48 base chars, optional short extension (`design`, `repro-log-2.txt`).
 * `plan` is the gate slot — writable through the normal attach path, just never invented ad hoc.
 * `session` is written by the auto-review loop only and is rejected at the CLI/HTTP attach surface.
 */
export const FILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}(\.[a-z0-9]{1,8})?$/;
export const RESERVED_FILE_NAMES = new Set(["session"]);

export type CommentKind = "comment" | "review" | "handoff" | "approval" | "rejection" | "question";

/** Why a Plan-lane card (or any-lane dead-session card) is waiting on the human (from its thread's last comment). */
export type WaitingState = "gate" | "question" | "rerun" | "capped" | "dead";

/** Author of plan-review verdicts/failure comments — shared by the loop and the waiting classifier. */
export const PLAN_REVIEWER_AUTHOR = "pi-plan-reviewer";

/** The five built-in loop roles; lane actors may add custom ids (see LaneActor). */
export type BuiltinAgentRole = "reviewer" | "builder" | "planner" | "plan-reviewer" | "elaborator";

/** A loop role: built-in, or any custom lane-actor id (string & {} keeps literal autocomplete). */
export type AgentRole = BuiltinAgentRole | (string & {});

export type AgentThinking = "" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Which headless harness an engine spawns: pi (`pi --mode json`) or Claude Code (`claude -p`). */
export type HarnessId = "pi" | "claude";

/** The `--effort` levels Claude Code accepts; a claude engine's `thinking` is one of these. */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * A named, coherent run target — the only home of model config (card: engines).
 * pi engines carry provider/model/thinking; claude engines carry a model alias
 * and an optional effort level in `thinking` (CLAUDE_EFFORT_LEVELS, passed as
 * `--effort`); claude resolves its own auth. `seats` caps concurrent
 * sessions on this engine; `flags` are raw harness flags.
 */
export interface Engine {
  id: string;
  name: string;
  harness: HarnessId;
  provider?: string;
  model?: string;
  thinking?: AgentThinking;
  flags: string[];
  seats: number;
  enabled: boolean;
  updatedAt: number;
}

export type EngineInput = Omit<Engine, "id" | "updatedAt" | "flags" | "seats" | "enabled"> & {
  flags?: string[];
  seats?: number;
  enabled?: boolean;
};

export const MAX_ENGINE_SEATS = 12;

/**
 * Per-actor agent behavior for the auto-agent loop; stored as one JSON blob per role.
 * Which model runs is never here: `runsOn` is the actor's engine lineup (first
 * available engine wins, the rest are fallbacks; empty = board default engine).
 */
export interface AgentConfig {
  runsOn?: string[]; // engine ids, in preference order
  skills?: string[]; // paths passed to pi as --skill
  context?: string; // passed as --append-system-prompt
  tools?: string;
  extraArgs?: string[]; // raw pi flags (pi engines only — claude engines carry their own flags)
  timeoutMs?: number;
}

/** Pre-engines model fields, read only by the one-time fold (migrateEngines). */
interface LegacyModelFields {
  provider?: string;
  model?: string;
  thinking?: AgentThinking;
}

/** One agent on a lane's workflow chain (card 3n96c): its author, prompt, and settings. */
export interface LaneActor {
  /** Role/actor key (e.g. "planner", "plan-reviewer", "builder", "reviewer", "designer"). */
  id: string;
  /** Thread comment author (must start with "pi-", e.g. "pi-planner", "pi-designer"). */
  author: string;
  /** Prompt template supporting {id}, {title}, {tmpFile}, {template} placeholders. */
  instructions: string;
  /** Optional alternate instructions used when triggered by a human approval comment (Implement's plan-build mode). */
  approvalInstructions?: string;
  /** Optional clause appended to step 2 of resumePrompt ({id} interpolated). */
  resumeEnding?: string;
  /** Optional label + hint for session-death comments. */
  deathLabel?: string;
  deathHint?: string;
  /** Per-actor agent configuration (engine lineup `runsOn`, skills, context, tools, extraArgs, timeoutMs). */
  config?: AgentConfig;
}

/** When a lane's agent arms: card enters lane, last comment is human, or a specific comment matches. */
export type LaneTriggerRule =
  | { kind: "on-enter" }
  | { kind: "human-comment" }
  | { kind: "comment"; commentKind?: CommentKind; author?: string; prefix?: string; targetActor?: string };

/** What a verdict comment does: arm the next actor, re-run the first, move/park the card, or disarm. */
export interface LaneExitRule {
  on: {
    author?: string;
    kind?: CommentKind;
    prefix?: string;
  };
  action: "next-actor" | "rerun-first" | "move" | "park" | "disarm";
  /** Target lane id (for action === "move") or target actor id (for "next-actor" / "rerun-first"). */
  target?: string;
}

/** The human-only gate on a lane: approve/reject targets and requirements (agents never run it). */
export interface LaneGateRule {
  /** Target lane id when approved (`kanban approve <id>`). */
  approveTarget: string;
  /** Optional owner set on the card when approved (e.g. "pi-builder"). */
  approveOwner?: string;
  /** Optional attachment kind required before approve succeeds (e.g. "plan", "design"). */
  requireArtifact?: string;
  /** Optional prefix for rejection comments (default: "<requireArtifact ?? artifact ?? laneId> rejected"). */
  rejectPrefix?: string;
}

/** Max auto-cycles before the lane parks its card for a human (one-shot question comment). */
export interface LaneCapRule {
  /** Maximum block/rerun cycles before parking in Waiting on you. */
  max: number;
  /** "since-human" counts matches after the last non-pi-* comment; "thread" counts across the full thread. */
  scope: "since-human" | "thread";
  match: {
    author?: string;
    kind?: CommentKind;
    prefix?: string;
  };
  /** Author of the one-shot cap question comment (must start with "pi-"). */
  author: string;
  /** Cap question comment body template ({id} and {max} interpolated). */
  message: string;
}

/**
 * The workflow a lane hosts (card 3n96c): an ordered actor chain with prompt
 * instructions, an optional artifact template, and the declarative
 * trigger/exit/gate/cap rules the generic loop interprets. Null/absent = a
 * plain lane the loop ignores. Plan/Implement/Review seed contexts reproducing
 * the pre-context pipeline exactly (defaultLaneContext).
 */
export interface LaneContext {
  /** Optional artifact attachment name (must match FILE_NAME_RE when set, e.g. "plan", "design"). */
  artifact?: string;
  /** Optional markdown template embedded in actor prompts. */
  template?: string;
  /** Ordered chain of 1–4 actors on this lane. */
  actors: LaneActor[];
  /** Trigger rules (at least 1). */
  triggers: LaneTriggerRule[];
  /** Optional exit/transition rules evaluated against the latest non-elaborator comment. */
  exits?: LaneExitRule[];
  /** Optional human-only gate (approve/reject). */
  gate?: LaneGateRule;
  /** Optional auto-cycle cap. */
  cap?: LaneCapRule;
  /** When true, run the pre-spawn `bun test` gate before spawning an actor on this lane. */
  testGate?: boolean;
}

/** Pre-engines worker pool blob (worker_pools rows stay as an inert backup after the fold). */
interface LegacyPool {
  enabled?: boolean;
  roles?: string[];
  slots?: LegacyModelFields[];
  maxWorkers?: number;
}

/** One dispatch of a lane worker — queued by CLI/manager, drained by the serve-process runner (lane-workers.ts). */
export interface LaneWorkerRun {
  id: string;
  laneId: string;
  status: "queued" | "running" | "done" | "failed";
  focus?: string;
  sessionId?: string;
  summary?: string;
  exitInfo?: string;
  log?: string;
  requestedBy: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
}

/** One card row of a lane snapshot: what a lane worker starts from instead of unbounded reads. */
export interface LaneSnapshotCard {
  id: string;
  title: string;
  ageDays: number;
  priority: string;
  blocked: boolean;
}

/** A project's routing settings (the `projects` table); repoPath null = the serve launch dir. */
export interface ProjectRoute {
  name: string;
  repoPath: string | null;
  testGate: boolean;
  testCmd: string | null; // null = board default (`bun test`)
}

export interface LaneSnapshot {
  laneId: string;
  total: number;
  truncated: boolean;
  cards: LaneSnapshotCard[];
}

export interface BoardOverviewLane {
  id: string;
  name: string;
  count: number;
  oldestDays: number;
}

/** The manager's board-wide view: lane counts, aging, what's parked, what's next. */
export interface BoardOverview {
  lanes: BoardOverviewLane[];
  waiting: Array<{ id: string; title: string; ageDays: number }>;
  next: { id: string; title: string } | null;
  blocked: number;
}

export interface Comment {
  id: string;
  taskId: string;
  author: string;
  kind: CommentKind;
  body: string;
  createdAt: number;
}

/** What a card's GitHub link points at; "unknown" until the first sync resolves pr vs issue. */
export type GhLinkKind = "pr" | "issue" | "unknown";

/** One GitHub pr/issue attached to a card (card-local; the same url can sit on several cards). */
export interface GhLink {
  id: string;
  cardId: string;
  /** Canonical https://github.com/{owner}/{repo}/issues|pull/{n} (shorthand `gh:o/r#n` canonicalizes to /issues/n). */
  url: string;
  kind: GhLinkKind;
  /** '{owner}/{repo}' */
  repo: string;
  number: number;
  createdAt: number;
}

/** DB-cached live state of one GitHub url — disposable, refreshed by the gh sync (TTL). */
export interface GhStatus {
  url: string;
  kind: "pr" | "issue";
  /** gh's state string: prs OPEN|MERGED|CLOSED, issues OPEN|CLOSED. */
  state: string;
  title: string;
  /** Epoch ms of the pr's merge, null when not merged (or an issue). */
  mergedAt: number | null;
  fetchedAt: number;
  /** "" when the last fetch was ok, else the gh error tail. */
  error: string;
}

export type LaneEventCause =
  | "create"
  | "mv"
  | "edit"
  | "handoff"
  | "review"
  | "approve"
  | "done"
  | "archive"
  | "auto-archive"
  | "auto" // the epic container finishing itself (ceqfq)
  | "backfill"
  | "gh";

export interface LaneEvent {
  id: string;
  taskId: string;
  fromLaneId: string | null;
  toLaneId: string;
  cause: LaneEventCause;
  actor: string;
  createdAt: number;
}

/** A lane event as delivered on the SSE feed: cursor rowid plus the card's title (null when the card was deleted). */
export interface LaneEventFeedEntry extends LaneEvent {
  rowid: number;
  cardTitle: string;
}

export interface UndoResult {
  task: Task;
  event: LaneEvent;
}

export interface SessionStats {
  count: number;
  totalMs: number;
}

export interface CardStats {
  taskId: string;
  laneTimes: Array<{ laneId: string; ms: number }>; // board lane order; only lanes the card entered; ms may be 0
  cycleMs: number; // first done-entry − createdAt; now − createdAt when never done
  currentLaneMs: number; // now − last event's created_at
  gateWaitMs: number; // total ms in lane "plan"
  reachedDone: boolean; // ≥1 event with to_lane_id = "done"
  reviewToDoneMs: number | null; // first done-entry − latest review-entry event at/before it; null when the card never entered both
  planReviewBlocks: number; // comments kind="review", author=pi-plan-reviewer, body startsWith "plan review: block"
  reviewBlocks: number; // decision D7
  cappedHits: number; // comments body startsWith "plan review cap reached" OR "auto-review stopped: block cycles reached the cap"
  planVersions: number; // attachments kind="plan" count (re-plans = planVersions − 1)
  sessions: SessionStats; // kind="session" attachments; totalMs parsed from first line `· Ns` (regex /(\d+)s\s*$/), unparseable headers add 0
}

export interface ThroughputWeek {
  weekStart: number;
  done: number;
} // Monday 00:00 local ms

export interface LaneDwellStat {
  avgMs: number;
  cards: number;
}

export interface ProjectRow {
  project: string;
  total: number;
  active: number;
  done: number;
}

export interface BoardStats {
  wip: number; // tasks lane_id NOT IN ('done','archive')
  throughput: ThroughputWeek[]; // exactly 8 entries, oldest first, includes current week (zero weeks kept)
  laneDwell: Record<string, LaneDwellStat>; // key = lane id; only lanes ≥1 card entered; mean per-card total dwell, open segment counted to `now`; all tasks incl. archived
  projects: ProjectRow[]; // sorted by project asc, "" included; active = current lane not done/archive; done = ever entered done
  cycleAvgMs: number | null; // mean cycleMs over reachedDone cards; null when none
}

export interface BoardStatsPayload {
  board: BoardStats;
  cards: Record<string, CardStats>;
  generatedAt: number;
}

export interface Board {
  lanes: Lane[];
  tasks: Task[];
  plans: Record<string, Attachment>;
  /** Plan-lane cards waiting on the human, keyed by task id (sparse — absent key = not waiting). */
  waiting: Record<string, WaitingState>;
  /** Sparse card-id → direct blocker ids. */
  blockedBy: Record<string, string[]>;
  /** Sparse card-id → linked card ids, both directions. */
  links: Record<string, string[]>;
  /** GitHub pr/issue links per card id (sparse — only cards with links). */
  ghLinks: Record<string, GhLink[]>;
  /** Sparse lane-id → LaneContext for lanes that carry a workflow context. */
  laneContexts?: Record<string, LaneContext>;
}

/** Live implementation location of a card, joined against git — not stored. */
export interface CardWorkspace {
  branch: string; // the recorded branch, verified to exist in git
  path: string | null; // worktree path from `git worktree list`, null = branch only
}

/** GET /board response: board + sparse live workspace per card. */
export interface BoardPayload extends Board {
  workspaces: Record<string, CardWorkspace>; // absent key = no live workspace
  /** Every project name the server knows — stored routes ∪ card tags, sorted (feeds the picker, not the stats view). */
  projectNames: string[];
}

export interface TaskPatch {
  title?: string;
  note?: string;
  project?: string;
  tags?: string[]; // full replace; [] clears
  lane?: string; // lane ref: id, id prefix, name prefix, or 1-based ordinal
  parent?: string | null; // task ref to attach under; null detaches
  workspace?: string | null;
  owner?: string | null; // actor responsible for the card; null clears
  priority?: Priority;
  blockedBy?: string[];
  before?: string; // anchor task ref: insert directly before this card
  index?: number; // 0-based position within the target lane; omit to append
}

export interface LanePatch {
  name?: string;
  description?: string;
  index?: number; // 0-based position among lanes
  before?: string | null; // anchor lane ref: move directly before it; null = last
  wipLimit?: number | null; // integer 1–999 sets, null clears, undefined leaves
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

/** The auto-loop's builder author — also the owner `kanban approve` assigns. Lives here
 *  (not autoreview.ts) so the ownership rules in this file can reference it. */
export const BUILDER_AUTHOR = "pi-builder";

const COMMENT_KINDS: ReadonlySet<string> = new Set(["comment", "review", "handoff", "approval", "rejection", "question"]);
const AGENT_ROLES: ReadonlySet<string> = new Set(["reviewer", "builder", "planner", "plan-reviewer", "elaborator"]);
/** Roles storable in agent_configs: the loop roles plus the board manager and lane worker (card d26pe). */
const AGENT_CONFIG_ROLES: ReadonlySet<string> = new Set([...AGENT_ROLES, "manager", "worker"]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lanes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position REAL NOT NULL,
  fixed INTEGER NOT NULL DEFAULT 0,
  wip_limit INTEGER,
  context TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  lane_id TEXT NOT NULL REFERENCES lanes (id),
  project TEXT NOT NULL DEFAULT '',
  parent_id TEXT REFERENCES tasks (id),
  previous_lane TEXT,
  workspace TEXT,
  owner TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  priority TEXT NOT NULL DEFAULT 'normal',
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
CREATE TABLE IF NOT EXISTS blocked_by (
  card_id TEXT NOT NULL REFERENCES tasks (id),
  blocker_id TEXT NOT NULL REFERENCES tasks (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (card_id, blocker_id)
);
CREATE INDEX IF NOT EXISTS blocked_by_blocker ON blocked_by (blocker_id);
CREATE TABLE IF NOT EXISTS card_links (
  card_a TEXT NOT NULL REFERENCES tasks (id),
  card_b TEXT NOT NULL REFERENCES tasks (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (card_a, card_b),
  CHECK (card_a < card_b)
);
CREATE INDEX IF NOT EXISTS card_links_a ON card_links (card_a);
CREATE INDEX IF NOT EXISTS card_links_b ON card_links (card_b);
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
CREATE TABLE IF NOT EXISTS card_sessions (
  task_id TEXT PRIMARY KEY REFERENCES tasks (id),
  role TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS resume_requests (
  task_id TEXT PRIMARY KEY REFERENCES tasks (id),
  requested_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS elaboration_requests (
  task_id TEXT PRIMARY KEY REFERENCES tasks (id),
  requested_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS worker_pools (
  id TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS engines (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  config TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lane_workers (
  id TEXT PRIMARY KEY,
  lane_id TEXT NOT NULL,
  focus TEXT,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | failed
  session_id TEXT,
  summary TEXT,
  exit_info TEXT,
  log TEXT,
  requested_by TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS lane_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id),
  from_lane_id TEXT,             -- NULL = card entering its first lane (creation)
  to_lane_id TEXT NOT NULL,
  cause TEXT NOT NULL,           -- LaneEventCause
  actor TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lane_events_task ON lane_events (task_id, created_at);
CREATE INDEX IF NOT EXISTS lane_events_to_lane ON lane_events (to_lane_id, created_at);
CREATE TABLE IF NOT EXISTS gh_links (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES tasks (id),
  url TEXT NOT NULL,             -- canonical https://github.com/{owner}/{repo}/issues|pull/{n}
  kind TEXT NOT NULL,            -- 'pr' | 'issue' | 'unknown'
  repo TEXT NOT NULL,            -- '{owner}/{repo}'
  number INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS gh_links_card_url ON gh_links (card_id, url);
CREATE INDEX IF NOT EXISTS gh_links_url ON gh_links (url);
CREATE TABLE IF NOT EXISTS gh_state (
  url TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  merged_at INTEGER,
  fetched_at INTEGER NOT NULL,
  error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS projects (
  name TEXT PRIMARY KEY,
  repo_path TEXT,
  test_gate INTEGER NOT NULL DEFAULT 1,
  test_cmd TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_agent_configs (
  project TEXT NOT NULL,
  actor TEXT NOT NULL,
  config TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project, actor)
);
`;

export const DEFAULT_LANES: Array<Omit<Lane, "position" | "wipLimit">> = [
  { id: "waiting", name: "Waiting on you", description: "Parked for a human answer — replying returns the card", fixed: 1 },
  { id: "backlog", name: "Backlog", description: "Waiting work, nothing started", fixed: 1 },
  { id: "epics", name: "Epics", description: "Approved epics supervising their children — never worked directly", fixed: 1 },
  { id: "plan", name: "Plan", description: "Scoping and design before code", fixed: 0 },
  { id: "implement", name: "Test + Implement", description: "Build it, test as you go", fixed: 0 },
  { id: "review", name: "Review", description: "Verify, polish, get sign-off", fixed: 0 },
  { id: "done", name: "Done", description: "Finished", fixed: 1 },
  { id: "archive", name: "Archive", description: "Kept out of the way", fixed: 1 },
];

/**
 * The plan contract shared by planner and plan reviewer (card 3n96c): required
 * sections plus the review checklist. Read once and seeded into the plan lane's
 * context, so agents running in another repo (serve cwd) still get it.
 */
export const PLAN_TEMPLATE = readFileSync(join(import.meta.dir, "..", "skills", "pi-kanban", "plan-template.md"), "utf8");

/** The template's required section headings, in order (a test keeps the file in sync). */
export const PLAN_SECTIONS = [
  "Goal",
  "Context & constraints",
  "Decisions",
  "Interfaces & contracts",
  "Steps",
  "Test plan",
  "Architecture impact",
  "Stack & dependencies",
  "Data & migrations",
  "Security",
  "Performance",
  "Backward compatibility",
  "Observability",
  "Rollback",
  "Out of scope",
  "Risks",
  "Open questions",
] as const;

/**
 * The seeded actors' prompt instructions (card 3n96c): today's hardcoded prompt
 * bodies with {id} / {title} / {tmpFile} placeholders, stored on the lanes'
 * default contexts so the loop renders them via renderActorPrompt.
 */
export const PLANNER_INSTRUCTIONS = `You are pi-planner. Kanban card {id} "{title}" is in the Plan lane in this repo — write its implementation plan. The plan is the builder's contract: two builders following it should produce the same behavior. Write it lean, for a literal executor — the builder may be a smaller, faster model that follows the steps in order and makes no design choices. Every judgment call is yours and goes in the plan as an exact contract or a precise behavior; the builder writes the code and tests from it and runs the checks. Do not write the implementation yourself.

1. Run: kanban brief {id} — the note (intent, acceptance criteria), any earlier plan version, and the full thread. If the last comment is a rejection or a plan-review block, its feedback and findings are direction for this revision: address every point in v-next.
2. Ground the plan in the repo: read AGENTS.md, then the files and tests the work touches. Cite real file paths with the enclosing symbol name; no invented APIs. Ground only in the default branch (record git rev-parse --short HEAD as the verified-at commit) — never in unmerged branches. Read GLOSSARY.md if present and use its vocabulary; challenge fuzzy terms against the glossary instead of inventing synonyms, and update it inline when a term crystallizes. Run a redundancy check before planning: search the repo (rg, kanban search) for an existing implementation of the note's behavior — plan around what already exists — and cite where you looked under Context & constraints.
3. Verify cheaply, never by assuming: confirm every path, symbol, and command you cite exists by reading it (run a command only when its expected output is not clear from the code); find the guard tests that pin every file and symbol you change (search the test directories for their names) and plan the update of any the change breaks. Name the full-suite command as the baseline — the builder runs it in Step 0. Do not build the change, write its function or test bodies, or run it in a scratch checkout; if a step is risky enough that you want to, raise it as an open question instead. Read only — never edit the checkout you plan in.
4. Write the plan to a markdown file — use exactly {tmpFile} so concurrent runs never clobber each other — using the plan template below: every section filled or "N/A — reason", every acceptance criterion mapped to concrete tests, every step with Files / Do / Check / Commit, exact contracts, function bodies as behavior, and tests specified by file, name, inputs, and assertions. Stay within about 150–300 lines.
5. Self-check the plan against the review checklist below and fix every hit before attaching. Final pass: read each step as the builder would — any spot where it must choose a design, guess a contract, or look up something you already knew is a gap; fill it with a contract or a behavior, not with finished code.
6. Attach it: kanban attach {id} <plan-file>
7. Hand off with exactly: kanban comment {id} "plan v<N> attached — over to pi-plan-reviewer" --kind handoff --author pi-planner

Never move the card (no mv/handoff) and never run kanban approve/reject — the human owns the gate.
Questions first: after reading the repo, ask only if an answer would genuinely change the plan — post every question with its recommended default as one comment: kanban comment {id} "<Q1…? default: …>" --kind question --author pi-planner, then stop without attaching a plan; the human's answer re-arms you and its "use the defaults" counts as an answer. When the repo can decide, decide and record it under Decisions instead of asking. A card too big for one executable plan (more than about 12 steps, or parts that could ship independently) is a question too: propose the split as the default.
Your last line: one sentence on the plan's shape.`;

export const PLAN_REVIEWER_INSTRUCTIONS = `You are pi-plan-reviewer. Kanban card {id} "{title}" has a fresh plan in the Plan lane in this repo — critique it before the human gate. You are the second pair of eyes: assume the planner was convincing but lazy.

1. Run: kanban brief {id} — the note (acceptance criteria), the latest plan, and the full thread (rejections and earlier feedback are context).
2. Check the plan against the review checklist below, and verify its claims: every cited path exists, every named function/API matches the code (read AGENTS.md and the named files), every acceptance criterion maps to a concrete test. Read GLOSSARY.md if present and use its vocabulary; update it inline when a term crystallizes.
3. Check it is executable by a literal builder that makes no design choices: walk every step and confirm you could do it without deciding anything — exact files, anchored edits, exact contracts (signatures, schema, route shapes, flags, prompt and error text), function bodies described by inputs, outputs, and error cases, tests specified by file, name, inputs, and assertions, a Check command with its expected result, a commit line. Every place you would have to choose a design or guess a contract is a checklist hit; quote the step. Missing finished code is not a hit — the builder writes bodies from the plan; pasted implementation where a contract would do is a hit (the plan is heavy).

Then record exactly one verdict (never move the card with mv/handoff, never run kanban approve/reject — the human owns the gate):
- Pass: kanban plan-review {id} --pass --message "<1-3 sentences on why it is executable>" --author pi-plan-reviewer — parks the card in Waiting on you for the human gate
- Block: kanban plan-review {id} --block --message "<summary>" --finding "<checklist hit>" [--finding "<…>" …] --author pi-plan-reviewer

Block only for checklist hits, never taste; up to 2 rounds happen automatically, then a human steps in. If you cannot evaluate the plan at all (files missing, repo unreadable), post kanban comment {id} "cannot evaluate the plan — <why>" --author pi-plan-reviewer and stop.
Never move the card (no mv/handoff — the --pass verdict parks it in Waiting on you automatically) and never run kanban approve/reject — the human owns the gate.
Your last line: a one-sentence verdict.`;

/** The epic decomposition charter (ceqfq): what a planner writes for a card
 *  WITH children. Same pipeline (attach, plan-review, human gate) as a build
 *  plan, but the artifact decomposes instead of implements. */
export const EPIC_PLAN_TEMPLATE = `
## Goal

What this epic delivers and why it is one unit of work.

## Children & chain

One line per child card — id, title, lane — plus the dependency chain as a
--blocked-by graph (parallel bands explicit). Every child already exists as a
card (create them: kanban add … --parent {id}).

## Scope verdict

For each child: earned now (build) or deferred (stays in Backlog, named here
with its ripen-or-rot condition). Speculative work is deferred, never planned.

## Boundary contracts

Which files each child owns — disjoint sets, so parallel children cannot
collide. One block per child: child id → files + the interface it exposes to
siblings. No steps, no test plans: those belong to each child's own plan.

## Out of scope

What this epic deliberately does not touch.
`;

export const EPIC_PLANNER_INSTRUCTIONS = `You are pi-planner. Kanban card {id} "{title}" is an EPIC (it has child cards) in the Plan lane — write its decomposition charter, not an implementation plan. The epic plans work; it never builds.

1. Run: kanban brief {id} and kanban show {id} — the note, thread, and current children. If the last comment is a rejection or plan-review block, address every point.
2. Ground it in the repo: read AGENTS.md and the area the epic touches. Cite real paths. Check for existing children that already cover scope; search (rg, kanban search) before creating anything.
3. Ensure the children exist and are chained: create missing child cards with --parent {id}, set the --blocked-by chain, park deferred children in Backlog. Children are small enough that each one's OWN plan (written when it reaches Plan) can be executable.
4. Write the charter to {tmpFile} using the template below — every section filled or "N/A — reason". NO implementation steps, NO per-child test plans: if you are writing "Step 1", you are writing the wrong artifact — that content belongs to the child's plan.
5. Attach: kanban attach {id} <plan-file>
6. Hand off exactly: kanban comment {id} "plan v<N> attached — over to pi-plan-reviewer" --kind handoff --author pi-planner

Never move the card (no mv/handoff) and never run kanban approve/reject — the human owns the gate. Children are never moved out of Backlog by you — releasing waves is the human's call.
Questions only if an answer would change the decomposition; post them as one comment with recommended defaults, then stop.
Your last line: one sentence on the epic's shape (children, chain, defers).`;

export const EPIC_PLAN_REVIEWER_INSTRUCTIONS = `You are pi-plan-reviewer. Kanban card {id} "{title}" is an EPIC (it has child cards) with a fresh charter in the Plan lane — review the decomposition before the human gate.

1. Run: kanban brief {id} and kanban show {id} — the charter, thread, and the actual children.
2. Rubric — block on any hit:
   - Every child named in the charter exists (--parent set) and every existing child is accounted for (built or explicitly deferred).
   - The --blocked-by chain is complete, acyclic, and parallel bands are real (no false serializing).
   - Every child is independently buildable: its scope fits one child plan; boundaries are disjoint (no file owned by two children).
   - Scope verdict is honest: deferred items carry a ripen-or-rot condition.
   - The charter contains NO implementation steps or per-child test plans — that detail belongs to child plans. Likewise, a child plan that re-draws the decomposition is out of scope for its own card.
3. Verify cited paths exist; read AGENTS.md. GLOSSARY.md vocabulary applies.

Verdict exactly as usual (never move the card, never approve/reject — the human owns the gate): pass parks it for the human; block carries --finding per rubric hit.
Your last line: a one-sentence verdict on the decomposition.`;

/** The context an epic plans under: any lane that hands out an artifact
 *  template swaps it for the decomposition charter (ceqfq) — the seeded
 *  planner/plan-reviewer instructions swap too when the lane uses those actor
 *  ids, and everything else (custom actors, gates, exits) stays the lane's own.
 *  Keyed on the template, not the 'plan' id, so custom plan-like lanes charter
 *  their epics instead of handing them the build template. */
export function epicPlanContextFor(ctx: LaneContext): LaneContext {
  return {
    ...ctx,
    template: EPIC_PLAN_TEMPLATE.trim(),
    actors: ctx.actors.map((a) =>
      a.id === "planner"
        ? { ...a, instructions: EPIC_PLANNER_INSTRUCTIONS }
        : a.id === "plan-reviewer"
          ? { ...a, instructions: EPIC_PLAN_REVIEWER_INSTRUCTIONS }
          : a,
    ),
  };
}

/** The plan-lane context, chartered for epics: same actors, gates, and exits —
 *  the planner and plan-reviewer swap to decomposition instructions and the
 *  charter template replaces the build template (ceqfq). */
export function epicPlanContext(): LaneContext {
  return epicPlanContextFor(defaultLaneContext("plan")!);
}

export const BUILDER_PLAN_INSTRUCTIONS = `You are pi-builder. Kanban card {id} "{title}" had its plan approved; build it in this repo.

1. Run: kanban brief {id} — the note, the approved plan, and the full thread. Follow the plan; older rejections in the thread are already addressed by it. Read AGENTS.md and REVIEW.md if present. Read GLOSSARY.md if present and use its vocabulary; update it inline when a term crystallizes.
2. Implement the plan exactly, one step at a time and in order: touch only the step's files, paste any code the plan gives as written, write the bodies and tests it specifies so they match its contracts and assertions exactly, run its Check and confirm the expected result before starting the next step (fix and re-run until it does), then commit with the step's commit line. Add or adjust only the tests the plan calls for.
3. Advance child cards as their steps land: run kanban show {id} — if it lists children, complete each child's scope and advance each child as its work lands (kanban handoff <child-id> done --message "<what landed>" --author pi-builder). Never strand a child in an active lane while its parent moves on.
4. Run the full test suite (e.g. bun test) — everything green before handoff.
5. Hand off: kanban handoff {id} review --message "<what you built · test status>" --author pi-builder

Never move the card with mv and never run kanban approve/reject. Never improvise a design the plan does not give. If a plan step turns out wrong, contradicts the repo, or its Check still fails after two fix attempts, stop and ask: kanban comment {id} "<step · command · first error line + recommended default>" --kind question --author pi-builder.
Your last line: one-sentence build summary.`;

export const BUILDER_FINDINGS_INSTRUCTIONS = `You are pi-builder. Kanban card {id} "{title}" was blocked in review; its note now carries "- [ ]" findings from pi-reviewer.

1. Run: kanban brief {id} — note (with the findings checklist), latest plan, full thread. Read AGENTS.md and REVIEW.md if present. Read GLOSSARY.md if present and use its vocabulary; update it inline when a term crystallizes.
2. Fix every [blocker] finding; fix [minor]s when cheap; [nit]s may be deferred with a one-line note in the handoff message. Run the tests.
3. Rewrite the note with the findings checked off: kanban edit {id} --note "<full updated note with '- [x]' lines>".
4. Hand the card back: kanban handoff {id} review --message "<what you fixed · test status>" --author pi-builder

Never move the card with mv. If a finding looks wrong, say so in the handoff message instead of silently skipping it. A finding that cites no proof may be challenged: quote what you checked and why it still holds. If you cannot proceed without a human call, stop and ask: kanban comment {id} "<the problem + recommended default>" --kind question --author pi-builder.`;

export const REVIEWER_INSTRUCTIONS = `You are pi-reviewer, an expert code reviewer. Kanban card {id} "{title}" was just handed off to Review in this repo.

1. Run: kanban brief {id} --json — the note, latest plan, and full thread (what the builder claims).
2. Locate the work: the last handoff message says what changed; use git log, git diff, and the files named in the plan.
3. Review like a senior engineer: correctness, edge cases, error handling, tests, adherence to the plan and repo conventions (read AGENTS.md and REVIEW.md if present). Read GLOSSARY.md if present and use its vocabulary; update it inline when a term crystallizes.
4. Check board truthfulness: run kanban show {id} — if the card has children, their lanes must match the work done. Approving a parent to Done while its children still sit in active lanes (backlog, plan, implement, review) is a block finding (quote the child ids and their lanes as proof); if the children legitimately trail as follow-up scope, say so in the approve message instead.
5. Verify cheaply: run the test suite if it is fast (e.g. bun test).
6. Prove every finding: each --finding must include the failing repro (command + observed output) or quote the exact code path that breaks. A concern you cannot verify is NOT a finding — post it as a comment instead: kanban comment {id} "<concern>" --author pi-reviewer.

Then record exactly one verdict (never move the card with mv):
- Pass: kanban review {id} --approve --message "<1-3 sentence summary; list any [minor]/[nit] observations at the end>" --author pi-reviewer
- Fail (only when at least one finding is [blocker]): kanban review {id} --block --message "<summary>" --finding "[blocker] <file:line — issue>" [--finding "<…>" …] --author pi-reviewer
Severity: [blocker] must fix before done; [minor] should fix; [nit] style or preference. A review with only [minor]/[nit] findings is a Pass.

If you cannot locate the work in this repo, do NOT block — post kanban comment {id} "could not locate the work in this repo — needs manual review" --author pi-reviewer, and stop.
Your last line: a one-sentence verdict.`;

/**
 * The default workflow each built-in lane hosts (card 3n96c): the seeded
 * LaneContexts that reproduce today's plan → implement → review pipeline
 * character-for-character. Null for the fixed non-workflow lanes.
 */
export function defaultLaneContext(laneId: string): LaneContext | null {
  switch (laneId) {
    case "plan":
      return {
        artifact: "plan",
        template: PLAN_TEMPLATE.trim(),
        actors: [
          {
            id: "planner",
            author: "pi-planner",
            instructions: PLANNER_INSTRUCTIONS,
            resumeEnding:
              '; then attach the plan file and hand off exactly: kanban attach {id} <plan-file> and kanban comment {id} "plan v<N> attached — over to pi-plan-reviewer" --kind handoff --author pi-planner',
            deathLabel: "auto-plan",
            // death comments render `${deathLabel} ${reason}${deathHint}` — the hint carries its separator
            deathHint: " — comment on this card to re-trigger.",
          },
          {
            id: "plan-reviewer",
            author: PLAN_REVIEWER_AUTHOR,
            instructions: PLAN_REVIEWER_INSTRUCTIONS,
            resumeEnding:
              '; then record exactly one verdict: kanban plan-review {id} (--pass | --block --message "<summary>" [--finding "<checklist hit>"]…) --author pi-plan-reviewer',
            deathLabel: "plan review",
            deathHint: " — approve or reject the plan directly, or comment on this card to re-run the review.",
          },
        ],
        triggers: [{ kind: "on-enter" }, { kind: "human-comment" }],
        exits: [
          { on: { author: "pi-planner", kind: "handoff" }, action: "next-actor", target: "plan-reviewer" },
          { on: { author: PLAN_REVIEWER_AUTHOR, kind: "review", prefix: KanbanDb.PLAN_REVIEW_BLOCK }, action: "rerun-first", target: "planner" },
          { on: { author: PLAN_REVIEWER_AUTHOR, kind: "review", prefix: KanbanDb.PLAN_REVIEW_PASS }, action: "disarm" },
        ],
        cap: {
          max: 2,
          scope: "since-human",
          match: { author: PLAN_REVIEWER_AUTHOR, kind: "review", prefix: KanbanDb.PLAN_REVIEW_BLOCK },
          author: PLAN_REVIEWER_AUTHOR,
          message: `${KanbanDb.PLAN_REVIEW_CAP}: blocked {max}× since the last human comment — the latest plan waits at the gate with open findings. kanban reject {id} --message <feedback> to re-plan, or comment to re-run the review.`,
        },
        gate: { approveTarget: "implement", approveOwner: BUILDER_AUTHOR, requireArtifact: "plan", rejectPrefix: "plan rejected" },
      };
    case "implement":
      return {
        actors: [
          {
            id: "builder",
            author: BUILDER_AUTHOR,
            instructions: BUILDER_FINDINGS_INSTRUCTIONS,
            approvalInstructions: BUILDER_PLAN_INSTRUCTIONS,
            resumeEnding:
              '; then hand off: kanban handoff {id} review --message "<what you built · test status>" --author pi-builder',
            deathLabel: "auto-builder",
          },
        ],
        triggers: [
          { kind: "comment", commentKind: "review", author: "pi-reviewer", targetActor: "builder" },
          { kind: "human-comment" },
        ],
        cap: {
          max: 3,
          scope: "thread",
          match: { author: "pi-reviewer", kind: "review" },
          author: "pi-reviewer",
          message: "auto-review stopped: block cycles reached the cap of {max} — needs a human. Findings are on the note.",
        },
      };
    case "review":
      return {
        actors: [
          {
            id: "reviewer",
            author: "pi-reviewer",
            instructions: REVIEWER_INSTRUCTIONS,
            resumeEnding:
              '; then record exactly one verdict: kanban review {id} (--approve | --block --message "<summary>" [--finding "<file:line — issue>"]…) --author pi-reviewer',
            deathLabel: "auto-review",
            deathHint: "; comment on this card to re-trigger.",
          },
        ],
        triggers: [{ kind: "on-enter" }],
        testGate: true,
      };
    default:
      return null; // waiting / backlog / done / archive / custom lanes start context-free
  }
}

/**
 * sha256 of every seed text a release has since replaced (qjbbn): the seeded
 * lane template and actor instructions as they shipped before their current
 * wording. A lane still holding one of these was never edited, so it adopts the
 * current default on open (adoptRetiredSeeds); edited text never matches and is
 * left alone. When you change a seeded text, append the old text's hash here.
 */
export const RETIRED_SEED_HASHES: ReadonlySet<string> = new Set([
  // qjbbn — before plans were written for a literal (flash) builder
  "041c2f962d37425351419b8045236e097c0cebfc7b58c746d9c9e887d70e06a4", // plan template
  "b57e46c8cfcf365fae67e13e929fe7a635f2b1e848e1b3687e70430bc59801d0", // planner
  "409957a5c84a87afdaef5b982e0a71f2f4315fd35e58f948cec691707ca4f7cb", // plan-reviewer
  "4e503c25ff0680f345eba81711b6a5a3d014e6ffae718f95598e7a8e7b970488", // builder (plan-build)
  // lean-plans — before plans went lean (contracts + test specs, no pasted bodies, no scratch builds)
  "e6023dfd3268d2b91863c8c9294d9ddff3a9a9adb4d9603985ff225eb3cddeab", // plan template
  "5d7d7b0cf92cfb2169b243e10757af0f3155df7ddecaa61ab9db2fe3f82c720d", // planner
  "f475f4c1bc13464b2318b3cf1e60687a5491fafa5ff8c125f3a4f0346f9b78b6", // plan-reviewer
  "49a6b82e1c08cdec87115de64aef0a6f2e3af9f2f5958fcb68ea6eeed81e4c8f", // builder (plan-build)
]);

export function seedHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * A seeded lane's context with every retired seed text swapped for the current
 * default (qjbbn): the template and each seeded actor's instructions /
 * approvalInstructions, matched by actor id. Returns null when nothing changed,
 * so callers write only on a real upgrade. Configs, triggers, exits, gates,
 * caps and custom actors are never touched.
 */
export function adoptRetiredSeeds(
  laneId: string,
  ctx: LaneContext,
  retired: ReadonlySet<string> = RETIRED_SEED_HASHES,
): LaneContext | null {
  const seed = defaultLaneContext(laneId);
  if (!seed) return null;
  const stale = (value: string | undefined, current: string | undefined): value is string =>
    value !== undefined && current !== undefined && value !== current && retired.has(seedHash(value));
  let changed = false;
  const next: LaneContext = { ...ctx };
  if (stale(ctx.template, seed.template)) {
    next.template = seed.template;
    changed = true;
  }
  next.actors = ctx.actors.map((actor) => {
    const def = seed.actors.find((a) => a.id === actor.id);
    if (!def) return actor;
    const out: LaneActor = { ...actor };
    if (stale(actor.instructions, def.instructions)) {
      out.instructions = def.instructions;
      changed = true;
    }
    if (stale(actor.approvalInstructions, def.approvalInstructions)) {
      out.approvalInstructions = def.approvalInstructions;
      changed = true;
    }
    return out;
  });
  return changed ? next : null;
}

/** Fixed first lane: HITL tickets parked for a human answer (never proposed by next). */
export const WAITING_LANE_ID = "waiting" as const;

/** Fixed container lane: approved epics supervising their children (card ceqfq).
 *  Never scanned by the loop (context-free, like waiting) and never proposed by next. */
export const EPICS_LANE_ID = "epics" as const;

/** A parent epic auto-dones when no child sits in these lanes — Backlog children
 *  are decided-not-pending ("ripen-or-rot" defers) and never block it. A child
 *  epic supervising in Epics counts as in flight for its own parent (ceqfq). */
const EPIC_BLOCKING_LANES = ["plan", "implement", "review", "waiting", "epics"] as const;

/** A card here has finished its work. An epic ENTERING the Epics lane completes
 *  only if at least one child settled — all-Backlog children mean the waves
 *  were never released, and the epic must supervise, not insta-complete (ceqfq). */
const SETTLED_LANES = ["done", "archive"] as const;

/** Lane priority for "what's next": Review → Test + Implement → Plan → Backlog (skill contract). */
export const NEXT_LANE_PRIORITY = ["review", "implement", "plan", "backlog"] as const;

export const PRIORITIES = ["high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Shared by create/patch: trim, drop empties, dedupe keeping first occurrence and order; throws on limits. */
export function normalizeTags(input: string[] | undefined): string[] {
  if (input === undefined) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const tag = raw.trim();
    if (!tag || seen.has(tag)) continue;
    if (tag.length > 48) throw new KanbanError("tags must be at most 48 characters each", "invalid");
    seen.add(tag);
    out.push(tag);
  }
  if (out.length > 10) throw new KanbanError("a card carries at most 10 tags", "invalid");
  return out;
}

/** Lanes where a card no longer blocks its dependents (soft blocking). */
export const UNBLOCKED_LANES = ["done", "archive"] as const;

/** One board-health violation reported by `kanban check` (advisory, never a gate). */
export type BoardViolation =
  | { kind: "done-parent-active-children"; cardId: string; childIds: string[] }
  | { kind: "child-behind-parent"; cardId: string; parentId: string; cardLaneId: string; parentLaneId: string }
  | { kind: "epic-in-workflow-lane"; cardId: string; laneId: string }
  | { kind: "missing-plan"; cardId: string; laneId: string }
  | { kind: "wip-over-limit"; laneId: string; limit: number; count: number };

export function defaultDbPath(): string {
  return process.env.KANBAN_DB ?? join(import.meta.dir, "..", "data", "kanban.db");
}

interface LaneRow {
  id: string;
  name: string;
  description: string;
  position: number;
  fixed: number;
  wip_limit: number | null;
}

interface TaskRow {
  id: string;
  title: string;
  note: string;
  lane_id: string;
  project: string;
  tags: string;
  parent_id: string | null;
  previous_lane: string | null;
  workspace: string | null;
  owner: string | null;
  priority: string;
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

interface GhLinkRow {
  id: string;
  card_id: string;
  url: string;
  kind: string;
  repo: string;
  number: number;
  created_at: number;
}

interface GhStateRow {
  url: string;
  kind: string;
  state: string;
  title: string;
  merged_at: number | null;
  fetched_at: number;
  error: string;
}

interface LaneEventRow {
  id: string;
  task_id: string;
  from_lane_id: string | null;
  to_lane_id: string;
  cause: string;
  actor: string;
  created_at: number;
}

const rowToLane = (r: LaneRow): Lane => ({ ...r, wipLimit: r.wip_limit ?? null });

/** tasks.tags is one JSON array column; corrupt data parses to [] — never crashes the board. */
const parseTags = (raw: string): string[] => {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const rowToTask = (r: TaskRow): Task => ({
  id: r.id,
  title: r.title,
  note: r.note,
  laneId: r.lane_id,
  project: r.project,
  tags: parseTags(r.tags),
  parentId: r.parent_id,
  previousLane: r.previous_lane ?? null,
  workspace: r.workspace ?? null,
  owner: r.owner ?? null,
  priority: (r.priority ?? "normal") as Priority,
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

const rowToGhLink = (r: GhLinkRow): GhLink => ({
  id: r.id,
  cardId: r.card_id,
  url: r.url,
  kind: r.kind as GhLinkKind,
  repo: r.repo,
  number: r.number,
  createdAt: r.created_at,
});

const rowToGhState = (r: GhStateRow): GhStatus => ({
  url: r.url,
  kind: r.kind as "pr" | "issue",
  state: r.state,
  title: r.title,
  mergedAt: r.merged_at ?? null,
  fetchedAt: r.fetched_at,
  error: r.error,
});

const rowToLaneEvent = (r: LaneEventRow): LaneEvent => ({
  id: r.id,
  taskId: r.task_id,
  fromLaneId: r.from_lane_id ?? null,
  toLaneId: r.to_lane_id,
  cause: r.cause as LaneEventCause,
  actor: r.actor,
  createdAt: r.created_at,
});

/**
 * The waiting state a card's *last* comment implies, mirroring the loop's
 * `roleFor` semantics: question kind → asking; session-death prefix → dead;
 * reviewer pass verdict → gate; reviewer cap comment → capped; any other reviewer
 * comment (failed session, cannot evaluate) → rerun; everything else (no comments,
 * block verdicts, handoffs, human/planner comments) → null — an agent turn is coming
 * or nothing is owed. With the home lane's `context` (card 3n96c) the verdict
 * states belong to that lane's own actors, and a comment matching one of its
 * park exits badges gate — a plan-review pass on an Implement card means nothing.
 */
export function waitingFromLastComment(
  last: Pick<Comment, "author" | "kind" | "body">,
  context?: LaneContext | null,
): WaitingState | null {
  if (last.kind === "question") {
    // a parked plan-review cap still badges as capped — its body carries the gate guidance
    if (last.author === PLAN_REVIEWER_AUTHOR && last.body.startsWith(KanbanDb.PLAN_REVIEW_CAP)) return "capped";
    return "question";
  }
  if (last.kind === "comment" && last.body.startsWith(KanbanDb.SESSION_DIED_PREFIX)) return "dead";
  if (context) {
    // a park exit's own verdict badges gate — the comment that parked the card
    for (const exit of context.exits ?? []) {
      if (exit.action !== "park") continue;
      const on = exit.on;
      if (
        context.actors.some((a) => a.author === last.author) &&
        (on.author === undefined || last.author === on.author) &&
        (on.kind === undefined || last.kind === on.kind) &&
        (on.prefix === undefined || last.body.startsWith(on.prefix))
      ) {
        return "gate";
      }
    }
    // the pass/rerun/capped states key on the chain's verdict voice, and only a
    // gated lane parks cards for its verdicts (plan yes; implement/review no)
    const lastActor = context.actors[context.actors.length - 1];
    if (!context.gate || lastActor === undefined || lastActor.author !== last.author) return null;
    if (last.kind === "review" && last.body.startsWith(KanbanDb.PLAN_REVIEW_PASS)) return "gate";
    if (last.kind === "comment") {
      if (last.body.startsWith(KanbanDb.PLAN_REVIEW_CAP)) return "capped";
      return "rerun";
    }
    return null;
  }
  if (last.author !== PLAN_REVIEWER_AUTHOR) return null;
  if (last.kind === "review" && last.body.startsWith(KanbanDb.PLAN_REVIEW_PASS)) return "gate";
  if (last.kind === "comment") {
    if (last.body.startsWith(KanbanDb.PLAN_REVIEW_CAP)) return "capped";
    return "rerun";
  }
  return null;
}

function computeCardStats(
  task: Task,
  events: LaneEvent[],
  comments: Comment[],
  attachments: Attachment[],
  boardLanes: Lane[],
  now: number,
): CardStats {
  const evs =
    events.length > 0
      ? events
      : [
          {
            id: "",
            taskId: task.id,
            fromLaneId: null,
            toLaneId: task.laneId,
            cause: "create" as LaneEventCause,
            actor: "user",
            createdAt: task.createdAt,
          },
        ];

  const visitedLanes = new Set<string>();
  const dwellMap = new Map<string, number>();

  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    visitedLanes.add(e.toLaneId);
    const duration =
      i < evs.length - 1 ? Math.max(0, evs[i + 1].createdAt - e.createdAt) : Math.max(0, now - e.createdAt);
    dwellMap.set(e.toLaneId, (dwellMap.get(e.toLaneId) ?? 0) + duration);
  }

  const laneTimes: Array<{ laneId: string; ms: number }> = [];
  for (const lane of boardLanes) {
    if (visitedLanes.has(lane.id)) {
      laneTimes.push({ laneId: lane.id, ms: dwellMap.get(lane.id) ?? 0 });
    }
  }
  for (const laneId of visitedLanes) {
    if (!boardLanes.some((l) => l.id === laneId)) {
      laneTimes.push({ laneId, ms: dwellMap.get(laneId) ?? 0 });
    }
  }

  const firstDone = evs.find((e) => e.toLaneId === "done");
  const reachedDone = firstDone !== undefined;
  const cycleMs = reachedDone ? Math.max(0, firstDone.createdAt - task.createdAt) : Math.max(0, now - task.createdAt);
  const lastEvent = evs[evs.length - 1];
  const currentLaneMs = Math.max(0, now - lastEvent.createdAt);
  const gateWaitMs = dwellMap.get("plan") ?? 0;

  let reviewToDoneMs: number | null = null;
  if (reachedDone) {
    const doneIndex = evs.indexOf(firstDone!);
    const doneAt = firstDone!.createdAt;
    let latestReviewAt: number | null = null;
    for (let i = 0; i < doneIndex; i++) {
      if (evs[i].toLaneId === "review" && evs[i].createdAt <= doneAt) {
        latestReviewAt = evs[i].createdAt;
      }
    }
    if (latestReviewAt !== null) {
      reviewToDoneMs = Math.max(0, doneAt - latestReviewAt);
    }
  }

  const planReviewBlocks = comments.filter(
    (c) => c.kind === "review" && c.author === PLAN_REVIEWER_AUTHOR && c.body.startsWith(KanbanDb.PLAN_REVIEW_BLOCK),
  ).length;

  const reviewerComments = comments.filter((c) => c.kind === "review" && c.author === "pi-reviewer").length;
  const reviewerDoneEvents = evs.filter(
    (e) => e.cause === "review" && e.toLaneId === "done" && e.actor === "pi-reviewer",
  ).length;
  const reviewBlocks = Math.max(0, reviewerComments - reviewerDoneEvents);

  const cappedHits = comments.filter(
    (c) =>
      c.body.startsWith(KanbanDb.PLAN_REVIEW_CAP) ||
      c.body.startsWith("auto-review stopped: block cycles reached the cap"),
  ).length;

  const planVersions = attachments.filter((a) => a.kind === "plan").length;

  const sessions = attachments.filter((a) => a.kind === "session");
  let totalSessionMs = 0;
  for (const s of sessions) {
    const firstLine = s.content.split("\n")[0] ?? "";
    const match = firstLine.match(/(\d+)s\s*$/);
    if (match) totalSessionMs += Number(match[1]) * 1000;
  }

  return {
    taskId: task.id,
    laneTimes,
    cycleMs,
    currentLaneMs,
    gateWaitMs,
    reachedDone,
    reviewToDoneMs,
    planReviewBlocks,
    reviewBlocks,
    cappedHits,
    planVersions,
    sessions: { count: sessions.length, totalMs: totalSessionMs },
  };
}

export class KanbanDb {
  private db: Database;
  private stmts = new Map<string, ReturnType<Database["prepare"]>>();

  constructor(path: string = defaultDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    // Serve's lease heartbeats and agent CLI writes share this file; without a
    // busy timeout any write collision throws SQLITE_BUSY immediately (the
    // 10/31 heartbeatLease crash). 5s of retry covers every writer here.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.ensureParentColumn();
    this.migratePriorityColumn();
    this.migratePreviousLaneColumn();
    this.migrateWorkspaceColumn();
    this.migrateOwnerColumn();
    this.migrateTagsColumn();
    this.migrateWipLimitColumn();
    this.migrateLaneContextColumn();
    this.migrateProjectTestCmdColumn();
    if (!this.schemaIsCurrent()) this.db.exec(SCHEMA); // fresh/old boards only — see below
    this.seedLanes();
    this.ensureWaitingLane();
    this.ensureEpicsLane();
    this.ensureArchiveLane();
    this.migratePlansTable();
    this.migrateProjectsSeed();
    this.migrateLaneContexts();
    this.adoptSeedUpdates();
    this.migrateEngines();
    this.backfillLaneEvents();
  }

  /** True when every object SCHEMA creates already exists. Even a fully no-op
   *  exec(SCHEMA) opens a write transaction, which would make every CLI read bump
   *  the DB change counter — breaking "reads never write" (lesson #6). Names are
   *  parsed from SCHEMA itself, so the check can never drift from the DDL. */
  private schemaIsCurrent(): boolean {
    const names = [...SCHEMA.matchAll(/CREATE (?:TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS (\w+)/g)].map((m) => m[1]!);
    if (names.length === 0) return false;
    const rows = this.q(`SELECT name FROM sqlite_master WHERE name IN (${names.map(() => "?").join(",")})`).all(
      ...names,
    ) as Array<{ name: string }>;
    const present = new Set(rows.map((r) => r.name));
    return names.every((n) => present.has(n));
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

  /**
   * this.db.transaction(fn)(), retried on SQLITE_BUSY. bun:sqlite only issues
   * deferred BEGINs; under WAL, a transaction that reads then writes fails
   * with SQLITE_BUSY (snapshot) the instant another connection commits in
   * between, and busy_timeout cannot rescue it — the whole transaction must
   * re-run. Server loop + agent CLIs share the file, so this is routine.
   */
  private tx<T>(fn: () => T, attempts = 5): T {
    for (let i = 0; ; i++) {
      try {
        return this.db.transaction(fn)();
      } catch (err) {
        if (i === attempts - 1 || (err as { code?: string }).code !== "SQLITE_BUSY") throw err;
        Bun.sleepSync(25 * (i + 1));
      }
    }
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

  /** Boards created before priority existed need the column added once; the ALTER's
   * DEFAULT backfills 'normal' on existing rows (ensureParentColumn pattern). */
  private migratePriorityColumn(): void {
    const table = this.q("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    if (!table) return; // fresh db: SCHEMA creates the table with the column
    const cols = this.q("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!cols.some((col) => col.name === "priority")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'");
    }
  }

  /** Boards created before lane memory existed need the column added once (nullable, no backfill). */
  private migratePreviousLaneColumn(): void {
    const table = this.q("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    if (!table) return; // fresh db: SCHEMA creates the table with the column
    const cols = this.q("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!cols.some((col) => col.name === "previous_lane"))
      this.db.exec("ALTER TABLE tasks ADD COLUMN previous_lane TEXT");
  }

  /** Boards created before workspace existed need the column added once (nullable, no backfill). */
  private migrateWorkspaceColumn(): void {
    const table = this.q("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    if (!table) return; // fresh db: SCHEMA creates the table with the column
    const cols = this.q("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!cols.some((col) => col.name === "workspace"))
      this.db.exec("ALTER TABLE tasks ADD COLUMN workspace TEXT");
  }

  /** Boards created before owner existed need the column added once (nullable, no backfill:
   *  existing cards read unowned, which is truthful). */
  private migrateOwnerColumn(): void {
    const table = this.q("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    if (!table) return; // fresh db: SCHEMA creates the table with the column
    const cols = this.q("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!cols.some((col) => col.name === "owner"))
      this.db.exec("ALTER TABLE tasks ADD COLUMN owner TEXT");
  }

  /** Boards created before tags existed need the column added once; the ALTER's
   * DEFAULT backfills '[]' on existing rows (migratePriorityColumn pattern). */
  private migrateTagsColumn(): void {
    const table = this.q("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    if (!table) return; // fresh db: SCHEMA creates the table with the column
    const cols = this.q("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!cols.some((col) => col.name === "tags"))
      this.db.exec("ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
  }

  /** Boards created before wip limits existed need the column added once (nullable, no backfill: existing lanes read unlimited). */
  private migrateWipLimitColumn(): void {
    const table = this.q("SELECT name FROM sqlite_master WHERE type='table' AND name='lanes'").get();
    if (!table) return; // fresh db: SCHEMA creates the table with the column
    const cols = this.q("PRAGMA table_info(lanes)").all() as Array<{ name: string }>;
    if (!cols.some((col) => col.name === "wip_limit"))
      this.db.exec("ALTER TABLE lanes ADD COLUMN wip_limit INTEGER");
  }

  /** Boards created before lane contexts existed need the column added once (nullable, no backfill: plain lanes). */
  private migrateLaneContextColumn(): void {
    const table = this.q("SELECT name FROM sqlite_master WHERE type='table' AND name='lanes'").get();
    if (!table) return; // fresh db: SCHEMA creates the table with the column
    const cols = this.q("PRAGMA table_info(lanes)").all() as Array<{ name: string }>;
    if (!cols.some((col) => col.name === "context"))
      this.db.exec("ALTER TABLE lanes ADD COLUMN context TEXT");
  }

  /** Boards created before per-project test commands existed need the column added once (nullable, no backfill: board default). */
  private migrateProjectTestCmdColumn(): void {
    const table = this.q("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get();
    if (!table) return; // fresh db: SCHEMA creates the table with the column
    const cols = this.q("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    if (!cols.some((col) => col.name === "test_cmd"))
      this.db.exec("ALTER TABLE projects ADD COLUMN test_cmd TEXT");
  }

  /**
   * One-time seed at upgrade (card 3n96c): plan, implement, and review get their
   * default LaneContexts — folding any existing agent_configs rows for their
   * actors into the seeded actor configs — guarded by a board_state key so
   * later opens (reads included) perform zero writes.
   */
  private migrateLaneContexts(): void {
    const flag = this.q("SELECT value FROM board_state WHERE key = 'lane_contexts_seeded'").get() as
      | { value: string }
      | undefined;
    if (flag) return;
    this.tx(() => {
      const inside = this.q("SELECT value FROM board_state WHERE key = 'lane_contexts_seeded'").get() as
        | { value: string }
        | undefined;
      if (inside) return;
      for (const laneId of ["plan", "implement", "review"]) {
        const row = this.q("SELECT context FROM lanes WHERE id = ?").get(laneId) as
          | { context: string | null }
          | undefined;
        if (!row || row.context !== null) continue;
        const ctx = defaultLaneContext(laneId);
        if (!ctx) continue;
        for (const actor of ctx.actors) {
          const cfg = this.agentConfig(actor.id);
          if (cfg && Object.keys(cfg).length > 0) actor.config = cfg;
        }
        this.q("UPDATE lanes SET context = ? WHERE id = ?").run(JSON.stringify(ctx), laneId);
      }
      this.q("INSERT OR REPLACE INTO board_state (key, value) VALUES ('lane_contexts_seeded', '1')").run();
    });
  }

  /**
   * Every open (qjbbn): seeded lanes still holding a retired default text adopt
   * the current one (adoptRetiredSeeds). Writes only when a lane actually
   * upgrades, so reads stay write-free once the board is current.
   */
  private adoptSeedUpdates(): void {
    for (const laneId of ["plan", "implement", "review"]) {
      const row = this.q("SELECT context FROM lanes WHERE id = ?").get(laneId) as { context: string | null } | undefined;
      if (!row?.context) continue;
      let ctx: LaneContext;
      try {
        ctx = JSON.parse(row.context) as LaneContext;
      } catch {
        continue; // a malformed context is the lane editor's problem, not the opener's
      }
      const next = adoptRetiredSeeds(laneId, ctx);
      if (next) this.q("UPDATE lanes SET context = ? WHERE id = ?").run(JSON.stringify(next), laneId);
    }
  }

  /**
   * One-time fold (card: engines): every distinct (provider, model, thinking)
   * the old surfaces could spawn — pool slots, role configs, project overrides —
   * becomes an engine, pool slot order becomes each covered role's lineup, and
   * the legacy model fields are stripped. Exact preservation: a pool's slots
   * become seats on its engines (only slots below the pool's maxWorkers ever
   * ran); a role's own model shadowed by a pool is dropped, as it never ran.
   * worker_pools rows stay as an inert backup. Guarded by a board_state flag.
   */
  private migrateEngines(): void {
    const flagged = () =>
      this.q("SELECT value FROM board_state WHERE key = 'engines_folded'").get() as { value: string } | undefined;
    if (flagged()) return;
    this.tx(() => {
      if (flagged()) return;
      const parse = <T>(raw: string): T | null => {
        try {
          return JSON.parse(raw) as T;
        } catch {
          return null;
        }
      };
      const roleRows = this.q("SELECT role, config FROM agent_configs").all() as Array<{ role: string; config: string }>;
      const legacy = new Map<string, AgentConfig & LegacyModelFields>();
      for (const r of roleRows) {
        const cfg = parse<AgentConfig & LegacyModelFields>(r.config);
        if (cfg) legacy.set(r.role, cfg);
      }
      const engines: Array<{ id: string; name: string; combo: LegacyModelFields; seats: number }> = [];
      const byKey = new Map<string, (typeof engines)[number]>();
      const keyOf = (c: LegacyModelFields) => [c.provider ?? "", c.model ?? "", c.thinking ?? ""].join("\u0000");
      const engineFor = (c: LegacyModelFields, addSeats: number) => {
        const key = keyOf(c);
        let e = byKey.get(key);
        if (!e) {
          e = { id: `eng-${engines.length + 1}`, name: "", combo: c, seats: 0 };
          engines.push(e);
          byKey.set(key, e);
        }
        e.seats += addSeats;
        return e;
      };
      const combo = (...layers: Array<LegacyModelFields | undefined>): LegacyModelFields => {
        const c: LegacyModelFields = {};
        for (const l of layers) {
          if (l?.provider?.trim()) c.provider = l.provider.trim();
          if (l?.model?.trim()) c.model = l.model.trim();
          if (l?.thinking) c.thinking = l.thinking;
        }
        return c;
      };
      const hasModel = (c: LegacyModelFields | undefined) => Boolean(c?.provider?.trim() || c?.model?.trim() || c?.thinking);
      const lineups = new Map<string, string[]>();
      const push = (role: string, id: string) => {
        const l = lineups.get(role) ?? [];
        if (!l.includes(id)) l.push(id);
        lineups.set(role, l);
      };
      const pools = this.q("SELECT config FROM worker_pools ORDER BY rowid").all() as Array<{ config: string }>;
      for (const row of pools) {
        const pool = parse<LegacyPool>(row.config);
        if (!pool?.enabled || !Array.isArray(pool.slots) || !Array.isArray(pool.roles)) continue;
        const cap = Math.min(pool.maxWorkers ?? pool.slots.length, pool.slots.length);
        for (let i = 0; i < cap; i++) {
          const seen = new Set<string>(); // an inherit slot serving roles with different models seats each once
          for (const role of pool.roles) {
            const c = combo(legacy.get(role), pool.slots[i]);
            const key = keyOf(c);
            const e = engineFor(c, seen.has(key) ? 0 : 1);
            seen.add(key);
            push(role, e.id);
          }
        }
      }
      for (const [role, cfg] of legacy) {
        if (lineups.has(role) || !hasModel(cfg)) continue;
        push(role, engineFor(combo(cfg), 1).id);
      }
      const overrides = this.q("SELECT project, actor, config FROM project_agent_configs").all() as Array<{
        project: string;
        actor: string;
        config: string;
      }>;
      const overrideLineups = new Map<string, string[]>();
      for (const o of overrides) {
        const cfg = parse<AgentConfig & LegacyModelFields>(o.config);
        if (!cfg || !hasModel(cfg)) continue;
        // a model-only override used to merge over the role's provider: fold the same pair
        const base = legacy.get(o.actor);
        const c = combo(cfg.model && !cfg.provider ? { provider: base?.provider } : undefined, cfg);
        overrideLineups.set(`${o.project}\u0000${o.actor}`, [engineFor(c, 1).id]);
      }
      // names: model (last path segment) · thinking, provider-qualified on collision
      const taken = new Set<string>();
      for (const e of engines) {
        const base = [e.combo.model?.split("/").pop() || "pi default", e.combo.thinking].filter(Boolean).join(" · ");
        let name = base;
        if (taken.has(name.toLowerCase()) && e.combo.provider) name = `${base} (${e.combo.provider})`;
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} #${n}`;
        taken.add(name.toLowerCase());
        e.name = name;
      }
      const now = Date.now();
      engines.forEach((e, position) => {
        const cfg: Record<string, unknown> = { name: e.name, harness: "pi", flags: [], seats: Math.min(MAX_ENGINE_SEATS, Math.max(1, e.seats)), enabled: true };
        if (e.combo.provider) cfg.provider = e.combo.provider;
        if (e.combo.model) cfg.model = e.combo.model;
        if (e.combo.thinking) cfg.thinking = e.combo.thinking;
        this.q("INSERT OR IGNORE INTO engines (id, position, config, updated_at) VALUES (?, ?, ?, ?)").run(e.id, position, JSON.stringify(cfg), now);
      });
      const strip = (cfg: AgentConfig & LegacyModelFields, runsOn: string[] | undefined): AgentConfig => {
        const { provider: _p, model: _m, thinking: _t, ...rest } = cfg;
        const out: AgentConfig = { ...rest };
        if (runsOn && runsOn.length > 0) out.runsOn = runsOn;
        else delete out.runsOn;
        return out;
      };
      for (const [role, cfg] of legacy) {
        this.q("UPDATE agent_configs SET config = ? WHERE role = ?").run(JSON.stringify(strip(cfg, lineups.get(role))), role);
      }
      const laneRows = this.q("SELECT id, context FROM lanes WHERE context IS NOT NULL").all() as Array<{ id: string; context: string }>;
      for (const row of laneRows) {
        const ctx = parse<LaneContext>(row.context);
        if (!ctx || !Array.isArray(ctx.actors)) continue;
        let changed = false;
        for (const actor of ctx.actors) {
          const runsOn = lineups.get(actor.id);
          if (!actor.config && !runsOn) continue;
          const next = strip({ ...(legacy.get(actor.id) ?? actor.config ?? {}) } as AgentConfig & LegacyModelFields, runsOn);
          if (Object.keys(next).length > 0) actor.config = next;
          else delete actor.config;
          changed = true;
        }
        if (changed) this.q("UPDATE lanes SET context = ? WHERE id = ?").run(JSON.stringify(ctx), row.id);
      }
      for (const o of overrides) {
        const cfg = parse<AgentConfig & LegacyModelFields>(o.config);
        if (!cfg) continue;
        const runsOn = overrideLineups.get(`${o.project}\u0000${o.actor}`);
        this.q("UPDATE project_agent_configs SET config = ? WHERE project = ? AND actor = ?").run(
          JSON.stringify(strip(cfg, runsOn ?? cfg.runsOn)),
          o.project,
          o.actor,
        );
      }
      this.q("INSERT OR REPLACE INTO board_state (key, value) VALUES ('engines_folded', '1')").run();
    });
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

  /** Boards created before the waiting lane existed get it seeded first once; a
   * pre-existing custom lane with our id is adopted and marked fixed. */
  private ensureWaitingLane(): void {
    const row = this.q("SELECT COUNT(*) AS n FROM lanes WHERE id = 'waiting'").get() as { n: number };
    if (row.n > 0) {
      // Repair only when needed: running the UPDATE unconditionally would make every CLI
      // open — including pure reads like overview/ls/search — commit a write (lesson #6).
      const lane = this.q("SELECT fixed FROM lanes WHERE id = 'waiting'").get() as { fixed: number };
      if (lane.fixed !== 1) this.q("UPDATE lanes SET fixed = 1 WHERE id = 'waiting'").run();
      return;
    }
    const first = this.q("SELECT MIN(position) AS p FROM lanes").get() as { p: number | null };
    this.q("INSERT INTO lanes (id, name, description, position, fixed) VALUES (?, ?, ?, ?, 1)").run(
      "waiting",
      "Waiting on you",
      "Parked for a human answer — replying returns the card",
      (first.p ?? 0) / 2,
    );
  }

  /** Same seed-adopt for the Epics container lane (ceqfq): adopt a custom lane
   *  with our id, else insert between Backlog and the next lane so the board
   *  order matches a fresh seed. */
  private ensureEpicsLane(): void {
    const row = this.q("SELECT COUNT(*) AS n FROM lanes WHERE id = 'epics'").get() as { n: number };
    if (row.n > 0) {
      const lane = this.q("SELECT fixed FROM lanes WHERE id = 'epics'").get() as { fixed: number };
      if (lane.fixed !== 1) this.q("UPDATE lanes SET fixed = 1 WHERE id = 'epics'").run();
      return;
    }
    const lanes = this.lanes();
    const backlog = lanes.find((l) => l.id === "backlog");
    if (!backlog) return; // defensive: backlog is fixed and always present
    const after = lanes.find((l) => l.position > backlog.position);
    const position = after ? (backlog.position + after.position) / 2 : backlog.position + GAP;
    this.q("INSERT INTO lanes (id, name, description, position, fixed) VALUES (?, ?, ?, ?, 1)").run(
      "epics",
      "Epics",
      "Approved epics supervising their children — never worked directly",
      position,
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

  // One-time seed at upgrade: existing project tags materialize as un-routed
  // rows exactly once (guarded by an empty table) so route edits survive tag
  // churn. Later tags surface lazily through listProjects' read-time union —
  // this only ever runs in the constructor, reads elsewhere stay writes-free.
  private migrateProjectsSeed(): void {
    const count = this.q("SELECT COUNT(*) AS n FROM projects").get() as { n: number };
    if (count.n > 0) return;
    const now = Date.now();
    this.tx(() => {
      this.q(
        `INSERT OR IGNORE INTO projects (name, repo_path, test_gate, created_at, updated_at)
         SELECT DISTINCT project, NULL, 1, ?, ? FROM tasks WHERE project != ''`,
      ).run(now, now);
    });
  }

  /** Routing settings per project tag; un-registered tags surface lazily as un-routed rows (no write on read). */
  listProjects(): ProjectRoute[] {
    const rows = this.q(
      `SELECT name, repo_path, test_gate, test_cmd FROM projects
       UNION
       SELECT DISTINCT project, NULL, 1, NULL FROM tasks WHERE project != '' AND project NOT IN (SELECT name FROM projects)
       ORDER BY name`,
    ).all() as Array<{ name: string; repo_path: string | null; test_gate: number; test_cmd: string | null }>;
    return rows.map((r) => ({
      name: r.name,
      repoPath: r.repo_path,
      testGate: r.test_gate === 1,
      testCmd: r.test_cmd ?? null,
    }));
  }

  /** The stored row only — null for un-registered tags (defaults apply upstream). */
  getProject(name: string): ProjectRoute | null {
    const row = this.q("SELECT name, repo_path, test_gate, test_cmd FROM projects WHERE name = ?").get(name) as
      | { name: string; repo_path: string | null; test_gate: number; test_cmd: string | null }
      | undefined;
    if (!row) return null;
    return { name: row.name, repoPath: row.repo_path, testGate: row.test_gate === 1, testCmd: row.test_cmd ?? null };
  }

  // name guard shared by both setters: matches the 48-char tag cap
  private projectRow(name: string): { name: string } {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 48) {
      throw new KanbanError("project name must be 1 to 48 characters", "invalid");
    }
    return { name: trimmed };
  }

  /** Register a new project with its repo route; refuses if the name already exists in listProjects(). */
  addProject(name: string, repoPath: string): ProjectRoute {
    const bad = `repo path must be an absolute path to an existing directory: ${repoPath}`;
    if (!isAbsolute(repoPath)) throw new KanbanError(bad, "invalid");
    let isDir = false;
    try {
      isDir = statSync(repoPath).isDirectory();
    } catch {
      /* missing/unreadable path */
    }
    if (!isDir) throw new KanbanError(bad, "invalid");
    const resolvedRepo = resolve(repoPath);

    const { name: clean } = this.projectRow(name);
    return this.tx(() => {
      if (this.listProjects().some((p) => p.name === clean)) {
        throw new KanbanError(
          `project '${clean}' already exists — use: kanban project set ${clean} --repo <path>`,
          "conflict",
        );
      }
      return this.upsertProject(clean, { repoPath: resolvedRepo, testGate: true });
    });
  }

  /** Upsert the repo route; null clears it (the card falls back to the serve cwd). */
  setProjectRepo(name: string, repoPath: string | null): ProjectRoute {
    const { name: clean } = this.projectRow(name);
    if (repoPath !== null) {
      const bad = `repo path must be an absolute path to an existing directory: ${repoPath}`;
      if (!isAbsolute(repoPath)) throw new KanbanError(bad, "invalid");
      let isDir = false;
      try {
        isDir = statSync(repoPath).isDirectory();
      } catch {
        /* missing/unreadable path */
      }
      if (!isDir) throw new KanbanError(bad, "invalid");
    }
    return this.upsertProject(clean, { repoPath });
  }

  /** Upsert the test-gate bit; creates the row with a null repo when absent. */
  setProjectGate(name: string, testGate: boolean): ProjectRoute {
    const { name: clean } = this.projectRow(name);
    return this.upsertProject(clean, { testGate });
  }

  /** Upsert the test command; null or "" clears it to null (the project falls back to the board default). */
  setProjectTestCmd(name: string, cmd: string | null): ProjectRoute {
    const { name: clean } = this.projectRow(name);
    if (cmd === null || cmd === "") {
      return this.upsertProject(clean, { testCmd: null });
    }
    const trimmed = cmd.trim();
    if (trimmed.length < 1 || trimmed.length > 500) {
      throw new KanbanError("test command must be 1 to 500 characters", "invalid");
    }
    return this.upsertProject(clean, { testCmd: trimmed });
  }

  /** Stored per-project actor override, or null when absent or corrupt. Never throws. */
  projectAgentConfig(project: string, actor: string): AgentConfig | null {
    if (!project || !actor) return null;
    const row = this.q("SELECT config FROM project_agent_configs WHERE project = ? AND actor = ?").get(
      project,
      actor,
    ) as { config: string } | null;
    if (!row) return null;
    try {
      return JSON.parse(row.config) as AgentConfig;
    } catch {
      return null;
    }
  }

  /** All stored overrides for a project, sorted by actor; unknown or empty project reads as []. */
  listProjectAgentConfigs(project: string): Array<{ actor: string; config: AgentConfig }> {
    if (!project) return [];
    const rows = this.q(
      "SELECT actor, config FROM project_agent_configs WHERE project = ? ORDER BY actor",
    ).all(project) as Array<{ actor: string; config: string }>;
    const out: Array<{ actor: string; config: AgentConfig }> = [];
    for (const row of rows) {
      try {
        out.push({ actor: row.actor, config: JSON.parse(row.config) as AgentConfig });
      } catch {
        /* corrupt row reads as absent — same policy as projectAgentConfig */
      }
    }
    return out;
  }

  /**
   * Set or delete a per-project actor override. Null deletes.
   * Unknown roles throw KanbanError; un-registered project tags materialize with v1 defaults.
   */
  setProjectAgentConfig(project: string, actor: string, config: AgentConfig | null): AgentConfig | null {
    const { name: cleanProject } = this.projectRow(project);
    if (!AGENT_CONFIG_ROLES.has(actor) && !this.hasLaneActor(actor)) {
      throw new KanbanError(
        `unknown agent role '${actor}' (reviewer | builder | planner | plan-reviewer | elaborator | manager | worker)`,
        "invalid",
      );
    }
    if (config === null) {
      this.q("DELETE FROM project_agent_configs WHERE project = ? AND actor = ?").run(cleanProject, actor);
      return null;
    }
    const clean = this.cleanProjectOverride(config);
    this.tx(() => {
      this.upsertProject(cleanProject, {});
      const now = Date.now();
      this.q(
        `INSERT INTO project_agent_configs (project, actor, config, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project, actor) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
      ).run(cleanProject, actor, JSON.stringify(clean), now);
    });
    return clean;
  }

  /** Strip empty strings from an override agent config; empty skills/extraArgs preserved if present. */
  private cleanProjectOverride(config: AgentConfig): AgentConfig {
    const clean: AgentConfig = {};
    if (config.runsOn !== undefined) {
      const runsOn = this.cleanRunsOn(config.runsOn);
      if (runsOn.length > 0) clean.runsOn = runsOn;
    }
    if (config.skills !== undefined) {
      clean.skills = config.skills.map((s) => s.trim()).filter(Boolean);
    }
    if (config.context?.trim()) clean.context = config.context.trim();
    if (config.tools?.trim()) clean.tools = config.tools.trim();
    if (config.extraArgs !== undefined) {
      clean.extraArgs = config.extraArgs.map((a) => a.trim()).filter(Boolean);
    }
    if (config.timeoutMs !== undefined) clean.timeoutMs = config.timeoutMs;
    return clean;
  }

  private upsertProject(
    name: string,
    patch: { repoPath?: string | null; testGate?: boolean; testCmd?: string | null },
  ): ProjectRoute {
    return this.tx(() => {
      const now = Date.now();
      const existing = this.getProject(name);
      const repoPath = patch.repoPath !== undefined ? patch.repoPath : (existing?.repoPath ?? null);
      const testGate = patch.testGate !== undefined ? patch.testGate : (existing?.testGate ?? true);
      const testCmd = patch.testCmd !== undefined ? patch.testCmd : (existing?.testCmd ?? null);
      this.q(
        `INSERT INTO projects (name, repo_path, test_gate, test_cmd, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET repo_path = excluded.repo_path, test_gate = excluded.test_gate, test_cmd = excluded.test_cmd, updated_at = excluded.updated_at`,
      ).run(name, repoPath, testGate ? 1 : 0, testCmd, now, now);
      return this.getProject(name)!;
    });
  }

  /** The cwd agents spawn in for a project tag; null = the serve launch dir. No fs checks — a vanished repo fails the spawn. */
  projectCwd(project: string): string | null {
    if (project === "") return null;
    const row = this.q("SELECT repo_path FROM projects WHERE name = ?").get(project) as
      | { repo_path: string | null }
      | undefined;
    return row?.repo_path ?? null;
  }

  private backfillLaneEvents(): void {
    const flag = this.q("SELECT value FROM board_state WHERE key = 'lane_events_backfilled'").get() as
      | { value: string }
      | undefined;
    if (flag) return;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inside = this.q("SELECT value FROM board_state WHERE key = 'lane_events_backfilled'").get() as
        | { value: string }
        | undefined;
      if (inside) {
        this.db.exec("COMMIT");
        return;
      }

      const tasksWithoutEvents = this.q(
        "SELECT * FROM tasks WHERE id NOT IN (SELECT DISTINCT task_id FROM lane_events) ORDER BY created_at, id",
      ).all() as TaskRow[];

      const insertEvent = this.q(
        "INSERT INTO lane_events (id, task_id, from_lane_id, to_lane_id, cause, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );

      for (const tRow of tasksWithoutEvents) {
        const task = rowToTask(tRow);
        const taskComments = this.comments(task.id);

        const timeline: Array<{ at: number; lane: string; actor: string }> = [
          { at: task.createdAt, lane: "backlog", actor: "user" },
        ];

        let lastAnchorAt: number | null = null;
        for (const c of taskComments) {
          if (c.kind === "approval") {
            timeline.push({ at: c.createdAt, lane: "implement", actor: c.author });
            lastAnchorAt = c.createdAt;
          } else if (c.kind === "rejection") {
            timeline.push({ at: c.createdAt, lane: "plan", actor: c.author });
            lastAnchorAt = c.createdAt;
          } else if (
            c.kind === "review" &&
            c.author === PLAN_REVIEWER_AUTHOR &&
            (c.body.startsWith(KanbanDb.PLAN_REVIEW_PASS) || c.body.startsWith(KanbanDb.PLAN_REVIEW_BLOCK))
          ) {
            timeline.push({ at: c.createdAt, lane: "plan", actor: c.author });
            lastAnchorAt = c.createdAt;
          }
        }

        timeline.push({ at: lastAnchorAt ?? task.createdAt, lane: task.laneId, actor: "user" });

        let prevLane: string | null = null;
        for (const entry of timeline) {
          if (prevLane !== null && entry.lane === prevLane) {
            continue;
          }
          insertEvent.run(newId(), task.id, prevLane, entry.lane, "backfill", entry.actor, entry.at);
          prevLane = entry.lane;
        }
      }

      this.q("INSERT OR REPLACE INTO board_state (key, value) VALUES ('lane_events_backfilled', '1')").run();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private recordLaneEvent(
    taskId: string,
    fromLaneId: string | null,
    toLaneId: string,
    cause: LaneEventCause,
    actor = "user",
    createdAt = Date.now(),
  ): void {
    this.q(
      "INSERT INTO lane_events (id, task_id, from_lane_id, to_lane_id, cause, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(newId(), taskId, fromLaneId, toLaneId, cause, actor, createdAt);
  }

  // ---------- reads ----------

  lanes(): Lane[] {
    return (this.q("SELECT * FROM lanes ORDER BY position, id").all() as LaneRow[]).map(rowToLane);
  }

  tasks(): Task[] {
    return (this.q("SELECT * FROM tasks ORDER BY created_at, id").all() as TaskRow[]).map(rowToTask);
  }

  /**
   * The skill's "what's next" card: first lane in NEXT_LANE_PRIORITY holding an
   * eligible (unblocked, project-matching) task; within it priority rank, then
   * (created_at, id). `blocked` counts skipped blocked cards: in the lane the
   * answer came from, or — when nothing is eligible anywhere — in the
   * highest-priority lane that held any tasks (else 0).
   */
  nextTask(project?: string): { task: Task | null; blocked: number } {
    const present = new Set(this.lanes().map((l) => l.id));
    let firstLaneBlocked: number | null = null;

    const ELIGIBILITY = `
      id NOT IN (
        SELECT b.card_id FROM blocked_by b
        JOIN tasks blocker ON blocker.id = b.blocker_id
        WHERE blocker.lane_id NOT IN ('done', 'archive')
      )
    `;

    const INELIGIBILITY = `
      id IN (
        SELECT b.card_id FROM blocked_by b
        JOIN tasks blocker ON blocker.id = b.blocker_id
        WHERE blocker.lane_id NOT IN ('done', 'archive')
      )
    `;

    const ORDER = `
      ORDER BY
        CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
        created_at,
        id
    `;

    for (const laneId of NEXT_LANE_PRIORITY) {
      if (!present.has(laneId)) continue;

      const totalCount = (
        project !== undefined
          ? this.q("SELECT COUNT(*) AS n FROM tasks WHERE lane_id = ? AND project = ?").get(laneId, project)
          : this.q("SELECT COUNT(*) AS n FROM tasks WHERE lane_id = ?").get(laneId)
      ) as { n: number };

      if (totalCount.n === 0) continue;

      const blockedCount = (
        project !== undefined
          ? this.q(`SELECT COUNT(*) AS n FROM tasks WHERE lane_id = ? AND project = ? AND ${INELIGIBILITY}`).get(
              laneId,
              project,
            )
          : this.q(`SELECT COUNT(*) AS n FROM tasks WHERE lane_id = ? AND ${INELIGIBILITY}`).get(laneId)
      ) as { n: number };

      const row = (
        project !== undefined
          ? this.q(`SELECT * FROM tasks WHERE lane_id = ? AND project = ? AND ${ELIGIBILITY} ${ORDER} LIMIT 1`).get(
              laneId,
              project,
            )
          : this.q(`SELECT * FROM tasks WHERE lane_id = ? AND ${ELIGIBILITY} ${ORDER} LIMIT 1`).get(laneId)
      ) as TaskRow | null;

      if (row) {
        return { task: rowToTask(row), blocked: blockedCount.n };
      }

      if (firstLaneBlocked === null) {
        firstLaneBlocked = blockedCount.n;
      }
    }

    return { task: null, blocked: firstLaneBlocked ?? 0 };
  }

  board(): Board {
    const laneOrder = new Map(this.lanes().map((l, i) => [l.id, i]));
    const tasks = this.tasks().sort(
      (a, b) => (laneOrder.get(a.laneId) ?? 0) - (laneOrder.get(b.laneId) ?? 0) || a.position - b.position,
    );
    return {
      lanes: this.lanes(),
      tasks,
      plans: this.latestPlans(),
      waiting: this.waitingStates(),
      blockedBy: this.blockedByMap(),
      links: this.linksMap(),
      ghLinks: this.ghLinksMap(),
      laneContexts: this.laneContexts(),
    };
  }

  // ---------- lane contexts (card 3n96c) ----------

  /** The workflow context a lane hosts, parsed from its row; null when plain (or unknown). */
  laneContext(laneRef: string): LaneContext | null {
    let lane: Lane;
    try {
      lane = this.resolveLane(laneRef);
    } catch {
      return null; // unknown lane ref — no context (roleFor hits this for orphaned lanes)
    }
    const row = this.q("SELECT context FROM lanes WHERE id = ?").get(lane.id) as { context: string | null } | null;
    if (!row?.context) return null;
    try {
      return JSON.parse(row.context) as LaneContext;
    } catch {
      return null; // corrupt JSON reads as a plain lane — never crashes the board
    }
  }

  /** Sparse lane-id → LaneContext for every lane hosting a workflow context. */
  laneContexts(): Record<string, LaneContext> {
    const rows = this.q("SELECT id, context FROM lanes WHERE context IS NOT NULL").all() as Array<{
      id: string;
      context: string;
    }>;
    const out: Record<string, LaneContext> = {};
    for (const r of rows) {
      try {
        out[r.id] = JSON.parse(r.context) as LaneContext;
      } catch {
        /* corrupt row reads as plain */
      }
    }
    return out;
  }

  /**
   * Store or clear a lane's workflow context. Fixed non-workflow lanes refuse;
   * everything else validates actors/triggers/artifact/cap/gate and keeps
   * agent_configs in sync with the actors' configs.
   */
  setLaneContext(laneRef: string, context: LaneContext | null): LaneContext | null {
    const lane = this.resolveLane(laneRef);
    if (context !== null && (lane.id === WAITING_LANE_ID || lane.id === "done" || lane.id === "archive")) {
      throw new KanbanError(`lane '${lane.id}' cannot host a workflow context`, "invalid");
    }
    if (context !== null) this.validateLaneContext(context);
    const clean = context === null ? null : this.normalizeLaneContext(context);
    this.tx(() => {
      this.q("UPDATE lanes SET context = ? WHERE id = ?").run(clean === null ? null : JSON.stringify(clean), lane.id);
      if (clean !== null) {
        for (const actor of clean.actors) {
          if (actor.config && Object.keys(actor.config).length > 0) {
            this.writeAgentConfigRow(actor.id, actor.config);
          }
        }
      }
    });
    return clean;
  }

  /** Shared rule checks for a stored context (the shape errors come from). */
  private validateLaneContext(ctx: LaneContext): void {
    if (!Array.isArray(ctx.actors) || ctx.actors.length < 1 || ctx.actors.length > 4) {
      throw new KanbanError("lane context must have 1-4 actors", "invalid");
    }
    const seen = new Set<string>();
    for (const actor of ctx.actors) {
      if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(actor.id)) {
        throw new KanbanError(`actor id '${actor.id}' must be lowercase kebab, up to 48 chars`, "invalid");
      }
      if (seen.has(actor.id)) throw new KanbanError(`duplicate actor id '${actor.id}'`, "invalid");
      seen.add(actor.id);
      if (!actor.author?.trim() || !actor.author.startsWith("pi-")) {
        throw new KanbanError("actor author must start with 'pi-'", "invalid");
      }
      if (!actor.instructions?.trim()) {
        throw new KanbanError("actor instructions must not be empty", "invalid");
      }
    }
    if (!Array.isArray(ctx.triggers) || ctx.triggers.length < 1) {
      throw new KanbanError("lane context must have at least one trigger", "invalid");
    }
    if (ctx.artifact !== undefined && ctx.artifact !== "") {
      if (!FILE_NAME_RE.test(ctx.artifact) || RESERVED_FILE_NAMES.has(ctx.artifact)) {
        throw new KanbanError(
          `invalid artifact name '${ctx.artifact}': lowercase kebab, up to 48 chars, optional extension (e.g. design)`,
          "invalid",
        );
      }
    }
    if (ctx.cap) {
      const { max, author, message } = ctx.cap;
      if (!Number.isInteger(max) || max < 1 || max > 20) {
        throw new KanbanError("cap max must be an integer from 1 to 20", "invalid");
      }
      if (!author?.startsWith("pi-")) throw new KanbanError("cap author must start with 'pi-'", "invalid");
      if (!message?.trim()) throw new KanbanError("cap message must not be empty", "invalid");
    }
    if (ctx.gate && !ctx.gate.approveTarget?.trim()) {
      throw new KanbanError("gate needs an approve target lane", "invalid");
    }
  }

  /** Strip empty optionals so stored contexts stay canonical (the setAgentConfig pattern). */
  private normalizeLaneContext(ctx: LaneContext): LaneContext {
    const out: LaneContext = {
      actors: ctx.actors.map((a) => {
        const actor: LaneActor = { id: a.id, author: a.author, instructions: a.instructions };
        if (a.approvalInstructions?.trim()) actor.approvalInstructions = a.approvalInstructions;
        if (a.resumeEnding?.trim()) actor.resumeEnding = a.resumeEnding;
        if (a.deathLabel?.trim()) actor.deathLabel = a.deathLabel;
        if (a.deathHint?.trim()) actor.deathHint = a.deathHint;
        if (a.config && Object.keys(this.cleanAgentConfig(a.config)).length > 0) {
          actor.config = this.cleanAgentConfig(a.config);
        }
        return actor;
      }),
      triggers: ctx.triggers,
    };
    if (ctx.artifact?.trim()) out.artifact = ctx.artifact.trim();
    if (ctx.template?.trim()) out.template = ctx.template;
    if (ctx.exits && ctx.exits.length > 0) out.exits = ctx.exits;
    if (ctx.gate) out.gate = ctx.gate;
    if (ctx.cap) out.cap = ctx.cap;
    if (ctx.testGate) out.testGate = true;
    return out;
  }

  /** Park a card in Waiting on you, remembering its home lane (the exit-rule "park" action's write). */
  parkTask(taskRef: string): Task {
    const task = this.resolveTask(taskRef);
    this.parkInWaiting(task.id, task.laneId);
    return this.resolveTask(task.id);
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

  /** The cheap one-read board shape: every lane with its count and WIP limit, plus the
   *  owned cards (lane order, then position). Never card bodies — that is what brief is for. */
  overview(): { lanes: Array<{ id: string; name: string; count: number; wipLimit: number | null }>; owned: Task[] } {
    const lanes = this.lanes();
    const laneOrder = new Map(lanes.map((l, i) => [l.id, i]));
    const owned = this.tasks()
      .filter((t) => t.owner !== null)
      .sort(
        (a, b) => (laneOrder.get(a.laneId) ?? 0) - (laneOrder.get(b.laneId) ?? 0) || a.position - b.position,
      );
    return {
      lanes: lanes.map((l) => ({ id: l.id, name: l.name, count: this.taskCount(l.id), wipLimit: l.wipLimit })),
      owned,
    };
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

  createTask(input: {
    title: string;
    note?: string;
    lane?: string;
    project?: string;
    tags?: string[];
    parent?: string | null;
    priority?: string;
    blockedBy?: string[];
    index?: number;
  }): Task {
    const title = input.title.trim();
    if (!title) throw new KanbanError("title must not be empty", "invalid");
    if (input.priority !== undefined && !PRIORITIES.includes(input.priority as Priority)) {
      throw new KanbanError("priority must be one of high|normal|low", "invalid");
    }
    const priority = input.priority ?? "normal";
    const parent = this.resolveParent(null, input.parent);
    const lane = input.lane
      ? this.resolveLane(input.lane)
      : parent
        ? this.resolveLane(parent.laneId)
        : this.lanes().find((l) => l.id !== WAITING_LANE_ID)!; // bare adds keep landing in Backlog
    if (!lane) throw new KanbanError("board has no lanes", "invalid");
    const now = Date.now();
    const position = this.insertPosition(lane.id, input.index, null);
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newId();
      try {
        this.tx(() => {
          this.q(
            "INSERT INTO tasks (id, title, note, lane_id, project, tags, parent_id, previous_lane, priority, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(id, title, input.note ?? "", lane.id, input.project ?? "", JSON.stringify(normalizeTags(input.tags)), parent?.id ?? null, null, priority, position, now, now);
          this.recordLaneEvent(id, null, lane.id, "create", "user", now);
          if (input.blockedBy !== undefined) {
            this.setBlockedBy(id, input.blockedBy);
          }
        });
        this.renormalizeIfTight(lane.id);
        return this.resolveTask(id);
      } catch (err) {
        if (err instanceof KanbanError) throw err;
        if (!(err instanceof Error && err.message.includes("UNIQUE"))) throw err;
      }
    }
    throw new KanbanError("could not generate a unique id", "conflict");
  }

  updateTask(prefix: string, patch: TaskPatch, meta?: { cause?: LaneEventCause; actor?: string }): Task {
    const task = this.resolveTask(prefix);
    const laneId = patch.lane ? this.resolveLane(patch.lane).id : task.laneId;
    // Anchor placement: --before resolves to the anchor's index among the target lane's
    // other cards, so insertPosition lands the card strictly between the anchor's
    // predecessor and the anchor — concurrent-safe, unlike a numeric index.
    let beforeIndex: number | undefined;
    if (patch.before !== undefined) {
      const anchor = this.resolveTask(patch.before);
      if (anchor.id === task.id) throw new KanbanError("cannot move a card before itself", "invalid");
      if (anchor.laneId !== laneId) {
        throw new KanbanError(`anchor card '${anchor.id}' is not in lane '${laneId}'`, "conflict");
      }
      beforeIndex = this.laneTasks(laneId).filter((t) => t.id !== task.id).findIndex((t) => t.id === anchor.id);
    }
    const hasIndex = patch.index !== undefined;
    // An explicit priority change reorders the lane (hquwn): high rises to the
    // top, low sinks to the bottom — visual order and `next` order stay aligned;
    // normal leaves the position to drag. An explicit index/lane move wins.
    const priorityReposition =
      patch.priority !== undefined &&
      patch.priority !== task.priority &&
      !patch.lane &&
      !hasIndex &&
      beforeIndex === undefined;
    const position =
      patch.lane || hasIndex || beforeIndex !== undefined
        ? this.insertPosition(laneId, beforeIndex ?? patch.index, task.id)
        : priorityReposition && patch.priority === "high"
          ? this.insertPosition(laneId, 0, task.id)
          : priorityReposition && patch.priority === "low"
            ? this.insertPosition(laneId, undefined, task.id)
            : task.position;
    const parentId =
      patch.parent === undefined ? task.parentId : (this.resolveParent(task.id, patch.parent)?.id ?? null);

    const title = patch.title?.trim();
    if (patch.title !== undefined && !title) throw new KanbanError("title must not be empty", "invalid");

    const tags = patch.tags !== undefined ? normalizeTags(patch.tags) : task.tags;

    if (patch.priority !== undefined && !PRIORITIES.includes(patch.priority as Priority)) {
      throw new KanbanError("priority must be one of high|normal|low", "invalid");
    }
    const priority = patch.priority ?? task.priority;

    const previousLane = laneId === WAITING_LANE_ID ? task.previousLane : null;

    // Ownership: explicit patch wins (string trims, null clears); any lane change out of
    // Test + Implement clears it regardless of the patch, so owner ≠ null ⟺ someone is
    // building it (parking in waiting, mv to review, done, archive — every exit).
    let owner = task.owner;
    if (patch.owner !== undefined) {
      if (patch.owner === null) {
        owner = null;
      } else {
        const trimmed = patch.owner.trim();
        if (!trimmed) throw new KanbanError("owner must not be empty", "invalid");
        owner = trimmed;
      }
    }
    if (laneId !== task.laneId && laneId !== "implement") owner = null;

    let workspace = task.workspace;
    if (patch.workspace !== undefined) {
      if (patch.workspace === null) {
        workspace = null;
      } else {
        const trimmed = patch.workspace.trim();
        if (!trimmed || trimmed.length > 200 || !/^\S+$/.test(trimmed)) {
          throw new KanbanError("workspace must be a non-empty branch name without whitespace", "invalid");
        }
        workspace = trimmed;
      }
    }

    const now = Date.now();
    this.q(
      `UPDATE tasks SET
        title = ?, note = ?, lane_id = ?, project = ?, tags = ?, parent_id = ?, previous_lane = ?, workspace = ?, owner = ?, priority = ?, position = ?, updated_at = ?
      WHERE id = ?`,
    ).run(
      title ?? task.title,
      patch.note ?? task.note,
      laneId,
      patch.project ?? task.project,
      JSON.stringify(tags),
      parentId,
      previousLane,
      workspace,
      owner,
      priority,
      position,
      now,
      task.id,
    );
    if (laneId !== task.laneId) {
      this.recordLaneEvent(task.id, task.laneId, laneId, meta?.cause ?? "edit", meta?.actor ?? "user", now);
      // a child's lane move can complete an ancestor epic (ceqfq) — checked
      // after the move lands; walking parents is bounded by the depth-3 cap
      this.autoDoneEpics(task.id);
    }
    this.renormalizeIfTight(laneId);
    if (patch.blockedBy !== undefined) {
      this.setBlockedBy(task.id, patch.blockedBy);
    }
    return this.resolveTask(task.id);
  }

  /** After a lane move (or child deletion): the starting container itself, then
   *  every ancestor epic parked in the Epics lane with nothing left in flight
   *  (EPIC_BLOCKING_LANES — Backlog defers never block, ceqfq decision 2) moves
   *  itself to done, one comment recording why. Evaluating the start card covers
   *  an epic that just ENTERED the Epics lane via approve or a hand mv with its
   *  children already settled; deleteTask evaluates the deleted child's parent
   *  for the same reason. An entry completes only if some child has settled
   *  (done/archive): all-Backlog children mean the waves were never released —
   *  such an epic must park and supervise, not insta-complete (approve/AC and
   *  the supervising-child case pin this). Child events (any move, any delete)
   *  keep the plain rule. Runs at every depth: a finished story can complete its
   *  parent story, then the epic — moving to done re-enters updateTask, so the
   *  walk continues upward naturally; depth is capped by the parent limit. */
  private autoDoneEpics(startTaskId: string, viaChildEvent = false): void {
    let cur = this.resolveTask(startTaskId);
    let childEvent = viaChildEvent;
    for (;;) {
      if (cur.laneId === EPICS_LANE_ID) {
        const children = this.childrenOf(cur.id);
        const inFlight = children.filter((c) =>
          (EPIC_BLOCKING_LANES as readonly string[]).includes(c.laneId),
        );
        const settled = childEvent || children.some((c) => (SETTLED_LANES as readonly string[]).includes(c.laneId));
        if (inFlight.length === 0 && settled) {
          this.updateTask(cur.id, { lane: "done" }, { cause: "auto", actor: "kanban" });
          this.createComment(cur.id, {
            author: "kanban",
            kind: "comment",
            body: "epic complete — no children in flight (Backlog defers stay parked)",
          });
        }
        return; // an epic's completion (or non-completion) settles this chain
      }
      if (cur.parentId === null) return;
      cur = this.resolveTask(cur.parentId);
      childEvent = true; // every ancestor is evaluated because a child event happened
    }
  }

  moveTask(prefix: string, laneRef: string, index?: number, meta?: { cause?: LaneEventCause; actor?: string }): Task {
    // Same-lane move with no ordering intent is a free no-op: no write, no updated_at
    // bump, no lane event, no re-append (pi-web lesson #4 — no-op writes don't move anything).
    const task = this.resolveTask(prefix);
    if (index === undefined && this.resolveLane(laneRef).id === task.laneId) return task;
    return this.updateTask(prefix, { lane: laneRef, index }, { cause: "mv", ...meta });
  }

  /** Anchor move: place the card directly before `beforeRef` (unique prefix ok), in
   *  `laneRef` when given, else the card's current lane. Survives concurrent edits
   *  where an index would drift (pi-web lesson #5). */
  moveTaskBefore(
    taskRef: string,
    laneRef: string | undefined,
    beforeRef: string,
    meta?: { cause?: LaneEventCause; actor?: string },
  ): Task {
    const task = this.resolveTask(taskRef);
    const anchor = this.resolveTask(beforeRef);
    if (anchor.id === task.id) throw new KanbanError("cannot move a card before itself", "invalid");
    const targetLaneId = laneRef !== undefined ? this.resolveLane(laneRef).id : task.laneId;
    if (anchor.laneId !== targetLaneId) {
      throw new KanbanError(`anchor card '${anchor.id}' is not in lane '${targetLaneId}'`, "conflict");
    }
    return this.updateTask(task.id, { lane: targetLaneId, before: anchor.id }, { cause: "mv", ...meta });
  }

  /** Set the card's owner (the actor currently responsible). Idempotent for the same
   *  author; a foreign owner needs force. Ownership is advisory — no lane rules here. */
  claimTask(taskRef: string, input: { author?: string; force?: boolean } = {}): Task {
    const task = this.resolveTask(taskRef);
    const author = input.author?.trim() || "user";
    if (task.owner && task.owner !== author && !input.force) {
      throw new KanbanError(
        `card '${task.id}' is already owned by '${task.owner}' — pass --force to take it over`,
        "conflict",
      );
    }
    return this.updateTask(task.id, { owner: author });
  }

  /**
   * Revert the most recent live lane move (`from_lane_id IS NOT NULL AND cause != 'backfill'`)
   * across the board, or on `taskRef` when given. Pops the undone `lane_events` row and
   * moves the card back to `from_lane_id` atomically.
   */
  undoTask(taskRef?: string): UndoResult {
    const targetId = taskRef !== undefined ? this.resolveTask(taskRef).id : undefined;
    return this.tx((): UndoResult => {
      const row = (
        targetId !== undefined
          ? this.q(
              `SELECT * FROM lane_events
               WHERE task_id = ? AND from_lane_id IS NOT NULL AND cause != 'backfill'
               ORDER BY created_at DESC, rowid DESC
               LIMIT 1`,
            ).get(targetId)
          : this.q(
              `SELECT le.* FROM lane_events le
               JOIN tasks t ON t.id = le.task_id
               WHERE le.from_lane_id IS NOT NULL AND le.cause != 'backfill'
               ORDER BY le.created_at DESC, le.rowid DESC
               LIMIT 1`,
            ).get()
      ) as LaneEventRow | null;

      if (!row || !row.from_lane_id) {
        throw new KanbanError(
          targetId !== undefined ? `nothing to undo for task '${targetId}'` : "nothing to undo",
          "conflict",
        );
      }

      const fromLane = this.lanes().find((l) => l.id === row.from_lane_id);
      if (!fromLane) {
        throw new KanbanError(`cannot undo: lane '${row.from_lane_id}' no longer exists`, "conflict");
      }

      this.q("DELETE FROM lane_events WHERE id = ?").run(row.id);

      let previousLane: string | null = null;
      if (fromLane.id === WAITING_LANE_ID) {
        const prev = this.q(
          "SELECT * FROM lane_events WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        ).get(row.task_id) as LaneEventRow | null;
        previousLane = prev && prev.to_lane_id === WAITING_LANE_ID ? (prev.from_lane_id ?? null) : null;
      }

      const position = this.insertPosition(fromLane.id, undefined, row.task_id);
      const now = Date.now();
      this.q(
        "UPDATE tasks SET lane_id = ?, previous_lane = ?, position = ?, updated_at = ? WHERE id = ?",
      ).run(fromLane.id, previousLane, position, now, row.task_id);
      this.renormalizeIfTight(fromLane.id);

      return {
        task: this.resolveTask(row.task_id),
        event: rowToLaneEvent(row),
      };
    });
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
    const delBlockedBy = this.q("DELETE FROM blocked_by WHERE card_id = ? OR blocker_id = ?");
    const delLinks = this.q("DELETE FROM card_links WHERE card_a = ? OR card_b = ?");
    const delGhLinks = this.q("DELETE FROM gh_links WHERE card_id = ?");
    const delCardSessions = this.q("DELETE FROM card_sessions WHERE task_id = ?");
    const delResumeRequests = this.q("DELETE FROM resume_requests WHERE task_id = ?");
    const delElaborationRequests = this.q("DELETE FROM elaboration_requests WHERE task_id = ?");
    const delLaneEvents = this.q("DELETE FROM lane_events WHERE task_id = ?");
    for (const id of [task.id, ...ids]) {
      del.run(id);
      delAttachments.run(id);
      delComments.run(id);
      delBlockedBy.run(id, id);
      delLinks.run(id, id);
      delGhLinks.run(id);
      delCardSessions.run(id);
      delResumeRequests.run(id);
      delElaborationRequests.run(id);
      delLaneEvents.run(id);
    }
    // deleting a card is a child event for its container: an epic in Epics whose
    // last in-flight (or last settled) child just vanished may complete now (ceqfq)
    if (task.parentId !== null) this.autoDoneEpics(task.parentId, true);
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

  /** Direct children still in active lanes (every lane except done/archive), position order. */
  activeChildren(taskRef: string): Task[] {
    const task = this.resolveTask(taskRef);
    return this.childrenOf(task.id).filter((c) => !UNBLOCKED_LANES.includes(c.laneId as any));
  }

  /** Board-health lint findings; empty array = healthy. Pure query — never mutates, never gates. */
  boardViolations(): BoardViolation[] {
    const tasks = this.tasks();
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const lanes = this.lanes();
    const laneIndex = new Map(lanes.map((l, i) => [l.id, i]));
    const violations: BoardViolation[] = [];

    // (a) done parent with children still in flight — same set the epic
    // auto-done uses (ceqfq): Backlog children are defers and never count
    for (const task of tasks) {
      if (task.laneId === "done") {
        const active = this.childrenOf(task.id).filter((c) =>
          (EPIC_BLOCKING_LANES as readonly string[]).includes(c.laneId),
        );
        if (active.length > 0) {
          violations.push({
            kind: "done-parent-active-children",
            cardId: task.id,
            childIds: active.map((t) => t.id),
          });
        }
      }
    }

    // (b) child in a lane behind its parent (active parent only) — an epic in
    // the Epics lane is exempt: its children sit in any lane by design (ceqfq)
    for (const task of tasks) {
      if (task.parentId !== null) {
        const parent = taskMap.get(task.parentId);
        if (parent && !UNBLOCKED_LANES.includes(parent.laneId as any) && parent.laneId !== EPICS_LANE_ID) {
          const childIdx = laneIndex.get(task.laneId);
          const parentIdx = laneIndex.get(parent.laneId);
          if (childIdx !== undefined && parentIdx !== undefined && childIdx < parentIdx) {
            violations.push({
              kind: "child-behind-parent",
              cardId: task.id,
              parentId: task.parentId,
              cardLaneId: task.laneId,
              parentLaneId: parent.laneId,
            });
          }
        }
      }
    }

    // (c) card in Test+Implement/Review with no attached plan
    for (const task of tasks) {
      if (task.laneId === "implement" || task.laneId === "review") {
        if (this.attachment(task.id, "plan") === null) {
          violations.push({
            kind: "missing-plan",
            cardId: task.id,
            laneId: task.laneId,
          });
        }
      }
    }

    // (c2) an epic (has children) drifting in a build lane — it belongs in
    // Epics once approved (ceqfq); Plan is legit, that is where it decomposes
    for (const task of tasks) {
      if (task.laneId === "implement" || task.laneId === "review") {
        if (this.childrenOf(task.id).length > 0) {
          violations.push({ kind: "epic-in-workflow-lane", cardId: task.id, laneId: task.laneId });
        }
      }
    }

    // (d) lane over its WIP limit (advisory; fires only when a limit is set)
    for (const lane of lanes) {
      if (lane.wipLimit === null) continue;
      const count = this.taskCount(lane.id);
      if (count > lane.wipLimit) violations.push({ kind: "wip-over-limit", laneId: lane.id, limit: lane.wipLimit, count });
    }

    return violations;
  }

  // ---------- blocking edges ----------

  /** Direct blockers of a card (edges point dependent → blocker). */
  blockers(ref: string): Task[] {
    const task = this.resolveTask(ref);
    const rows = this.q(
      `SELECT t.* FROM tasks t
       JOIN blocked_by b ON b.blocker_id = t.id
       WHERE b.card_id = ?
       ORDER BY b.rowid`,
    ).all(task.id) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Cards directly blocked by this one. */
  blocking(ref: string): Task[] {
    const task = this.resolveTask(ref);
    const rows = this.q(
      `SELECT t.* FROM tasks t
       JOIN blocked_by b ON b.card_id = t.id
       WHERE b.blocker_id = ?
       ORDER BY b.rowid`,
    ).all(task.id) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** A card is blocked if any direct blocker is outside done or archive (soft blocking). */
  isBlocked(ref: string): boolean {
    return this.blockers(ref).some((b) => !UNBLOCKED_LANES.includes(b.laneId as any));
  }

  /**
   * Replace a card's blocker set (dedupes). Refuses self-edges and any edge that
   * would close a dependency cycle, checked against the graph minus this card's
   * outgoing edges; both refuse with code "conflict".
   */
  setBlockedBy(ref: string, blockerRefs: string[]): void {
    const task = this.resolveTask(ref);
    const blockerTasks = blockerRefs.map((r) => this.resolveTask(r));

    const seen = new Set<string>();
    const uniqueBlockers: Task[] = [];
    for (const b of blockerTasks) {
      if (!seen.has(b.id)) {
        seen.add(b.id);
        uniqueBlockers.push(b);
      }
    }

    for (const b of uniqueBlockers) {
      if (b.id === task.id) {
        throw new KanbanError("cannot block a card with itself", "conflict");
      }
    }

    const getBlockerIds = this.q("SELECT blocker_id FROM blocked_by WHERE card_id = ?");
    for (const b of uniqueBlockers) {
      const visited = new Set<string>();
      const stack = [b.id];
      while (stack.length > 0) {
        const curr = stack.pop()!;
        if (curr === task.id) {
          throw new KanbanError(`dependency cycle detected: card '${task.id}' cannot be blocked by '${b.id}'`, "conflict");
        }
        if (visited.has(curr)) continue;
        visited.add(curr);
        const rows = getBlockerIds.all(curr) as Array<{ blocker_id: string }>;
        for (const row of rows) {
          if (!visited.has(row.blocker_id)) {
            stack.push(row.blocker_id);
          }
        }
      }
    }

    const del = this.q("DELETE FROM blocked_by WHERE card_id = ?");
    const ins = this.q("INSERT INTO blocked_by (card_id, blocker_id, created_at) VALUES (?, ?, ?)");
    const now = Date.now();
    this.tx(() => {
      del.run(task.id);
      for (const b of uniqueBlockers) {
        ins.run(task.id, b.id, now);
      }
      this.q("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, task.id);
    });
  }

  /** Sparse card-id → direct blocker ids, for the board payload and CLI --json. */
  blockedByMap(): Record<string, string[]> {
    const rows = this.q(
      "SELECT card_id, blocker_id FROM blocked_by ORDER BY rowid",
    ).all() as Array<{ card_id: string; blocker_id: string }>;
    const map: Record<string, string[]> = {};
    for (const row of rows) {
      (map[row.card_id] ??= []).push(row.blocker_id);
    }
    return map;
  }

  /**
   * Link two cards (undirected edge). Canonical form: card_a < card_b.
   * Duplicate is a no-op; self-link throws code "invalid".
   * Returns the calling card's linked cards.
   */
  linkCards(aRef: string, bRef: string): Task[] {
    const a = this.resolveTask(aRef);
    const b = this.resolveTask(bRef);
    if (a.id === b.id) {
      throw new KanbanError("cannot link a card to itself", "invalid");
    }
    const [cardA, cardB] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    const now = Date.now();
    const ins = this.q("INSERT OR IGNORE INTO card_links (card_a, card_b, created_at) VALUES (?, ?, ?)");
    const bump = this.q("UPDATE tasks SET updated_at = ? WHERE id = ?");
    this.tx(() => {
      const res = ins.run(cardA, cardB, now);
      if (res.changes > 0) {
        bump.run(now, cardA);
        bump.run(now, cardB);
      }
    });
    return this.linksOf(a.id);
  }

  /**
   * Unlink two cards. Returns true iff an edge was removed.
   * Unknown/ambiguous refs throw resolveTask errors; non-existent link is a no-op returning false.
   */
  unlinkCards(aRef: string, bRef: string): boolean {
    const a = this.resolveTask(aRef);
    const b = this.resolveTask(bRef);
    if (a.id === b.id) return false;
    const [cardA, cardB] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    const del = this.q("DELETE FROM card_links WHERE card_a = ? AND card_b = ?");
    const bump = this.q("UPDATE tasks SET updated_at = ? WHERE id = ?");
    let removed = false;
    this.tx(() => {
      const res = del.run(cardA, cardB);
      if (res.changes > 0) {
        removed = true;
        const now = Date.now();
        bump.run(now, cardA);
        bump.run(now, cardB);
      }
    });
    return removed;
  }

  /** Linked cards of a card as Task[], ordered by link creation time then id. */
  linksOf(ref: string): Task[] {
    const task = this.resolveTask(ref);
    const rows = this.q(
      `SELECT t.* FROM tasks t
       JOIN (
         SELECT card_b AS linked_id, created_at FROM card_links WHERE card_a = ?
         UNION ALL
         SELECT card_a AS linked_id, created_at FROM card_links WHERE card_b = ?
       ) l ON l.linked_id = t.id
       ORDER BY l.created_at, t.id`,
    ).all(task.id, task.id) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Sparse card-id → linked card ids, both directions, for the board payload and CLI --json. */
  linksMap(): Record<string, string[]> {
    const rows = this.q(
      "SELECT card_a, card_b FROM card_links ORDER BY rowid",
    ).all() as Array<{ card_a: string; card_b: string }>;
    const map: Record<string, string[]> = {};
    for (const row of rows) {
      (map[row.card_a] ??= []).push(row.card_b);
      (map[row.card_b] ??= []).push(row.card_a);
    }
    return map;
  }

  // ---------- github links ----------

  /** Attach a GitHub pr/issue to a card; the same url twice on one card is a conflict. */
  attachGhLink(
    taskRef: string,
    ref: { url: string; kind: GhLinkKind; repo: string; number: number },
  ): GhLink {
    const task = this.resolveTask(taskRef);
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newId();
      try {
        this.q(
          "INSERT INTO gh_links (id, card_id, url, kind, repo, number, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(id, task.id, ref.url, ref.kind, ref.repo, ref.number, Date.now());
        const row = this.q("SELECT * FROM gh_links WHERE id = ?").get(id) as GhLinkRow;
        return rowToGhLink(row);
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("UNIQUE"))) throw err;
        // (card_id, url) collision → already linked; id collision (newId) → retry
        const dup = this.q("SELECT * FROM gh_links WHERE card_id = ? AND url = ?").get(task.id, ref.url) as
          | GhLinkRow
          | undefined;
        if (dup) {
          throw new KanbanError(`card '${task.id}' already links ${ref.url}`, "conflict");
        }
      }
    }
    throw new KanbanError("could not attach the GitHub link without an id collision", "conflict");
  }

  /** Remove one GitHub link by its id from a card; true when a row was removed. */
  unlinkGhLinkById(taskRef: string, linkId: string): boolean {
    const task = this.resolveTask(taskRef);
    return this.q("DELETE FROM gh_links WHERE card_id = ? AND id = ?").run(task.id, linkId).changes > 0;
  }

  /** A card's GitHub links, oldest first. */
  ghLinksOf(taskRef: string): GhLink[] {
    const task = this.resolveTask(taskRef);
    return (
      this.q("SELECT * FROM gh_links WHERE card_id = ? ORDER BY created_at, id").all(task.id) as GhLinkRow[]
    ).map(rowToGhLink);
  }

  /** Every GitHub link on the board, grouped by card id — the board payload shape. */
  ghLinksMap(): Record<string, GhLink[]> {
    const rows = this.q("SELECT * FROM gh_links ORDER BY created_at, id").all() as GhLinkRow[];
    const map: Record<string, GhLink[]> = {};
    for (const row of rows) (map[row.card_id] ??= []).push(rowToGhLink(row));
    return map;
  }

  /** Cards linked to one GitHub url (pr/issue state is shared board-wide). */
  ghLinkCards(url: string): Task[] {
    const rows = this.q(
      "SELECT t.* FROM tasks t JOIN gh_links g ON g.card_id = t.id WHERE g.url = ? ORDER BY g.created_at, t.id",
    ).all(url) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Distinct linked GitHub urls board-wide — the sync pass's fetch list. */
  ghUrls(): string[] {
    return (this.q("SELECT DISTINCT url FROM gh_links").all() as Array<{ url: string }>).map((r) => r.url);
  }

  /** Cached live state of one GitHub url, or null when never fetched. */
  ghState(url: string): GhStatus | null {
    const row = this.q("SELECT * FROM gh_state WHERE url = ?").get(url) as GhStateRow | undefined;
    return row ? rowToGhState(row) : null;
  }

  /** Every cached GitHub state, newest fetch first. */
  ghStates(): GhStatus[] {
    return (this.q("SELECT * FROM gh_state ORDER BY fetched_at DESC, url").all() as GhStateRow[]).map(rowToGhState);
  }

  /** Cache one GitHub url's live state (full-row replace — the sync is the only writer). */
  setGhState(row: GhStatus): void {
    this.q(
      "INSERT OR REPLACE INTO gh_state (url, kind, state, title, merged_at, fetched_at, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(row.url, row.kind, row.state, row.title, row.mergedAt, row.fetchedAt, row.error);
  }

  /** Resolve "unknown" link kinds to pr/issue once the first sync has seen the url. */
  setGhLinkKind(url: string, kind: "pr" | "issue"): void {
    this.q("UPDATE gh_links SET kind = ? WHERE url = ? AND kind = 'unknown'").run(kind, url);
  }

  // ---------- attachments ----------

  /** Attach `content` as the next version of `kind` on a card; returns the stored row. */
  attach(taskRef: string, kind: string, content: string, source = ""): Attachment {
    const task = this.resolveTask(taskRef);
    if (!FILE_NAME_RE.test(kind))
      throw new KanbanError(
        `invalid file name '${kind}': lowercase kebab, up to 48 chars, optional extension (e.g. design, repro-log-2.txt)`,
        "invalid",
      );
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

  /** Latest version of every card file on a card, name-ordered — session logs excluded (they have their own section). */
  latestFiles(taskRef: string): Attachment[] {
    const task = this.resolveTask(taskRef);
    return (
      this.q(
        `SELECT a.* FROM attachments a
         JOIN (SELECT kind, MAX(version) AS v FROM attachments WHERE card_id = ? AND kind != 'session' GROUP BY kind) m
           ON a.kind = m.kind AND a.version = m.v
         WHERE a.card_id = ?
         ORDER BY a.kind ASC`,
      )
        .all(task.id, task.id) as AttachmentRow[]
    ).map(rowToAttachment);
  }

  // ---------- waiting state ----------

  /** Cards parked in the waiting lane — the count `next` prints. */
  waitingCount(project?: string): number {
    if (project !== undefined) {
      const row = this.q("SELECT COUNT(*) AS n FROM tasks WHERE lane_id = 'waiting' AND project = ?").get(project) as {
        n: number;
      };
      return row.n;
    }
    const row = this.q("SELECT COUNT(*) AS n FROM tasks WHERE lane_id = 'waiting'").get() as { n: number };
    return row.n;
  }

  /** Why this card waits on the human; null unless it is parked, sits in a workflow lane, or has a dead session. */
  waiting(taskRef: string): WaitingState | null {
    const task = this.resolveTask(taskRef);
    const last = this.comments(task.id).at(-1);
    if (!last) return null;
    if (task.laneId === WAITING_LANE_ID) {
      // parked: classify against the home lane's own rules when it hosts a context
      const home = task.previousLane ? this.laneContext(task.previousLane) : null;
      return waitingFromLastComment(last, home);
    }
    if (waitingFromLastComment(last) === "dead") return "dead";
    const ctx = this.laneContext(task.laneId);
    if (!ctx) return null;
    return waitingFromLastComment(last, ctx);
  }

  /** Waiting state per card (non-null only, workflow or waiting lane, or dead session), keyed by task id — the shape the board payload ships. */
  waitingStates(): Record<string, WaitingState> {
    const contexts = this.laneContexts();
    // MAX(rowid) picks the last-posted comment per card — comments are append-only
    const rows = this.q(
      `SELECT t.id AS task_id, t.lane_id, t.previous_lane, c.author, c.kind, c.body
       FROM tasks t
       JOIN (SELECT card_id, MAX(rowid) AS rid FROM comments GROUP BY card_id) m
         ON m.card_id = t.id
       JOIN comments c ON c.rowid = m.rid`,
    ).all() as Array<{
      task_id: string;
      lane_id: string;
      previous_lane: string | null;
      author: string;
      kind: string;
      body: string;
    }>;
    const out: Record<string, WaitingState> = {};
    for (const r of rows) {
      const last = { author: r.author, kind: r.kind as CommentKind, body: r.body };
      if (waitingFromLastComment(last) === "dead") {
        out[r.task_id] = "dead";
        continue;
      }
      if (r.lane_id === WAITING_LANE_ID) {
        const state = waitingFromLastComment(last, r.previous_lane ? (contexts[r.previous_lane] ?? null) : null);
        if (state) out[r.task_id] = state;
        continue;
      }
      const ctx = contexts[r.lane_id];
      if (!ctx) continue;
      const state = waitingFromLastComment(last, ctx);
      if (state) out[r.task_id] = state;
    }
    return out;
  }

  // ---------- comments ----------

  /** Post a comment with the HITL park/return contract, atomically:
   *  - kind "question" on a card outside waiting/done/archive parks it
   *    (previous_lane ← home lane, lane → waiting), any author;
   *  - a human (non-pi-*) non-question comment on a parked card returns it to
   *    previous_lane and clears it (deleted lane → backlog; no previous_lane → stays);
   *  - done/archive cards are never parked. planReview() shares the park half
   *    of this contract for its pass verdict. */
  comment(taskRef: string, input: { author?: string; kind?: string; body: string }): {
    comment: Comment;
    task: Task;
    moved: "parked" | "returned" | null;
  } {
    let task = this.resolveTask(taskRef);
    let moved: "parked" | "returned" | null = null;
    let createdComment!: Comment;

    this.tx(() => {
      createdComment = this.createComment(task.id, input);
      const isQuestion = createdComment.kind === "question";
      const isHuman = !createdComment.author.startsWith("pi-");

      if (isQuestion && task.laneId !== WAITING_LANE_ID && !UNBLOCKED_LANES.includes(task.laneId as any)) {
        this.parkInWaiting(task.id, task.laneId);
        moved = "parked";
      } else if (task.laneId === WAITING_LANE_ID && task.previousLane && isHuman && !isQuestion) {
        let target = "backlog";
        try {
          target = this.resolveLane(task.previousLane).id;
        } catch {
          target = "backlog";
        }
        this.updateTask(task.id, { lane: target });
        moved = "returned";
      }
      task = this.resolveTask(task.id);
    });

    return { comment: createdComment, task, moved };
  }

  /** Park a card in Waiting on you, remembering its home lane in previous_lane. */
  private parkInWaiting(taskId: string, homeLane: string): void {
    this.updateTask(taskId, { lane: WAITING_LANE_ID });
    this.q("UPDATE tasks SET previous_lane = ? WHERE id = ?").run(homeLane, taskId);
  }

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

  /** Recorded lane-transition and creation events, ordered by (created_at, rowid). */
  laneEvents(taskRef?: string): LaneEvent[] {
    if (taskRef !== undefined) {
      const task = this.resolveTask(taskRef);
      return (
        this.q("SELECT * FROM lane_events WHERE task_id = ? ORDER BY created_at, rowid").all(task.id) as LaneEventRow[]
      ).map(rowToLaneEvent);
    }
    return (
      this.q("SELECT * FROM lane_events ORDER BY created_at, rowid").all() as LaneEventRow[]
    ).map(rowToLaneEvent);
  }

  /** Highest lane_events rowid — the SSE feed cursor's boot value (0 on an empty table). */
  maxLaneEventRowid(): number {
    const row = this.q("SELECT COALESCE(MAX(rowid), 0) AS max FROM lane_events").get() as { max: number };
    return row.max;
  }

  /** Lane events inserted after `afterRowid`, ascending by rowid, joined with the card title (null title = deleted card). */
  laneEventsAfter(afterRowid: number): LaneEventFeedEntry[] {
    return this.q(
      `SELECT le.rowid AS rowid, le.id AS id, le.task_id AS taskId, le.from_lane_id AS fromLaneId,
              le.to_lane_id AS toLaneId, le.cause AS cause, le.actor AS actor, le.created_at AS createdAt,
              t.title AS cardTitle
       FROM lane_events le LEFT JOIN tasks t ON t.id = le.task_id
       WHERE le.rowid > ? ORDER BY le.rowid ASC`,
    ).all(afterRowid) as LaneEventFeedEntry[];
  }

  cardStats(taskRef: string, now: number = Date.now()): CardStats {
    const task = this.resolveTask(taskRef);
    const events = this.laneEvents(task.id);
    const comments = this.comments(task.id);
    const attachments = this.attachments(task.id, "plan").concat(this.attachments(task.id, "session"));
    const boardLanes = this.lanes();
    return computeCardStats(task, events, comments, attachments, boardLanes, now);
  }

  boardStats(now: number = Date.now(), project: string | null = null): BoardStatsPayload {
    const allLanes = this.lanes();
    const allTasks = this.tasks();
    const allEvents = this.laneEvents();
    // A project chip scopes the aggregates; card stats stay global so opening a
    // card never loses its lane times.
    const scopedTasks = project ? allTasks.filter((t) => t.project === project) : allTasks;
    const scopedIds = project ? new Set(scopedTasks.map((t) => t.id)) : null;
    const allComments = (
      this.q("SELECT * FROM comments ORDER BY created_at, rowid").all() as CommentRow[]
    ).map(rowToComment);
    const allAttachments = (
      this.q("SELECT * FROM attachments WHERE kind IN ('plan', 'session') ORDER BY version ASC").all() as AttachmentRow[]
    ).map(rowToAttachment);

    const eventsByTask = new Map<string, LaneEvent[]>();
    for (const e of allEvents) {
      let list = eventsByTask.get(e.taskId);
      if (!list) {
        list = [];
        eventsByTask.set(e.taskId, list);
      }
      list.push(e);
    }

    const commentsByTask = new Map<string, Comment[]>();
    for (const c of allComments) {
      let list = commentsByTask.get(c.taskId);
      if (!list) {
        list = [];
        commentsByTask.set(c.taskId, list);
      }
      list.push(c);
    }

    const attachmentsByTask = new Map<string, Attachment[]>();
    for (const a of allAttachments) {
      let list = attachmentsByTask.get(a.taskId);
      if (!list) {
        list = [];
        attachmentsByTask.set(a.taskId, list);
      }
      list.push(a);
    }

    const cardStatsMap: Record<string, CardStats> = {};
    for (const task of allTasks) {
      cardStatsMap[task.id] = computeCardStats(
        task,
        eventsByTask.get(task.id) ?? [],
        commentsByTask.get(task.id) ?? [],
        attachmentsByTask.get(task.id) ?? [],
        allLanes,
        now,
      );
    }

    const wip = scopedTasks.filter((t) => t.laneId !== "done" && t.laneId !== "archive").length;

    function startOfLocalWeek(ts: number): number {
      const d = new Date(ts);
      d.setHours(0, 0, 0, 0);
      const day = d.getDay();
      const diff = (day + 6) % 7;
      d.setDate(d.getDate() - diff);
      return d.getTime();
    }

    const weekStarts: number[] = [];
    const cur = new Date(startOfLocalWeek(now));
    for (let i = 0; i < 8; i++) {
      weekStarts.unshift(cur.getTime());
      cur.setDate(cur.getDate() - 7);
    }

    const doneCounts = new Array(8).fill(0);
    for (const e of allEvents) {
      if (e.toLaneId === "done" && (!scopedIds || scopedIds.has(e.taskId))) {
        const eWeek = startOfLocalWeek(e.createdAt);
        const idx = weekStarts.indexOf(eWeek);
        if (idx >= 0) {
          doneCounts[idx]++;
        }
      }
    }
    const throughput: ThroughputWeek[] = weekStarts.map((weekStart, i) => ({
      weekStart,
      done: doneCounts[i],
    }));

    const laneVisitors = new Map<string, { totalMs: number; cards: number }>();
    for (const task of scopedTasks) {
      const stats = cardStatsMap[task.id];
      if (!stats) continue;
      for (const lt of stats.laneTimes) {
        const curDwell = laneVisitors.get(lt.laneId) ?? { totalMs: 0, cards: 0 };
        curDwell.totalMs += lt.ms;
        curDwell.cards += 1;
        laneVisitors.set(lt.laneId, curDwell);
      }
    }
    const laneDwell: Record<string, LaneDwellStat> = {};
    for (const [laneId, data] of laneVisitors.entries()) {
      if (data.cards > 0) {
        laneDwell[laneId] = {
          avgMs: Math.round(data.totalMs / data.cards),
          cards: data.cards,
        };
      }
    }

    const projectMap = new Map<string, { total: number; active: number; done: number }>();
    for (const task of scopedTasks) {
      const p = task.project;
      const curP = projectMap.get(p) ?? { total: 0, active: 0, done: 0 };
      curP.total += 1;
      if (task.laneId !== "done" && task.laneId !== "archive") {
        curP.active += 1;
      }
      if (cardStatsMap[task.id]?.reachedDone) {
        curP.done += 1;
      }
      projectMap.set(p, curP);
    }
    const projects: ProjectRow[] = Array.from(projectMap.entries())
      .map(([project, counts]) => ({ project, ...counts }))
      .sort((a, b) => a.project.localeCompare(b.project));

    const reachedDoneStats = scopedTasks
      .map((t) => cardStatsMap[t.id])
      .filter((s): s is CardStats => !!s && s.reachedDone);
    const cycleAvgMs =
      reachedDoneStats.length === 0
        ? null
        : Math.round(reachedDoneStats.reduce((acc, s) => acc + s.cycleMs, 0) / reachedDoneStats.length);

    return {
      board: {
        wip,
        throughput,
        laneDwell,
        projects,
        cycleAvgMs,
      },
      cards: cardStatsMap,
      generatedAt: now,
    };
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
    return this.tx((): { task: Task; comment: Comment } => {
      const note = findings.length > 0 ? `${task.note}\n${findings.map((f) => `- [ ] ${f}`).join("\n")}` : undefined;
      // Entering Test + Implement assigns ownership: a review return goes to the lane's lead actor (never the reviewer); any other handoff to its author.
      const target = this.resolveLane(laneRef);
      const entersImplement = target.id === "implement";
      const moved = this.updateTask(
        task.id,
        {
          ...(note !== undefined ? { note } : {}),
          lane: laneRef,
          ...(entersImplement
            ? {
                owner:
                  input.kind === "review"
                    ? (this.laneContext(target.id)?.actors[0]?.author ?? null)
                    : input.author?.trim() || "user",
              }
            : {}),
        },
        { cause: input.kind === "review" ? "review" : "handoff", actor: input.author?.trim() || "user" },
      );
      const comment = this.createComment(task.id, { author: input.author, kind, body: input.message });
      return { task: moved, comment };
    });
  }

  /** The card's workflow lane: where it sits, or the lane it's parked from; null when none. */
  private workflowLaneOf(task: Task): Lane | null {
    const homeId = task.laneId === WAITING_LANE_ID ? task.previousLane : task.laneId;
    if (!homeId) return null;
    try {
      return this.resolveLane(homeId);
    } catch {
      return null; // parked from a since-deleted lane
    }
  }

  /** True when the card sits at a human gate: its home lane hosts a context with a gate (card 3n96c). */
  private atPlanGate(task: Task): boolean {
    const home = this.workflowLaneOf(task);
    return home !== null && this.laneContext(home.id)?.gate !== undefined;
  }

  /** The plan gate: approve the card's attached plan — comment + move to the gate's target lane, atomically. */
  approveTask(taskRef: string, input: { author?: string; message?: string } = {}): { task: Task; comment: Comment } {
    const task = this.resolveTask(taskRef);
    const home = this.workflowLaneOf(task);
    const ctx = home ? this.laneContext(home.id) : null;
    if (!ctx?.gate) {
      throw new KanbanError(`card '${task.id}' is not in the plan lane (it is in '${task.laneId}')`, "conflict");
    }
    const artifactName = ctx.gate.requireArtifact ?? ctx.artifact;
    const artifact = artifactName ? this.attachment(task.id, artifactName) : null;
    if (ctx.gate.requireArtifact && !artifact) {
      throw new KanbanError(`card '${task.id}' has no attached ${ctx.gate.requireArtifact} to approve`, "conflict");
    }
    const body =
      input.message?.trim() ||
      (artifact
        ? this.childrenOf(task.id).length > 0
          ? `${artifactName} v${artifact.version} approved — decomposition locked, epic now supervising in Epics`
          : `${artifactName} v${artifact.version} approved — build it`
        : "approved — build it");
    return this.tx((): { task: Task; comment: Comment } => {
      // An epic's approval parks it in the container lane, unarmed — the epic
      // plans work, it never builds (ceqfq); a childless card arms as before.
      const isEpic = this.childrenOf(task.id).length > 0;
      const moved = this.updateTask(
        task.id,
        { lane: isEpic ? EPICS_LANE_ID : ctx.gate!.approveTarget },
        { cause: "approve", actor: input.author?.trim() || "user" },
      );
      // after the lane change (whose exit rule clears stale owners), the gate
      // arms its actor: approveOwner or none (an epic stays unarmed)
      const task2 = this.updateTask(task.id, { owner: isEpic ? null : (ctx.gate!.approveOwner ?? null) });
      const comment = this.createComment(task.id, {
        author: input.author,
        kind: "approval",
        body,
      });
      return { task: task2, comment };
    });
  }

  /** The other gate arm: reject with feedback — comment stays, card ends back in its home lane (a parked card returns first); the feedback steers the next pass. */
  rejectTask(taskRef: string, message: string, input: { author?: string } = {}): { task: Task; comment: Comment; returned: boolean } {
    const task = this.resolveTask(taskRef);
    const home = this.workflowLaneOf(task);
    const ctx = home ? this.laneContext(home.id) : null;
    if (!ctx?.gate) {
      throw new KanbanError(`card '${task.id}' is not in the plan lane (it is in '${task.laneId}')`, "conflict");
    }
    const body = message.trim();
    if (!body) throw new KanbanError("rejection feedback must not be empty — it steers the next plan", "invalid");
    const prefix = ctx.gate.rejectPrefix ?? `${ctx.gate.requireArtifact ?? ctx.artifact ?? home!.id} rejected`;
    return this.tx((): { task: Task; comment: Comment; returned: boolean } => {
      const returned = task.laneId === WAITING_LANE_ID;
      const task2 = returned ? this.updateTask(task.id, { lane: home!.id }) : task;
      const comment = this.createComment(task.id, { author: input.author, kind: "rejection", body: `${prefix}: ${body}` });
      return { task: task2, comment, returned };
    });
  }

  /** Plan-review verdict prefixes — the autoreview loop arms on these exact strings. */
  static readonly PLAN_REVIEW_PASS = "plan review: pass";
  static readonly PLAN_REVIEW_BLOCK = "plan review: block";
  /** Prefix of the plan-review cap comment body — autoreview builds its body from this. */
  static readonly PLAN_REVIEW_CAP = "plan review cap reached";
  /** Prefix of agent session-death failure comments — board waiting state keys on this. */
  static readonly SESSION_DIED_PREFIX = "session died: ";
  /** Prefix of agent session-resumed start comments — board waiting state clears on this. */
  static readonly SESSION_RESUMED_PREFIX = "session resumed: ";

  /** The lane reviewer's verdict (card 3n96c): pass parks the card in Waiting on you at the human
   *  gate (previous_lane ← home lane); block leaves it in the lane for the re-armed first actor.
   *  Any lane whose context carries an artifact or a 2+ actor chain supports the verdict. */
  planReview(
    taskRef: string,
    input: { verdict: "pass" | "block"; message?: string; findings?: string[]; author?: string },
  ): { comment: Comment; task: Task } {
    const task = this.resolveTask(taskRef);
    const ctx = this.laneContext(task.laneId);
    if (!ctx || (ctx.artifact === undefined && ctx.actors.length < 2)) {
      throw new KanbanError(`card '${task.id}' is not in the plan lane (it is in '${task.laneId}')`, "conflict");
    }
    const artifactName = ctx.artifact ?? "plan";
    if (!this.attachment(task.id, artifactName)) {
      throw new KanbanError(`card '${task.id}' has no attached ${artifactName} to review`, "conflict");
    }
    const message = input.message?.trim() ?? "";
    const findings = (input.findings ?? []).map((f) => f.trim()).filter(Boolean);
    if (!message && (input.verdict === "pass" || findings.length === 0)) {
      throw new KanbanError("plan review needs a message (block: message or findings)", "invalid");
    }
    const prefix = input.verdict === "pass" ? KanbanDb.PLAN_REVIEW_PASS : KanbanDb.PLAN_REVIEW_BLOCK;
    const body = `${prefix}${message ? ` — ${message}` : ""}${findings.map((f) => `\n- ${f}`).join("")}`;
    return this.tx((): { comment: Comment; task: Task } => {
      const comment = this.createComment(task.id, { author: input.author, kind: "review", body });
      if (input.verdict === "pass") this.parkInWaiting(task.id, task.laneId);
      return { comment, task: this.resolveTask(task.id) };
    });
  }

  // ---------- card sessions & resume requests ----------

  cardSession(taskRef: string): { role: AgentRole; sessionId: string } | null {
    let taskId = taskRef;
    try {
      taskId = this.resolveTask(taskRef).id;
    } catch {
      /* task may have been deleted */
    }
    const row = this.q("SELECT role, session_id FROM card_sessions WHERE task_id = ?").get(taskId) as
      | { role: AgentRole; session_id: string }
      | undefined;
    return row ? { role: row.role, sessionId: row.session_id } : null;
  }

  setCardSession(taskId: string, role: AgentRole, sessionId: string): void {
    const task = this.resolveTask(taskId);
    this.q(
      `INSERT INTO card_sessions (task_id, role, session_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET role = excluded.role, session_id = excluded.session_id, updated_at = excluded.updated_at`,
    ).run(task.id, role, sessionId, Date.now());
  }

  queueResume(taskRef: string): void {
    const task = this.resolveTask(taskRef);
    this.q(
      `INSERT INTO resume_requests (task_id, requested_at) VALUES (?, ?)
       ON CONFLICT(task_id) DO UPDATE SET requested_at = excluded.requested_at`,
    ).run(task.id, Date.now());
  }

  resumeRequests(): Array<{ taskId: string; requestedAt: number }> {
    const rows = this.q("SELECT task_id, requested_at FROM resume_requests ORDER BY requested_at ASC").all() as Array<{
      task_id: string;
      requested_at: number;
    }>;
    return rows.map((r) => ({ taskId: r.task_id, requestedAt: r.requested_at }));
  }

  clearResumeRequest(taskId: string): void {
    this.q("DELETE FROM resume_requests WHERE task_id = ?").run(taskId);
  }

  queueElaboration(taskRef: string): void {
    const task = this.resolveTask(taskRef);
    this.q(
      `INSERT INTO elaboration_requests (task_id, requested_at) VALUES (?, ?)
       ON CONFLICT(task_id) DO UPDATE SET requested_at = excluded.requested_at`,
    ).run(task.id, Date.now());
  }

  elaborationRequests(): Array<{ taskId: string; requestedAt: number }> {
    const rows = this.q("SELECT task_id, requested_at FROM elaboration_requests ORDER BY requested_at ASC").all() as Array<{
      task_id: string;
      requested_at: number;
    }>;
    return rows.map((r) => ({ taskId: r.task_id, requestedAt: r.requested_at }));
  }

  clearElaboration(taskId: string): void {
    this.q("DELETE FROM elaboration_requests WHERE task_id = ?").run(taskId);
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

  /** Board-level cap on total in-flight agent sessions across all pool slots + default slot; absent or corrupt row falls back to 12. */
  maxWorkers(): number {
    const row = this.q("SELECT value FROM board_state WHERE key = 'max_workers'").get() as { value: string } | undefined;
    if (!row) return 12;
    const n = Number(row.value);
    return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 12;
  }

  setMaxWorkers(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > 20) {
      throw new KanbanError("max workers must be between 1 and 20", "invalid");
    }
    this.q(
      "INSERT INTO board_state (key, value) VALUES ('max_workers', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(n));
    return this.maxWorkers();
  }

  /** Harness master switch (Providers rail): an engine spawns only when its harness is enabled too. Absent row = enabled. */
  harnessEnabled(id: string): boolean {
    const row = this.q("SELECT value FROM board_state WHERE key = ?").get(`harness_off:${id}`) as
      | { value: string }
      | undefined;
    return row?.value !== "1";
  }

  setHarnessEnabled(id: string, enabled: boolean): void {
    if (enabled) this.q("DELETE FROM board_state WHERE key = ?").run(`harness_off:${id}`);
    else
      this.q("INSERT INTO board_state (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run(
        `harness_off:${id}`,
      );
  }

  /** Days a card sits in Done before the sweep archives it; absent or corrupt row falls back to 7. 0 disables the sweep. */
  autoArchiveDays(): number {
    const row = this.q("SELECT value FROM board_state WHERE key = 'auto_archive_days'").get() as
      | { value: string }
      | undefined;
    if (!row) return 7;
    const n = Number(row.value);
    return Number.isInteger(n) && n >= 0 && n <= 365 ? n : 7;
  }

  setAutoArchiveDays(n: number): number {
    if (!Number.isInteger(n) || n < 0 || n > 365) {
      throw new KanbanError("auto-archive days must be between 0 and 365", "invalid");
    }
    this.q(
      "INSERT INTO board_state (key, value) VALUES ('auto_archive_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(n));
    return this.autoArchiveDays();
  }

  /** The board chat drawer's last-used project scope; absent or empty reads as the whole board (null). */
  managerChatProject(): string | null {
    const row = this.q("SELECT value FROM board_state WHERE key = 'manager_chat_project'").get() as
      | { value: string }
      | undefined;
    const value = row?.value.trim() ?? "";
    return value === "" ? null : value;
  }

  /** Persist the drawer's project scope; null or "" clears it. Existence validation is the route's job. */
  setManagerChatProject(project: string | null): string | null {
    const clean = project?.trim() ?? "";
    if (clean === "") {
      this.q("DELETE FROM board_state WHERE key = 'manager_chat_project'").run();
    } else {
      this.q(
        "INSERT INTO board_state (key, value) VALUES ('manager_chat_project', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(clean);
    }
    return this.managerChatProject();
  }

  /** Done cards whose latest done-entry (fallback updated_at) is at least autoArchiveDays() old; [] when disabled. */
  dueForAutoArchive(now: number = Date.now()): Task[] {
    const days = this.autoArchiveDays();
    if (days === 0) return [];
    const cutoff = now - days * 86_400_000;
    return this.q(
      `SELECT t.* FROM tasks t
       WHERE t.lane_id = 'done'
         AND COALESCE((SELECT MAX(le.created_at) FROM lane_events le
                       WHERE le.task_id = t.id AND le.to_lane_id = 'done'), t.updated_at) <= ?
       ORDER BY t.created_at, t.id`,
    ).all(cutoff) as Task[];
  }

  // ---------- agent session leases ----------
  // One agent works a card at a time — across every server process. A loop takes
  // the lease before spawning and releases it when the session ends; a lease
  // whose heartbeat went stale (owner killed hard, no graceful release) is
  // reclaimable by any other process.

  tryTakeLease(taskId: string, role: string, owner: LeaseOwner, staleAfterMs: number): boolean {
    const now = Date.now();
    return this.tx((): boolean => {
      const row = this.q("SELECT heartbeat_at FROM agent_leases WHERE task_id = ?").get(taskId) as
        | { heartbeat_at: number }
        | undefined;
      if (row && now - row.heartbeat_at < staleAfterMs) return false; // a live owner holds it
      this.q(
        "INSERT OR REPLACE INTO agent_leases (task_id, role, owner_pid, boot_id, heartbeat_at) VALUES (?, ?, ?, ?, ?)",
      ).run(taskId, role, owner.pid, owner.bootId, now);
      return true;
    });
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

  listLeases(): AgentLease[] {
    const rows = this.q("SELECT * FROM agent_leases").all() as {
      task_id: string;
      role: string;
      owner_pid: number;
      boot_id: number;
      heartbeat_at: number;
    }[];
    return rows.map((row) => ({
      taskId: row.task_id,
      role: row.role,
      ownerPid: row.owner_pid,
      bootId: row.boot_id,
      heartbeatAt: row.heartbeat_at,
    }));
  }

  /** Full replace of a role's config; empty strings/arrays drop out. */
  setAgentConfig(role: string, config: AgentConfig): AgentConfig {
    if (!AGENT_CONFIG_ROLES.has(role) && !this.hasLaneActor(role)) {
      throw new KanbanError(`unknown agent role '${role}' (reviewer | builder | planner | plan-reviewer | elaborator | manager | worker)`, "invalid");
    }
    const clean = this.cleanAgentConfig(config);
    this.tx(() => {
      this.writeAgentConfigRow(role, clean);
      // keep lane actors with the same id in sync — both surfaces view one state (card 3n96c)
      const rows = this.q("SELECT id, context FROM lanes WHERE context IS NOT NULL").all() as Array<{
        id: string;
        context: string;
      }>;
      for (const row of rows) {
        let ctx: LaneContext;
        try {
          ctx = JSON.parse(row.context) as LaneContext;
        } catch {
          continue;
        }
        const hit = ctx.actors.find((a) => a.id === role);
        if (!hit) continue;
        if (Object.keys(clean).length > 0) hit.config = clean;
        else delete hit.config;
        this.q("UPDATE lanes SET context = ? WHERE id = ?").run(JSON.stringify(ctx), row.id);
      }
    });
    return this.agentConfig(role)!;
  }

  /** True when some lane's context hosts an actor with this id (custom roles are valid configs). */
  private hasLaneActor(role: string): boolean {
    const rows = this.q("SELECT context FROM lanes WHERE context IS NOT NULL").all() as Array<{ context: string }>;
    for (const row of rows) {
      try {
        if ((JSON.parse(row.context) as LaneContext).actors.some((a) => a.id === role)) return true;
      } catch {
        /* corrupt row reads as plain */
      }
    }
    return false;
  }

  /** Strip empty strings/arrays from an agent config (the stored shape). */
  private cleanAgentConfig(config: AgentConfig): AgentConfig {
    const clean: AgentConfig = {};
    const runsOn = this.cleanRunsOn(config.runsOn ?? []);
    if (runsOn.length > 0) clean.runsOn = runsOn;
    const skills = (config.skills ?? []).map((s) => s.trim()).filter(Boolean);
    if (skills.length > 0) clean.skills = skills;
    if (config.context?.trim()) clean.context = config.context.trim();
    if (config.tools?.trim()) clean.tools = config.tools.trim();
    const extraArgs = (config.extraArgs ?? []).map((a) => a.trim()).filter(Boolean);
    if (extraArgs.length > 0) clean.extraArgs = extraArgs;
    if (config.timeoutMs !== undefined) clean.timeoutMs = config.timeoutMs;
    return clean;
  }

  /** The raw agent_configs upsert (callers handle validation and syncing). */
  private writeAgentConfigRow(role: string, clean: AgentConfig): void {
    this.q(
      `INSERT INTO agent_configs (role, config, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(role) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
    ).run(role, JSON.stringify(clean), Date.now());
  }

  /** Trimmed, deduped engine ids; an id that names no engine throws (a lineup never dangles). */
  private cleanRunsOn(runsOn: string[]): string[] {
    const ids: string[] = [];
    for (const raw of runsOn) {
      const id = raw.trim();
      if (!id || ids.includes(id)) continue;
      if (!this.engine(id)) throw new KanbanError(`unknown engine '${id}'`, "invalid");
      ids.push(id);
    }
    return ids;
  }

  // ---------- engines ----------

  private engineFromRow(r: { id: string; config: string; updated_at: number }): Engine | null {
    let parsed: Partial<Engine>;
    try {
      parsed = JSON.parse(r.config) as Partial<Engine>;
    } catch {
      return null; // a corrupt row reads as absent — one bad blob never stops the loop
    }
    const e: Engine = {
      id: r.id,
      name: parsed.name ?? r.id,
      harness: parsed.harness === "claude" ? "claude" : "pi",
      flags: Array.isArray(parsed.flags) ? parsed.flags : [],
      seats: Number.isInteger(parsed.seats) ? parsed.seats! : 1,
      enabled: parsed.enabled !== false,
      updatedAt: r.updated_at,
    };
    if (parsed.provider) e.provider = parsed.provider;
    if (parsed.model) e.model = parsed.model;
    if (parsed.thinking) e.thinking = parsed.thinking;
    return e;
  }

  /** Every engine, in registry order (position, then creation). */
  engines(): Engine[] {
    const rows = this.q("SELECT id, config, updated_at FROM engines ORDER BY position, rowid").all() as Array<{
      id: string;
      config: string;
      updated_at: number;
    }>;
    return rows.map((r) => this.engineFromRow(r)).filter((e): e is Engine => e !== null);
  }

  engine(id: string): Engine | null {
    const row = this.q("SELECT id, config, updated_at FROM engines WHERE id = ?").get(id) as
      | { id: string; config: string; updated_at: number }
      | null;
    return row ? this.engineFromRow(row) : null;
  }

  /**
   * Create or fully replace an engine. Coherence is enforced here: a claude
   * engine has no provider (claude resolves its own auth) and its thinking is
   * a Claude Code effort level (CLAUDE_EFFORT_LEVELS); seats are
   * 1–MAX_ENGINE_SEATS; names are unique (case-insensitive) so the CLI can
   * address engines by name. An update keeps its registry position.
   */
  setEngine(id: string, input: EngineInput): Engine {
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)) {
      throw new KanbanError(`engine id '${id}' must be lowercase kebab, up to 48 chars`, "invalid");
    }
    const name = input.name?.trim() ?? "";
    if (!name || name.length > 60) throw new KanbanError("engine name must be 1-60 characters", "invalid");
    if (input.harness !== "pi" && input.harness !== "claude") {
      throw new KanbanError("engine harness must be pi or claude", "invalid");
    }
    const provider = input.provider?.trim() ?? "";
    const model = input.model?.trim() ?? "";
    const thinking = input.thinking ?? "";
    if (input.harness === "claude" && provider) {
      throw new KanbanError("a claude engine takes no provider — claude resolves its own login", "invalid");
    }
    if (input.harness === "claude" && thinking && !(CLAUDE_EFFORT_LEVELS as readonly string[]).includes(thinking)) {
      throw new KanbanError(`claude effort must be one of ${CLAUDE_EFFORT_LEVELS.join(", ")}`, "invalid");
    }
    if (thinking && !(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as string[]).includes(thinking)) {
      throw new KanbanError(`unknown thinking level '${thinking}'`, "invalid");
    }
    const seats = input.seats ?? 1;
    if (!Number.isInteger(seats) || seats < 1 || seats > MAX_ENGINE_SEATS) {
      throw new KanbanError(`engine seats must be between 1 and ${MAX_ENGINE_SEATS}`, "invalid");
    }
    for (const other of this.engines()) {
      if (other.id !== id && other.name.toLowerCase() === name.toLowerCase()) {
        throw new KanbanError(`engine name '${name}' is taken`, "invalid");
      }
    }
    const cfg: Record<string, unknown> = {
      name,
      harness: input.harness,
      flags: (input.flags ?? []).map((f) => f.trim()).filter(Boolean),
      seats,
      enabled: input.enabled !== false,
    };
    if (provider) cfg.provider = provider;
    if (model) cfg.model = model;
    if (thinking) cfg.thinking = thinking;
    const now = Date.now();
    this.tx(() => {
      const next = (this.q("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM engines").get() as { p: number }).p;
      this.q(
        `INSERT INTO engines (id, position, config, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
      ).run(id, next, JSON.stringify(cfg), now);
    });
    return this.engine(id)!;
  }

  /** Delete an engine and drop it from every lineup, override, and the board default. */
  deleteEngine(id: string): void {
    if (!this.engine(id)) throw new KanbanError(`engine ${id} not found`, "not-found");
    this.tx(() => {
      this.q("DELETE FROM engines WHERE id = ?").run(id);
      const drop = (cfg: AgentConfig): boolean => {
        if (!cfg.runsOn?.includes(id)) return false;
        cfg.runsOn = cfg.runsOn.filter((x) => x !== id);
        if (cfg.runsOn.length === 0) delete cfg.runsOn;
        return true;
      };
      for (const r of this.q("SELECT role, config FROM agent_configs").all() as Array<{ role: string; config: string }>) {
        try {
          const cfg = JSON.parse(r.config) as AgentConfig;
          if (drop(cfg)) this.q("UPDATE agent_configs SET config = ? WHERE role = ?").run(JSON.stringify(cfg), r.role);
        } catch {
          /* corrupt row stays as is */
        }
      }
      for (const r of this.q("SELECT id, context FROM lanes WHERE context IS NOT NULL").all() as Array<{ id: string; context: string }>) {
        try {
          const ctx = JSON.parse(r.context) as LaneContext;
          let changed = false;
          for (const a of ctx.actors) {
            if (a.config && drop(a.config)) {
              changed = true;
              if (Object.keys(a.config).length === 0) delete a.config;
            }
          }
          if (changed) this.q("UPDATE lanes SET context = ? WHERE id = ?").run(JSON.stringify(ctx), r.id);
        } catch {
          /* corrupt row stays as is */
        }
      }
      for (const r of this.q("SELECT project, actor, config FROM project_agent_configs").all() as Array<{
        project: string;
        actor: string;
        config: string;
      }>) {
        try {
          const cfg = JSON.parse(r.config) as AgentConfig;
          if (drop(cfg)) {
            this.q("UPDATE project_agent_configs SET config = ? WHERE project = ? AND actor = ?").run(JSON.stringify(cfg), r.project, r.actor);
          }
        } catch {
          /* corrupt row stays as is */
        }
      }
      if (this.defaultEngineId() === null) {
        this.q("DELETE FROM board_state WHERE key = 'default_engine' AND value = ?").run(id);
      }
    });
  }

  /** Rewrite the registry order; ids must be exactly the existing set. */
  reorderEngines(ids: string[]): Engine[] {
    const current = this.engines().map((e) => e.id);
    const unique = new Set(ids);
    if (unique.size !== ids.length || ids.length !== current.length || current.some((id) => !unique.has(id))) {
      throw new KanbanError("engine order must list every engine exactly once", "invalid");
    }
    this.tx(() => {
      ids.forEach((id, i) => this.q("UPDATE engines SET position = ? WHERE id = ?").run(i, id));
    });
    return this.engines();
  }

  /** The engine an empty lineup runs on; null = the built-in "pi default" (pi's own settings, one seat). */
  defaultEngineId(): string | null {
    const row = this.q("SELECT value FROM board_state WHERE key = 'default_engine'").get() as { value: string } | undefined;
    return row && this.engine(row.value) ? row.value : null;
  }

  setDefaultEngine(id: string | null): string | null {
    if (id === null) {
      this.q("DELETE FROM board_state WHERE key = 'default_engine'").run();
      return null;
    }
    if (!this.engine(id)) throw new KanbanError(`unknown engine '${id}'`, "invalid");
    this.q(
      "INSERT INTO board_state (key, value) VALUES ('default_engine', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(id);
    return id;
  }

  // ---------- lane workers ----------
  // Queue-as-rows (the resume_requests pattern): the CLI and the board manager
  // enqueue runs here; the serve-process runner drains them. Rows survive
  // restarts; a run lost mid-flight is failed at boot with an explicit reason.

  private rowToLaneWorker(r: {
    id: string;
    lane_id: string;
    focus: string | null;
    status: string;
    session_id: string | null;
    summary: string | null;
    exit_info: string | null;
    log: string | null;
    requested_by: string;
    created_at: number;
    started_at: number | null;
    ended_at: number | null;
  }): LaneWorkerRun {
    const run: LaneWorkerRun = {
      id: r.id,
      laneId: r.lane_id,
      status: r.status as LaneWorkerRun["status"],
      requestedBy: r.requested_by,
      createdAt: r.created_at,
    };
    if (r.focus !== null) run.focus = r.focus;
    if (r.session_id !== null) run.sessionId = r.session_id;
    if (r.summary !== null) run.summary = r.summary;
    if (r.exit_info !== null) run.exitInfo = r.exit_info;
    if (r.log !== null) run.log = r.log;
    if (r.started_at !== null) run.startedAt = r.started_at;
    if (r.ended_at !== null) run.endedAt = r.ended_at;
    return run;
  }

  queueLaneWorker(input: { laneId: string; focus?: string; requestedBy?: string }): LaneWorkerRun {
    const focus = input.focus?.trim();
    if (focus !== undefined && focus !== "" && focus.length > 2000) {
      throw new KanbanError("worker focus must be at most 2000 characters", "invalid");
    }
    const now = Date.now();
    const id = newId();
    this.q(
      "INSERT INTO lane_workers (id, lane_id, focus, status, requested_by, created_at) VALUES (?, ?, ?, 'queued', ?, ?)",
    ).run(id, input.laneId, focus || null, input.requestedBy?.trim() || "user", now);
    return this.laneWorker(id)!;
  }

  laneWorkers(filter?: { status?: string; laneId?: string; limit?: number }): LaneWorkerRun[] {
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (filter?.status) {
      clauses.push("status = ?");
      args.push(filter.status);
    }
    if (filter?.laneId) {
      clauses.push("lane_id = ?");
      args.push(filter.laneId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    args.push(filter?.limit ?? 50);
    return (
      this.q(`SELECT * FROM lane_workers${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args) as never[]
    ).map((r) => this.rowToLaneWorker(r));
  }

  laneWorker(id: string): LaneWorkerRun | null {
    const row = this.q("SELECT * FROM lane_workers WHERE id = ?").get(id) as
      | Parameters<KanbanDb["rowToLaneWorker"]>[0]
      | undefined;
    return row ? this.rowToLaneWorker(row) : null;
  }

  /** Only a queued row flips to running; a lost race (another process claimed it) returns null. */
  claimLaneWorker(id: string, sessionId: string, now: number): LaneWorkerRun | null {
    return this.tx((): LaneWorkerRun | null => {
      const row = this.q("SELECT status FROM lane_workers WHERE id = ?").get(id) as { status: string } | undefined;
      if (!row || row.status !== "queued") return null;
      this.q("UPDATE lane_workers SET status = 'running', session_id = ?, started_at = ? WHERE id = ?").run(
        sessionId,
        now,
        id,
      );
      return this.laneWorker(id);
    });
  }

  /** Only a running row settles; the runner is the only caller. */
  finishLaneWorker(
    id: string,
    out: { status: "done" | "failed"; summary?: string; exitInfo?: string; log?: string },
    now: number,
  ): LaneWorkerRun | null {
    return this.tx((): LaneWorkerRun | null => {
      const row = this.q("SELECT status FROM lane_workers WHERE id = ?").get(id) as { status: string } | undefined;
      if (!row || row.status !== "running") return null;
      this.q(
        "UPDATE lane_workers SET status = ?, summary = ?, exit_info = ?, log = ?, ended_at = ? WHERE id = ?",
      ).run(out.status, out.summary ?? null, out.exitInfo ?? null, out.log ?? null, now, id);
      return this.laneWorker(id);
    });
  }

  /** Boot-time reap: every running row is orphaned once its server is gone. Returns how many were reaped. */
  failRunningLaneWorkers(reason: string): number {
    return this.tx((): number => {
      const info = this.q(
        "UPDATE lane_workers SET status = 'failed', exit_info = ?, ended_at = ? WHERE status = 'running'",
      ).run(reason, Date.now());
      return info.changes;
    });
  }

  /**
   * What a lane worker starts from: the lane's cards in lane order, each with
   * its park age (days since the last entry into this lane), priority, and the
   * soft-block flag. Capped, so the prompt stays affordable.
   */
  laneSnapshot(laneId: string, cap = 40, now = Date.now()): LaneSnapshot {
    const rows = this.q(
      `SELECT t.id, t.title, t.priority,
              COALESCE((SELECT MAX(le.created_at) FROM lane_events le
                        WHERE le.task_id = t.id AND le.to_lane_id = t.lane_id), t.created_at) AS entry_at,
              EXISTS(SELECT 1 FROM blocked_by b JOIN tasks blocker ON blocker.id = b.blocker_id
                     WHERE b.card_id = t.id AND blocker.lane_id NOT IN ('done', 'archive')) AS is_blocked
       FROM tasks t WHERE t.lane_id = ? ORDER BY t.position, t.created_at`,
    ).all(laneId) as Array<{ id: string; title: string; priority: string; entry_at: number; is_blocked: number }>;
    const cards = rows.slice(0, cap).map((r) => ({
      id: r.id,
      title: r.title.length > 80 ? r.title.slice(0, 80) : r.title,
      ageDays: Math.max(0, Math.floor((now - r.entry_at) / 86_400_000)),
      priority: r.priority,
      blocked: r.is_blocked === 1,
    }));
    return { laneId, total: rows.length, truncated: rows.length > cap, cards };
  }

  /** The board manager's opening view: every lane except archive, aging, the longest-parked waiting cards, what's next. */
  boardOverview(now = Date.now()): BoardOverview {
    const lanes = this.lanes().filter((l) => l.id !== "archive");
    const counts = new Map<string, number>();
    const oldest = new Map<string, number>();
    for (const lane of lanes) {
      const snap = this.laneSnapshot(lane.id, Number.MAX_SAFE_INTEGER, now);
      counts.set(lane.id, snap.total);
      oldest.set(lane.id, snap.cards.reduce((m, c) => Math.max(m, c.ageDays), 0));
    }
    const waiting = (
      this.q(
        `SELECT t.id, t.title,
                COALESCE((SELECT MAX(le.created_at) FROM lane_events le
                          WHERE le.task_id = t.id AND le.to_lane_id = t.lane_id), t.created_at) AS entry_at
         FROM tasks t WHERE t.lane_id = 'waiting' ORDER BY entry_at ASC, t.created_at ASC, t.id ASC LIMIT 10`,
      ).all() as Array<{ id: string; title: string; entry_at: number }>
    ).map((r) => ({
      id: r.id,
      title: r.title.length > 80 ? r.title.slice(0, 80) : r.title,
      ageDays: Math.max(0, Math.floor((now - r.entry_at) / 86_400_000)),
    }));
    const next = this.nextTask();
    return {
      lanes: lanes.map((l) => ({ id: l.id, name: l.name, count: counts.get(l.id) ?? 0, oldestDays: oldest.get(l.id) ?? 0 })),
      waiting,
      next: next.task ? { id: next.task.id, title: next.task.title } : null,
      blocked: next.blocked,
    };
  }

  /** The board manager's opening view scoped to one project: boardOverview's shape over that project's cards only. */
  projectOverview(project: string, now = Date.now()): BoardOverview {
    const lanes = this.lanes().filter((l) => l.id !== "archive");
    const counts = new Map<string, number>();
    const oldest = new Map<string, number>();
    for (const lane of lanes) {
      const row = this.q(
        `SELECT COUNT(*) AS n,
                MAX(COALESCE((SELECT MAX(le.created_at) FROM lane_events le
                              WHERE le.task_id = t.id AND le.to_lane_id = t.lane_id), t.created_at)) AS oldest_entry
         FROM tasks t WHERE t.lane_id = ? AND t.project = ?`,
      ).get(lane.id, project) as { n: number; oldest_entry: number | null };
      counts.set(lane.id, row.n);
      oldest.set(
        lane.id,
        row.n > 0 && row.oldest_entry !== null ? Math.max(0, Math.floor((now - row.oldest_entry) / 86_400_000)) : 0,
      );
    }
    const waiting = (
      this.q(
        `SELECT t.id, t.title,
                COALESCE((SELECT MAX(le.created_at) FROM lane_events le
                          WHERE le.task_id = t.id AND le.to_lane_id = t.lane_id), t.created_at) AS entry_at
         FROM tasks t WHERE t.lane_id = 'waiting' AND t.project = ?
         ORDER BY entry_at ASC, t.created_at ASC, t.id ASC LIMIT 10`,
      ).all(project) as Array<{ id: string; title: string; entry_at: number }>
    ).map((r) => ({
      id: r.id,
      title: r.title.length > 80 ? r.title.slice(0, 80) : r.title,
      ageDays: Math.max(0, Math.floor((now - r.entry_at) / 86_400_000)),
    }));
    const next = this.nextTask(project);
    return {
      lanes: lanes.map((l) => ({ id: l.id, name: l.name, count: counts.get(l.id) ?? 0, oldestDays: oldest.get(l.id) ?? 0 })),
      waiting,
      next: next.task ? { id: next.task.id, title: next.task.title } : null,
      blocked: next.blocked,
    };
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
    if (patch.wipLimit !== undefined && patch.wipLimit !== null && !(Number.isInteger(patch.wipLimit) && patch.wipLimit >= 1 && patch.wipLimit <= 999))
      throw new KanbanError("wip limit must be an integer from 1 to 999 (or null to clear)", "invalid");
    const wipLimit = patch.wipLimit === undefined ? lane.wipLimit : patch.wipLimit;
    if (patch.index !== undefined && patch.before !== undefined)
      throw new KanbanError("pass either index or before, not both", "invalid");
    const reordering = patch.index !== undefined || patch.before !== undefined;
    if (reordering && lane.fixed)
      throw new KanbanError(`lane '${lane.id}' is fixed and cannot be reordered`, "conflict");
    if (!reordering) {
      this.q("UPDATE lanes SET name = ?, description = ?, wip_limit = ? WHERE id = ?").run(
        name ?? lane.name,
        patch.description ?? lane.description,
        wipLimit,
        lane.id,
      );
    } else {
      const lanes = this.lanes().filter((l) => l.id !== lane.id);
      let index: number;
      if (patch.before !== undefined) {
        if (patch.before === null) {
          index = lanes.length; // null anchor = literal last
        } else {
          const anchor = this.resolveLane(patch.before);
          if (anchor.id === lane.id) throw new KanbanError(`lane '${lane.id}' cannot be moved before itself`, "invalid");
          index = lanes.findIndex((l) => l.id === anchor.id);
        }
      } else {
        index = Math.floor(patch.index!); // both-present already threw above
      }
      const clamped = Math.max(0, Math.min(index, lanes.length));
      const position =
        clamped === 0
          ? (lanes[0]?.position ?? 0) / 2
          : clamped >= lanes.length
            ? (lanes.at(-1)?.position ?? 0) + GAP
            : (lanes[clamped - 1].position + lanes[clamped].position) / 2;
      this.q("UPDATE lanes SET name = ?, description = ?, position = ?, wip_limit = ? WHERE id = ?").run(
        name ?? lane.name,
        patch.description ?? lane.description,
        position,
        wipLimit,
        lane.id,
      );
      this.renormalizeLanesIfTight();
    }
    return this.resolveLane(lane.id);
  }

  /** Move a lane before another lane (any lane ref; null appends literal last). Fixed lanes refuse. */
  moveLane(prefix: string, before: string | null): Lane {
    const lane = this.resolveLane(prefix);
    if (before !== null) {
      const anchor = this.resolveLane(before);
      if (anchor.id === lane.id) throw new KanbanError(`lane '${lane.id}' cannot be moved before itself`, "invalid");
      const index = this.lanes().filter((l) => l.id !== lane.id).findIndex((l) => l.id === anchor.id);
      return this.updateLane(lane.id, { index });
    }
    return this.updateLane(lane.id, { index: this.lanes().length - 1 });
  }

  /** Rewrite lanes' positions as 100/200/... when midpoint halving gets too tight. */
  private renormalizeLanesIfTight(): void {
    const lanes = this.lanes();
    let tight = false;
    for (let i = 1; i < lanes.length; i++) {
      if (lanes[i].position - lanes[i - 1].position < MIN_GAP) {
        tight = true;
        break;
      }
    }
    if (!tight) return;
    const update = this.q("UPDATE lanes SET position = ? WHERE id = ?");
    lanes.forEach((l, i) => update.run((i + 1) * GAP, l.id));
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
      const delBlockedBy = this.q("DELETE FROM blocked_by WHERE card_id = ? OR blocker_id = ?");
      const delLinks = this.q("DELETE FROM card_links WHERE card_a = ? OR card_b = ?");
      const delGhLinks = this.q("DELETE FROM gh_links WHERE card_id = ?");
      const delCardSessions = this.q("DELETE FROM card_sessions WHERE task_id = ?");
      const delResumeRequests = this.q("DELETE FROM resume_requests WHERE task_id = ?");
      const delElaborationRequests = this.q("DELETE FROM elaboration_requests WHERE task_id = ?");
      const delLaneEvents = this.q("DELETE FROM lane_events WHERE task_id = ?");
      for (const t of this.laneTasks(lane.id)) {
        for (const id of [t.id, ...this.descendantIds(t.id)]) {
          del.run(id);
          delAttachments.run(id);
          delComments.run(id);
          delBlockedBy.run(id, id);
          delLinks.run(id, id);
          delGhLinks.run(id);
          delCardSessions.run(id);
          delResumeRequests.run(id);
          delElaborationRequests.run(id);
          delLaneEvents.run(id);
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
