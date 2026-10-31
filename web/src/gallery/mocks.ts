// Mock board for the dev-only /gallery route: seeds the real `board`/`agents`
// singletons so every component renders with zero server, and swaps the
// mutating store methods for in-memory versions so gallery interactions can
// never write to the real board over the dev API.
import type { AgentConfig, AgentRole, Attachment, Lane, LanePatch, Task, TaskPatch, WorkerPool } from "../../../src/db";
import type { AgentSessionInfo } from "../../../src/autoreview";
import type { CatalogModel } from "../../../src/models";
import { newId, slugify } from "../../../src/ids";
import { board } from "../lib/board.svelte";
import { agents } from "../lib/agents.svelte";
import { pools } from "../lib/pools.svelte";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = () => Date.now();

function lane(partial: Partial<Lane> & { id: string; name: string }): Lane {
  return { description: "", position: 100, fixed: 0, ...partial };
}

function task(partial: Partial<Task> & { id: string; title: string }): Task {
  return { note: "", laneId: "backlog", project: "", tags: [], parentId: null, previousLane: null, workspace: null, priority: "normal", position: 100, createdAt: now(), updatedAt: now(), ...partial };
}

export const CATALOG: CatalogModel[] = [
  { provider: "anthropic", id: "claude-opopus-4-6", context: "200k", maxOut: "64k", thinking: true, images: true },
  { provider: "anthropic", id: "claude-sonnet-4-6", context: "200k", maxOut: "64k", thinking: true, images: true },
  { provider: "anthropic", id: "claude-haiku-4-2", context: "200k", maxOut: "32k", thinking: false, images: true },
  { provider: "openai", id: "gpt-5.3", context: "400k", maxOut: "128k", thinking: true, images: true },
  { provider: "openai", id: "gpt-5.3-mini", context: "400k", maxOut: "128k", thinking: true, images: false },
  { provider: "zai", id: "glm-5.3", context: "200k", maxOut: "128k", thinking: true, images: false },
];

const LANES: Lane[] = [
  lane({ id: "waiting", name: "Waiting on you", description: "Parked for a human answer — replying returns the card", position: 50, fixed: 1 }),
  lane({ id: "backlog", name: "Backlog", description: "Waiting work, nothing started", position: 100, fixed: 1 }),
  lane({ id: "plan", name: "Plan", description: "Scoping and design before code", position: 200 }),
  lane({ id: "implement", name: "Test + Implement", description: "Build it, test as you go", position: 300 }),
  lane({ id: "review", name: "Review", description: "Verify, polish, get sign-off", position: 400 }),
  lane({ id: "done", name: "Done", description: "Finished", position: 500, fixed: 1 }),
  lane({ id: "archive", name: "Archive", description: "Kept out of the way", position: 600, fixed: 1 }),
];

