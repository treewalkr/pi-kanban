<script lang="ts">
  import { board } from "./board.svelte";
  import { ui } from "./ui.svelte";
  import Mark from "./Mark.svelte";
  import PathLabel from "./PathLabel.svelte";
  import Dropdown from "./Dropdown.svelte";
  import { Check, FolderOpen, Loader2, Plus, Search } from "@lucide/svelte";

  // ---------- header: new card + search ----------

  const firstLane = $derived(board.lanes.find((l) => !l.fixed));

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
</script>

<div class="sidebar-head">
  <div class="sidebar-head-row">
    <div class="sidebar-brand"><Mark />kanban</div>
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
      onclick={() => (pickerOpen = !pickerOpen)}
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
</div>

<div class="sidebar-body"></div>
