<script lang="ts">
  import { board } from "./board.svelte";
  import { ui } from "./ui.svelte";
  import Brand from "./Brand.svelte";
  import PathLabel from "./PathLabel.svelte";
  import Dropdown from "./Dropdown.svelte";
  import { Bot, Check, ChevronDown, FolderOpen, GitBranch, Layers, Loader2, Plus, Search, Settings2 } from "@lucide/svelte";
  import { formatRelativeTime, roleVerb } from "./util";
  import { agents, type SettingsSection } from "./agents.svelte";
  import type { AgentRole } from "../../../src/db";

  // ---------- header: new card + search ----------

  // new cards land in Backlog (the API's bare-add default), not the first non-fixed lane
  const firstLane = $derived(board.lanes.find((l) => l.id === "backlog") ?? board.lanes.find((l) => !l.fixed));

  async function newCard(): Promise<void> {
    const lane = firstLane;
    if (!lane) return;
    const task = await board.addTask(lane.id, "new card");
    if (task) board.openEditor(task);
  }

  function focusSearch(): void {
    document.getElementById("board-search")?.focus();
  }

  // ---------- project picker ----------

  let pickerOpen = $state(false);
  let filter = $state("");

  const waitingByProject = $derived.by(() => {
    const m = new Map<string, number>();
    for (const t of board.tasks) {
      if (t.laneId === "waiting" && t.project !== "") m.set(t.project, (m.get(t.project) ?? 0) + 1);
    }
    return m;
  });

  const runningByProject = $derived.by(() => {
    const m = new Map<string, number>();
    for (const session of Object.values(board.activity)) {
      const task = board.taskById(session.taskId);
      if (task?.project) m.set(task.project, (m.get(task.project) ?? 0) + 1);
    }
    return m;
  });

  // pi-web's "other workspace activity" dot: something waits or runs outside the current project
  const otherProjectActivity = $derived(
    board.projects.some(
      (p) =>
        p !== board.projectFilter &&
        ((waitingByProject.get(p) ?? 0) > 0 || (runningByProject.get(p) ?? 0) > 0),
    ),
  );

  const visibleProjects = $derived(
    board.projects.filter((p) => p.toLowerCase().includes(filter.trim().toLowerCase())),
  );

  function selectProject(p: string): void {
    if (p !== board.projectFilter) board.projectFilter = p;
    filter = "";
    pickerOpen = false;
  }

  // ---------- branch switcher (the repo the board serves) ----------

  let branchOpen = $state(false);

  const gitRepo = $derived(ui.git?.repo ? ui.git : null);
  const branchLabel = $derived(gitRepo ? (gitRepo.branch === "HEAD" ? `@ ${gitRepo.head}` : gitRepo.branch) : "");

  async function checkout(branch: string): Promise<void> {
    branchOpen = false;
    if (gitRepo && branch === gitRepo.branch) return;
    const error = await ui.checkoutGit(branch);
    if (error) board.error = error; // git's own refusal (e.g. dirty tree) lands in the error bar
  }

  // ---------- queue: cards waiting on you + live agent sessions ----------

  // relative times go stale between SSE refreshes — tick them back to life once a minute
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(timer);
  });

  const WAITING_REASONS: Record<string, string> = {
    gate: "plan gate",
    question: "asked a question",
    rerun: "needs a re-run",
    capped: "review cap",
    dead: "dead session",
  };

  const waitingQueue = $derived(
    board.tasks
      .filter((t) => t.laneId === "waiting")
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => ({ task: t, reason: board.waiting[t.id] ?? "waiting" })),
  );

  // live sessions win over queued jobs for the same card — one row per card
  const runningQueue = $derived.by(() => {
    const rows: { taskId: string; role: AgentRole; startedAt: number; label: string; queued: boolean }[] = [];
    for (const s of Object.values(board.activity))
      rows.push({ taskId: s.taskId, role: s.role, startedAt: s.startedAt, label: s.modelLabel ?? "", queued: false });
    const live = new Set(rows.map((r) => r.taskId));
    for (const q of Object.values(board.queued))
      if (!live.has(q.taskId)) rows.push({ taskId: q.taskId, role: q.role, startedAt: q.enqueuedAt, label: "", queued: true });
    return rows.sort((a, b) => a.startedAt - b.startedAt);
  });

  // ---------- bottom bar: settings sections (pi-web's Models/Skills/Settings row) ----------

  const SECTIONS: { id: SettingsSection; label: string }[] = [
    { id: "agents", label: "Agents" },
    { id: "pools", label: "Pools" },
    { id: "general", label: "Settings" },
  ];
</script>