// ids are stable so sections can point at specific mock tasks
const epic = task({
  id: "k7f2m",
  title: "port pi-web components",
  laneId: "backlog",
  project: "kanban",
  position: 100,
  createdAt: now() - 3 * DAY,
  updatedAt: now() - 2 * HOUR,
  note: [
    "Adopt the pi-web design language across the board.",
    "",
    "- [x] settings dialog with section tabs",
    "- [ ] token swatch page",
    "- [ ] focus states pass",
    "",
    "```ts",
    "const tokens = readTokens(document.root);",
    "if (!tokens.accent) throw new Error(\"missing accent\");",
    "```",
  ].join("\n"),
});
const subA = task({
  id: "b3xq8",
  title: "settings dialog tabs",
  laneId: "backlog",
  parentId: epic.id,
  project: "kanban",
  position: 110,
  createdAt: now() - 3 * DAY,
  updatedAt: now() - DAY,
  note: "Ships the tabbed settings surface; state survives tab switches.",
});
const subB = task({
  id: "d9w4t",
  title: "segmented control",
  laneId: "done",
  parentId: epic.id,
  project: "kanban",
  position: 120,
  createdAt: now() - 3 * DAY,
  updatedAt: now() - 6 * HOUR,
});
const docsDone = task({
  id: "h2n7c",
  title: "docs pass",
  laneId: "backlog",
  project: "kanban",
  position: 200,
  createdAt: now() - 2 * DAY,
  updatedAt: now() - DAY,
  note: "Every command documented with a copyable example.",
});
const docsChild = task({
  id: "p5r9k",
  title: "README examples",
  laneId: "done",
  parentId: docsDone.id,
  project: "kanban",
  position: 130,
  createdAt: now() - 2 * DAY,
  updatedAt: now() - 2 * DAY,
});
const plain = task({
  id: "t8v3y",
  title: "ship version 0.6.0",
  laneId: "plan",
  project: "kanban",
  position: 100,
  createdAt: now() - 5 * HOUR,
  updatedAt: now() - 10 * MIN,
  note: "Bump cli VERSION + package.json together.",
});
const waitingQuestion = task({
  id: "q1a5w",
  title: "waiting on a design question",
  laneId: "plan",
  project: "kanban",
  position: 120,
  createdAt: now() - 4 * HOUR,
  updatedAt: now() - 30 * MIN,
  note: "Planner asked SSE vs polling — the amber ? badge is on the card.",
});
const parkedCard = task({
  id: "p3k1w",
  title: "parked on your input",
  laneId: "waiting",
  previousLane: "plan",
  project: "kanban",
  position: 100,
  createdAt: now() - 2 * HOUR,
  updatedAt: now() - 15 * MIN,
  note: "Parked in Waiting on you until a human replies.",
});
const waitingRerun = task({
  id: "r6e3n",
  title: "review session stalled",
  laneId: "plan",
  project: "kanban",
  position: 140,
  createdAt: now() - 3 * HOUR,
  updatedAt: now() - 45 * MIN,
  note: "Plan review ended without a verdict — a comment re-runs it.",
});
const waitingCapped = task({
  id: "c8p2k",
  title: "plan review hit the cap",
  laneId: "plan",
  project: "kanban",
  position: 160,
  createdAt: now() - 6 * HOUR,
  updatedAt: now() - 1 * HOUR,
  note: "Blocked twice since the last human comment — needs a human.",
});
const crossChild = task({
  id: "m6j2d",
  title: "contrast check both themes",
  laneId: "backlog",
  parentId: plain.id, // parent lives in Plan → shows the ↑ parent chip
  project: "pi-web",
  position: 300,
  createdAt: now() - 5 * HOUR,
  updatedAt: now() - 40 * MIN,
});
const working = task({
  id: "w4c8n",
  title: "gallery route",
  laneId: "review",
  project: "kanban",
  position: 100,
  createdAt: now() - 8 * HOUR,
  updatedAt: now() - 3 * MIN,
  note: "Dev-only /gallery rendering every component in key states.",
});
const implA = task({
  id: "f7g5h",
  title: "theme tokens extraction",
  laneId: "implement",
  project: "pi-web",
  position: 100,
  createdAt: now() - DAY,
  updatedAt: now() - 4 * HOUR,
  note: "CSS custom properties drive both themes.",
});
const implB = task({
  id: "q9s3z",
  title: "swatch grid",
  laneId: "implement",
  project: "pi-web",
  position: 200,
  createdAt: now() - DAY,
  updatedAt: now() - 90 * MIN,
});
const prioHigh = task({
  id: "b3k9m",
  title: "fix flaky e2e drop",
  laneId: "backlog",
  project: "kanban",
  priority: "high",
  position: 220,
  createdAt: now() - 9 * HOUR,
  updatedAt: now() - 2 * HOUR,
  note: "Ship-stopper: red ▲ chip, and `kanban next` picks it first.",
});
const prioLow = task({
  id: "v8x2q",
  title: "sweep TODO comments",
  laneId: "backlog",
  project: "kanban",
  priority: "low",
  position: 240,
  createdAt: now() - 12 * HOUR,
  updatedAt: now() - 7 * HOUR,
  note: "Dim ▼ chip — fine whenever.",
});
const edgeBlocker = task({
  id: "e4r7t",
  title: "land the schema migration",
  laneId: "implement",
  project: "kanban",
  position: 300,
  createdAt: now() - 20 * HOUR,
  updatedAt: now() - 80 * MIN,
  note: "Everything downstream waits on this one.",
});
const edgeDependent = task({
  id: "d9w5y",
  title: "ship the feature flag",
  laneId: "backlog",
  project: "kanban",
  position: 260,
  createdAt: now() - 18 * HOUR,
  updatedAt: now() - 3 * HOUR,
  note: "Depends on the migration — amber blocked chip (Lucide circle-slash), card dimmed while it blocks.",
});
const edgeDoneDep = task({
  id: "g6u1i",
  title: "announce in the changelog",
  laneId: "backlog",
  project: "kanban",
  position: 280,
  createdAt: now() - 16 * HOUR,
  updatedAt: now() - 5 * HOUR,
  note: "Depended on README examples (done) — edge kept, nothing blocking it.",
});
const archived = task({
  id: "z1a6b",
  title: "old bootstrap task",
  laneId: "archive",
  project: "",
  position: 100,
  createdAt: now() - 30 * DAY,
  updatedAt: now() - 20 * DAY,
  note: "Kept for the archive strip + dimmed card state.",
});

