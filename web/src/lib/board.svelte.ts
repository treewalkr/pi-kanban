import { api } from "../api";
import type { Attachment, Lane, LanePatch, Task, TaskPatch, WaitingState } from "../../../src/db";
import type { AgentSessionInfo, QueuedJobInfo } from "../../../src/autoreview";
import { searchBoard } from "../../../src/search";
import { initialProject, parseProjectHash, projectHash } from "./viewhash";

type EdenError = { value?: unknown };

function readHash(): string {
  try {
    return (typeof window !== "undefined" ? window.location?.hash : "") ?? "";
  } catch {
    return "";
  }
}

function writeHash(hash: string): void {
  try {
    const loc = typeof window !== "undefined" ? window.location : undefined;
    const path = loc?.pathname ?? "";
    const search = loc?.search ?? "";
    const url = `${path}${search}${hash}`;
    const h = (globalThis as any).history ?? (typeof history !== "undefined" ? history : undefined);
    h?.replaceState?.(null, "", url);
  } catch {
    /* history unavailable */
  }
}

function loadProjectFilter(): string {
  let stored = "";
  try {
    stored = localStorage.getItem("kanban-project") ?? "";
  } catch {
    /* storage unavailable */
  }
  return initialProject(stored, readHash());
}

function loadPrioFilter(): "high" | "" {
  try {
    return localStorage.getItem("kanban-prio") === "high" ? "high" : "";
  } catch {
    return "";
  }
}

function loadBlockedOnly(): boolean {
  try {
    return localStorage.getItem("kanban-blocked-only") === "true";
  } catch {
    return false;
  }
}

function loadWaitingOnly(): boolean {
  try {
    return localStorage.getItem("kanban-waiting-only") === "true";
  } catch {
    return false;
  }
}

function loadView(): "board" | "list" {
  try {
    return localStorage.getItem("kanban-view") === "list" ? "list" : "board";
  } catch {
    return "board";
  }
}

class BoardStore {
  lanes = $state<Lane[]>([]);
  tasks = $state<Task[]>([]);
  /** Latest plan per card, keyed by task id (board payload). */
  plans = $state<Record<string, Attachment>>({});
  /** Cards waiting on the human (plan lane or dead session on any lane), keyed by task id (board payload, sparse). */
  waiting = $state<Record<string, WaitingState>>({});
  /** Sparse card-id → direct blocker ids (board payload). */
  blockedBy = $state<Record<string, string[]>>({});
  loading = $state(true);
  error = $state("");
  search = $state("");

  #projectFilter = $state(loadProjectFilter());

  /** Active project chip; persists to localStorage (kanban-project, same idea as kanban-theme) so a reload keeps the focus. */
  get projectFilter(): string {
    return this.#projectFilter;
  }

  set projectFilter(v: string) {
    this.#projectFilter = v;
    try {
      if (v === "") localStorage.removeItem("kanban-project");
      else localStorage.setItem("kanban-project", v);
    } catch {
      /* storage unavailable — the filter still works for this session */
    }
    writeHash(projectHash(v));
  }

  applyProjectHash(): void {
    const project = parseProjectHash(readHash());
    if (project !== this.#projectFilter) {
      this.projectFilter = project;
    }
  }

  #prioFilter = $state<"high" | "">(loadPrioFilter());

  get prioFilter(): "high" | "" {
    return this.#prioFilter;
  }

  set prioFilter(v: "high" | "") {
    this.#prioFilter = v;
    try {
      if (v === "") localStorage.removeItem("kanban-prio");
      else localStorage.setItem("kanban-prio", v);
    } catch {
      /* storage unavailable */
    }
  }

  #blockedOnly = $state<boolean>(loadBlockedOnly());

  get blockedOnly(): boolean {
    return this.#blockedOnly;
  }

  set blockedOnly(v: boolean) {
    this.#blockedOnly = v;
    try {
      if (!v) localStorage.removeItem("kanban-blocked-only");
      else localStorage.setItem("kanban-blocked-only", "true");
    } catch {
      /* storage unavailable */
    }
  }

  #waitingOnly = $state<boolean>(loadWaitingOnly());

  get waitingOnly(): boolean {
    return this.#waitingOnly;
  }

  set waitingOnly(v: boolean) {
    this.#waitingOnly = v;
    try {
      if (!v) localStorage.removeItem("kanban-waiting-only");
      else localStorage.setItem("kanban-waiting-only", "true");
    } catch {
      /* storage unavailable */
    }
  }

  #view = $state<"board" | "list">(loadView());