<div class="sidebar-head">
  <div class="sidebar-head-row">
    <Brand />
    <div class="sidebar-tools">
      <button
        class="side-btn"
        title={`new card in ${firstLane?.name ?? "the first lane"}`}
        onclick={() => void newCard()}
      >
        <Plus size={12} strokeWidth={2.2} />New
      </button>
      <button
        class="side-btn icon"
        title="search cards (press /)"
        aria-label="search cards"
        onclick={focusSearch}
      >
        <Search size={16} strokeWidth={2} />
      </button>
    </div>
  </div>

  <div class="picker-wrap">
    <button
      class="picker"
      title="switch project"
      aria-haspopup="menu"
      aria-expanded={pickerOpen}
      onclick={() => {
        pickerOpen = !pickerOpen;
        branchOpen = false;
      }}
    >
      <span class="picker-value">
        <PathLabel text={board.projectFilter ? `~/${board.projectFilter}` : "all projects"} />
      </span>
      {#if otherProjectActivity}
        <span class="activity-dot" title="waiting or running in other projects"></span>
      {/if}
    </button>
    <Dropdown open={pickerOpen} onclose={() => (pickerOpen = false)}>
      {#if board.projects.length > 8}
        <div class="picker-filter">
          <input
            placeholder="filter projects…"
            bind:value={filter}
            onkeydown={(e) => {
              if (e.key === "Escape") {
                if (filter !== "") filter = "";
                else pickerOpen = false;
              }
            }}
          />
        </div>
      {/if}
      <div class="picker-list">
        {#each visibleProjects as p (p)}
          {@const running = runningByProject.get(p) ?? 0}
          {@const waiting = waitingByProject.get(p) ?? 0}
          <button class="picker-row" class:current={p === board.projectFilter} onclick={() => selectProject(p)}>
            {#if p === board.projectFilter}
              <span class="check"><Check size={10} strokeWidth={2.4} /></span>
            {:else}
              <span class="check-spacer"></span>
            {/if}
            <PathLabel text={`~/${p}`} />
            {#if running > 0}
              <span class="badge" title="{running} running agent{running === 1 ? '' : 's'}">
                <Loader2 class="spin" size={10} strokeWidth={2} />{running}
              </span>
            {/if}
            {#if waiting > 0}
              <span class="badge" title="{waiting} waiting on you">
                <span class="dot"></span>{waiting}
              </span>
            {/if}
          </button>
        {/each}
        {#if visibleProjects.length === 0}
          <div class="picker-empty">no matching projects</div>
        {/if}
      </div>
      <button class="picker-row footer" onclick={() => selectProject("")}>
        {#if board.projectFilter === ""}
          <span class="check"><Check size={10} strokeWidth={2.4} /></span>
        {:else}
          <span class="check"><FolderOpen size={10} strokeWidth={1.6} /></span>
        {/if}
        <span class="picker-footer-label">all projects</span>
      </button>
    </Dropdown>
  </div>

  {#if gitRepo}
    <div class="picker-wrap branch-wrap">
      <button
        class="branch-row"
        title="switch branch — checked out in the repo the board serves"
        aria-haspopup="menu"
        aria-expanded={branchOpen}
        onclick={() => {
          branchOpen = !branchOpen;
          pickerOpen = false;
        }}
      >
        <GitBranch size={11} strokeWidth={2} class="branch-icon" />
        <span class="branch-value"><PathLabel text={branchLabel} /></span>
        {#if gitRepo.worktrees > 1}
          <span class="branch-note" title="{gitRepo.worktrees} worktrees">{gitRepo.worktrees}</span>
        {/if}
        <ChevronDown size={9} strokeWidth={1.8} class="branch-chevron" />
      </button>
      <Dropdown open={branchOpen} onclose={() => (branchOpen = false)}>
        <div class="picker-list">
          {#each gitRepo.branches as b (b)}
            <button class="picker-row" class:current={b === gitRepo.branch} onclick={() => void checkout(b)}>
              {#if b === gitRepo.branch}
                <span class="check"><Check size={10} strokeWidth={2.4} /></span>
              {:else}
                <span class="check-spacer"></span>
              {/if}
              <PathLabel text={b} />
              {#if b === gitRepo.branch && gitRepo.dirty > 0}
                <span class="badge" title="{gitRepo.dirty} uncommitted change{gitRepo.dirty === 1 ? '' : 's'}">
                  ● {gitRepo.dirty}
                </span>
              {/if}
            </button>
          {/each}
        </div>
      </Dropdown>
    </div>
  {/if}
</div>

<div class="sidebar-body">
  {#if waitingQueue.length > 0}
    <div class="queue-group">waiting on you</div>
    {#each waitingQueue as { task, reason } (task.id)}
      <button
        class="queue-row"
        class:selected={board.editing?.id === task.id}
        title={task.title}
        onclick={() => board.openCard(task)}
      >
        <span class="queue-glyph" aria-hidden="true">☉</span>
        <span class="queue-main">
          <span class="queue-title">{task.title}</span>
          <span class="queue-meta">
            <span>{formatRelativeTime(task.updatedAt, now)}</span>
            <span>{WAITING_REASONS[reason] ?? reason}</span>
          </span>
        </span>
      </button>
    {/each}
  {:else}
    <div class="queue-empty">nothing waits on you</div>
  {/if}

  {#if runningQueue.length > 0}
    <div class="queue-group">running</div>
    {#each runningQueue as row (row.taskId)}
      {@const task = board.taskById(row.taskId)}
      <button
        class="queue-row"
        class:selected={board.editing?.id === row.taskId}
        title={task?.title ?? row.taskId}
        onclick={() => task && board.openCard(task)}
      >
        <span class="queue-glyph" aria-hidden="true">
          {#if row.queued}
            ⧗
          {:else}
            <Loader2 class="spin" size={13} strokeWidth={2} />
          {/if}
        </span>
        <span class="queue-main">
          <span class="queue-title">{task?.title ?? row.taskId}</span>
          <span class="queue-meta">
            <span>
              {#if row.queued}queued · {roleVerb(row.role)}{:else}{roleVerb(row.role)}{/if}{row.label ? ` · ${row.label}` : ""}
            </span>
            <span>{formatRelativeTime(row.startedAt, now)}</span>
          </span>
        </span>
      </button>
    {/each}
  {/if}
</div>

<div class="sidebar-foot">
  {#each SECTIONS as s (s.id)}
    <button type="button" class="foot-btn" title={s.label} aria-label={s.label} onclick={() => agents.openWith(s.id)}>
      {#if s.id === "agents"}
        <Bot size={14} strokeWidth={1.8} />
      {:else if s.id === "pools"}
        <Layers size={14} strokeWidth={1.8} />
      {:else}
        <Settings2 size={14} strokeWidth={1.8} />
      {/if}
      <span>{s.label}</span>
    </button>
  {/each}
</div>