const TASKS: Task[] = [parkedCard, epic, subA, subB, docsDone, docsChild, plain, waitingQuestion, waitingRerun, waitingCapped, crossChild, working, implA, implB, prioHigh, prioLow, edgeBlocker, edgeDependent, edgeDoneDep, archived];

const PLAN: Attachment = {
  id: "pln1",
  taskId: epic.id,
  kind: "plan",
  version: 2,
  source: "/tmp/plan.md",
  createdAt: now() - 2 * HOUR,
  content: [
    "# plan",
    "",
    "1. inventory pi-web components",
    "2. map to kanban surfaces",
    "3. port tokens first, then widgets",
  ].join("\n"),
};

const ACTIVITY: Record<string, AgentSessionInfo> = {
  [working.id]: {
    taskId: working.id,
    role: "reviewer",
    startedAt: now() - 3 * MIN,
    log: [
      "reading card k7f2m context…",
      "found 2 findings: stale token names, missing focus ring",
      "posting review comment",
      "writing findings to the thread…",
    ],
  },
};

/** Stable mock ids / lane ids the gallery sections look up reactively from the store. */
export const ids = {
  epic: epic.id,
  plain: plain.id,
  question: waitingQuestion.id,
  parked: parkedCard.id,
  rerun: waitingRerun.id,
  capped: waitingCapped.id,
  docs: docsDone.id,
  crossChild: crossChild.id,
  working: working.id,
  archived: archived.id,
};

// ---------- in-memory mutations (gallery never touches the API) ----------

function laneIdOf(ref: string): string {
  return board.lanes.find((l) => l.id === ref || l.id.startsWith(ref) || l.name.toLowerCase().startsWith(ref.toLowerCase()))?.id ?? ref;
}

function taskRef(ref: string): string | undefined {
  return board.tasks.find((t) => t.id === ref || t.id.startsWith(ref))?.id;
}

function reposition(t: Task, index: number): void {
  const siblings = board.tasks
    .filter((o) => o.laneId === t.laneId && o.id !== t.id)
    .sort((a, b) => a.position - b.position);
  siblings.splice(Math.max(0, Math.min(index, siblings.length)), 0, t);
  siblings.forEach((s, i) => (s.position = (i + 1) * 100));
}

function stubMutations(): void {
  board.addTask = async (laneId: string, title: string, project = board.projectFilter, parentId?: string): Promise<Task | null> => {
    if (!board.lanes.some((l) => l.id === laneId)) return null;
    const siblings = board.tasks.filter((t) => t.laneId === laneId);
    const created = task({
      id: newId(),
      title,
      laneId,
      project: project || "",
      parentId: parentId ? (taskRef(parentId) ?? null) : null,
      position: (siblings.length + 1) * 100,
    });
    board.tasks = [...board.tasks, created];
    return created;
  };

  board.updateTask = async (id: string, patch: TaskPatch): Promise<void> => {
    const t = board.tasks.find((o) => o.id === id || o.id.startsWith(id));
    if (!t) return;
    if (patch.title !== undefined) t.title = patch.title;
    if (patch.note !== undefined) t.note = patch.note;
    if (patch.project !== undefined) t.project = patch.project;
    if (patch.lane !== undefined) t.laneId = laneIdOf(patch.lane);
    if (patch.parent !== undefined) t.parentId = patch.parent ? (taskRef(patch.parent) ?? null) : null;
    if (patch.priority !== undefined) t.priority = patch.priority;
    t.updatedAt = now();
    if (patch.index !== undefined) reposition(t, patch.index);
    board.tasks = [...board.tasks];
  };

  board.moveTask = async (id: string, laneId: string, index?: number): Promise<void> => {
    await board.updateTask(id, { lane: laneId, index });
  };

  board.deleteTask = async (id: string, _force = false): Promise<void> => {
    const hit = taskRef(id);
    if (!hit) return;
    const gone = new Set([hit, ...board.descendantsOf(hit).map((t) => t.id)]);
    board.tasks = board.tasks.filter((t) => !gone.has(t.id));
    board.closeCard();
  };

  board.addLane = async (name: string): Promise<boolean> => {
    const id = slugify(name);
    if (board.lanes.some((l) => l.id === id)) return false;
    board.lanes = [...board.lanes, lane({ id, name, position: (board.lanes.length + 1) * 100 })];
    return true;
  };

  board.updateLane = async (id: string, patch: LanePatch): Promise<void> => {
    const l = board.lanes.find((o) => o.id === id);
    if (!l) return;
    if (patch.name !== undefined) l.name = patch.name;
    if (patch.description !== undefined) l.description = patch.description;
    if (patch.index !== undefined) {
      const ordered = [...board.lanes].sort((a, b) => a.position - b.position).filter((o) => o.id !== id);
      ordered.splice(Math.max(0, Math.min(patch.index, ordered.length)), 0, l);
      ordered.forEach((o, i) => (o.position = (i + 1) * 100));
    }
    board.lanes = [...board.lanes];
  };

  board.renameLane = async (id: string, name: string): Promise<void> => {
    await board.updateLane(id, { name });
  };

  board.moveLane = async (id: string, index: number): Promise<void> => {
    await board.updateLane(id, { index });
  };

  board.removeLane = async (id: string): Promise<void> => {
    board.lanes = board.lanes.filter((l) => l.id !== id);
    board.tasks = board.tasks.map((t) => (t.laneId === id ? { ...t, laneId: "backlog" } : t));
  };

  agents.save = async (role: AgentRole, config: AgentConfig): Promise<boolean> => {
    agents.configs[role] = config;
    return true;
  };

  pools.save = async (pool: WorkerPool): Promise<boolean> => {
    const idx = pools.pools.findIndex((p) => p.id === pool.id);
    if (idx !== -1) {
      pools.pools[idx] = pool;
    } else {
      pools.pools.push(pool);
    }
    return true;
  };

  pools.remove = async (id: string): Promise<boolean> => {
    pools.pools = pools.pools.filter((p) => p.id !== id);
    return true;
  };
}