  /** Active lens over the same data: lanes (board) or hierarchy (list). Persists as kanban-view. */
  get view(): "board" | "list" {
    return this.#view;
  }

  set view(v: "board" | "list") {
    this.#view = v;
    try {
      localStorage.setItem("kanban-view", v);
    } catch {
      /* storage unavailable — the toggle still works for this session */
    }
  }

  /** Collapsed parents in the list view (missing = expanded — the list's default is open, unlike the board). */
  listCollapsed = $state<Set<string>>(new Set());

  toggleListCollapsed(id: string): void {
    const next = new Set(this.listCollapsed);
    if (!next.delete(id)) next.add(id);
    this.listCollapsed = next;
  }

  editing = $state<Task | null>(null);
  editMode = $state(false);
  archiveOpen = $state(false);
  dragging = $state<string | null>(null);
  dropHint = $state<{ laneId: string; index: number } | null>(null);
  expanded = $state<Set<string>>(new Set());
  /** Card to scroll to and flash once the detail modal closes (search jumps). */
  flashId = $state<string | null>(null);
  /** In-flight pi agent sessions, keyed by task id (poll-driven: sessions emit no DB writes). */
  activity = $state<Record<string, AgentSessionInfo>>({});
  /** Queued agent jobs, no session yet, keyed by task id. */
  queued = $state<Record<string, QueuedJobInfo>>({});

  readonly projects = $derived(
    [...new Set(this.tasks.map((t) => t.project).filter((p) => p !== ""))].sort(),
  );

  readonly visibleLanes = $derived(
    this.lanes
      .map((lane, index) => ({ lane, index }))
      .filter(({ lane }) => this.#projectFilter === "" || this.visibleTasks(lane.id).length > 0),
  );

  readonly activeCount = $derived(
    this.tasks.filter(
      (t) => t.laneId !== "archive" && (this.#projectFilter === "" || t.project === this.#projectFilter),
    ).length,
  );
  readonly waitingCount = $derived(this.tasks.filter((t) => t.laneId === "waiting").length);

  // a search that matches archived cards reveals the collapsed strip
  readonly archiveSearchHit = $derived(
    this.search.trim() !== "" && this.visibleTasks("archive").length > 0,
  );

  readonly searchResults = $derived(searchBoard(this.tasks, this.search, this.plans));

  openCard(task: Task): void {
    this.editing = task;
    this.editMode = false;
  }

  closeCard(): void {
    this.editing = null;
    this.editMode = false;
  }

  visibleTasks(laneId: string): Task[] {
    return this.tasks
      .filter((t) => t.laneId === laneId)
      .filter((t) => this.matches(t))
      .filter((t) => !this.nestsUnder(t))
      .sort((a, b) => a.position - b.position);
  }

  laneCount(laneId: string): number {
    return this.tasks.filter((t) => t.laneId === laneId).length;
  }

  // ---------- hierarchy ----------

  taskById(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  /** Ancestor chain of a task, root first (epic → story). */
  ancestorsOf(id: string): Task[] {
    const chain: Task[] = [];
    let cur = this.taskById(id);
    while (cur?.parentId) {
      const parent = this.taskById(cur.parentId);
      if (!parent) break;
      chain.unshift(parent);
      cur = parent;
    }
    return chain;
  }

  /** True when the task passes the current search/project filter. */
  matches(t: Task): boolean {
    if (this.projectFilter && t.project !== this.projectFilter) return false;
    if (this.prioFilter && t.priority !== this.prioFilter) return false;
    if (this.blockedOnly && !this.isBlocked(t.id)) return false;
    if (this.waitingOnly && t.laneId !== "waiting") return false;
    const q = this.search.trim().toLowerCase();
    return q ? `${t.title} ${t.note} ${t.id} ${t.project}`.toLowerCase().includes(q) : true;
  }

  /** A card is blocked if any direct blocker is outside done or archive (soft blocking). */
  isBlocked(id: string): boolean {
    const blockers = this.blockedBy[id];
    if (!blockers || blockers.length === 0) return false;
    return blockers.some((bid) => {
      const bTask = this.taskById(bid);
      return !bTask || (bTask.laneId !== "done" && bTask.laneId !== "archive");
    });
  }

  /** True when the task renders nested under its parent (same lane, parent visible). */
  nestsUnder(task: Task): boolean {
    if (!task.parentId) return false;
    const parent = this.taskById(task.parentId);
    return !!parent && parent.laneId === task.laneId && this.matches(parent);
  }

  /** Direct children in position order, any lane. */
  childrenOf(id: string): Task[] {
    return this.tasks
      .filter((t) => t.parentId === id)
      .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  }

  /** All descendants of a task, breadth-first. */
  descendantsOf(id: string): Task[] {
    const out: Task[] = [];
    const walk = (tid: string): void => {
      for (const child of this.childrenOf(tid)) {
        out.push(child);
        walk(child.id);
      }
    };
    walk(id);
    return out;
  }

  /** Same-lane children that pass the current filter — the ones nested on the board. */
  nestedChildren(task: Task): Task[] {
    return this.childrenOf(task.id).filter((t) => t.laneId === task.laneId && this.matches(t));
  }

  /** Done/total over all descendants, any lane. */
  progressOf(task: Task): { done: number; total: number } {
    const all = this.descendantsOf(task.id);
    return { done: all.filter((t) => t.laneId === "done").length, total: all.length };
  }

  toggleExpanded(id: string): void {
    const next = new Set(this.expanded);
    if (!next.delete(id)) next.add(id);
    this.expanded = next;
  }

  /** Jump from a search result: reveal the task on the board, then open it. */
  jumpTo(task: Task): void {
    const next = new Set(this.expanded);
    for (const ancestor of this.ancestorsOf(task.id)) next.add(ancestor.id);
    this.expanded = next;
    if (task.laneId === "archive") this.archiveOpen = true;
    this.flashId = task.id;
    this.search = "";
    this.openCard(task);
  }

  private fail(error: EdenError): void {
    const value = error.value as { error?: string } | undefined;
    this.error = value?.error ?? "request failed";
  }

  async refresh(): Promise<void> {
    const { data, error } = await api.board.get();
    if (error) {
      this.fail(error);
      return;
    }
    this.error = "";
    this.lanes = data.lanes;
    this.tasks = data.tasks;
    this.plans = data.plans;
    this.waiting = data.waiting ?? {}; // guards the dev-restart window against a pre-change API payload
    this.blockedBy = data.blockedBy ?? {};
    this.loading = false;
    // a stored project whose tag no longer exists (renamed, or its last card dropped the tag)
    // resets to "all" — an active filter with no visible chip would be a silent empty board
    if (this.projectFilter !== "" && !this.projects.includes(this.projectFilter)) {
      this.projectFilter = "";
    }
  }

  async pollActivity(): Promise<void> {
    const { data, error } = await api.activity.get();
    if (error) return;
    const next: Record<string, AgentSessionInfo> = {};
    for (const session of data.sessions) next[session.taskId] = session;
    this.activity = next;
    const nextQ: Record<string, QueuedJobInfo> = {};
    for (const job of data.queued ?? []) nextQ[job.taskId] = job;
    this.queued = nextQ;
  }

  async addTask(laneId: string, title: string, project = this.projectFilter, parentId?: string, elaborate = false): Promise<boolean> {
    const { error } = await api.tasks.post({ title, lane: laneId, project: project || undefined, parent: parentId, elaborate: elaborate || undefined });
    if (error) {
      this.fail(error);
      return false;
    }
    await this.refresh();
    return true;
  }

  async updateTask(id: string, patch: TaskPatch): Promise<void> {
    const { error } = await api.tasks({ id }).patch(patch);
    if (error) return this.fail(error);
    await this.refresh();
  }

  async moveTask(id: string, laneId: string, index?: number): Promise<void> {
    await this.updateTask(id, { lane: laneId, index });
  }

  async deleteTask(id: string, force = false): Promise<void> {
    const { error } = await api.tasks({ id }).delete(null, { query: force ? { force: "true" } : undefined });
    if (error) return this.fail(error);
    this.closeCard();
    await this.refresh();
  }

  async resumeSession(id: string): Promise<void> {
    const { error } = await api.tasks({ id }).resume.post({});
    if (error) return this.fail(error);
    await this.pollActivity();
    await this.refresh();
  }

  async addLane(name: string): Promise<boolean> {
    const { error } = await api.lanes.post({ name });
    if (error) {
      this.fail(error);
      return false;
    }
    await this.refresh();
    return true;
  }

  async updateLane(id: string, patch: LanePatch): Promise<void> {
    const { error } = await api.lanes({ id }).patch(patch);
    if (error) return this.fail(error);
    await this.refresh();
  }

  async renameLane(id: string, name: string): Promise<void> {
    await this.updateLane(id, { name });
  }

  async moveLane(id: string, index: number): Promise<void> {
    await this.updateLane(id, { index });
  }

  async removeLane(id: string): Promise<void> {
    const { error } = await api.lanes({ id }).delete();
    if (error) return this.fail(error);
    await this.refresh();
  }
}

export const board = new BoardStore();