// ---------- seed ----------

export function seed(): void {
  board.lanes = LANES.map((l) => ({ ...l }));
  board.tasks = TASKS.map((t) => ({ ...t }));
  board.plans = { [epic.id]: { ...PLAN } };
  board.waiting = { [plain.id]: "gate", [waitingQuestion.id]: "question", [parkedCard.id]: "question", [waitingRerun.id]: "rerun", [waitingCapped.id]: "capped" };
  board.blockedBy = { [edgeDependent.id]: [edgeBlocker.id], [edgeDoneDep.id]: [docsChild.id] };
  board.activity = Object.fromEntries(Object.entries(ACTIVITY).map(([k, v]) => [k, { ...v, log: [...v.log] }]));
  board.loading = false;
  board.error = "";
  board.search = "";
  board.projectFilter = "";
  board.editing = null;
  board.editMode = false;
  board.archiveOpen = false;
  board.dragging = null;
  board.dropHint = null;
  board.expanded = new Set([epic.id]); // nested children visible out of the box
  board.flashId = null;

  // loaded=true keeps SettingsPanel's agents tab from fetching the real config
  agents.open = false;
  agents.loaded = true;
  agents.configs.reviewer = { provider: "anthropic", model: "claude-sonnet-4-6", thinking: "high", timeoutMs: 120 * 60_000 };
  agents.configs.builder = { provider: "zai", model: "glm-5.3", thinking: "medium", skills: ["~/.pi/agent/skills/tdd"] };
  agents.models = [...CATALOG];
  agents.skills = [
    { name: "caveman", description: "Terse caveman voice: answer first, fluff gone, every technical fact kept.", path: "~/.pi/agent/skills/caveman" },
    { name: "tdd", description: "Test-driven development. Red-green-refactor, tests worth keeping.", path: "~/.pi/agent/skills/tdd" },
  ];

  pools.loaded = true;
  pools.models = [...CATALOG];
  pools.pools = [
    {
      id: "heavy",
      name: "heavy",
      enabled: true,
      roles: ["builder"],
      slots: [
        { provider: "zai", model: "glm-5.3", thinking: "max" },
        { provider: "zai", model: "glm-5.3", thinking: "max" },
        { provider: "zai", model: "glm-5.3", thinking: "max" },
      ],
      updatedAt: now(),
    },
    {
      id: "light",
      name: "light",
      enabled: true,
      roles: ["planner", "reviewer"],
      slots: [
        { provider: "anthropic", model: "claude-haiku-4-5", thinking: "low" },
        { provider: "anthropic", model: "claude-haiku-4-5", thinking: "low" },
      ],
      updatedAt: now(),
    },
  ];

  stubMutations();
}
