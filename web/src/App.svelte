<script lang="ts">
  import { board } from "./lib/board.svelte";
  import { agents } from "./lib/agents.svelte";
  import { eventsUrl } from "./api";
  import LaneView from "./lib/Lane.svelte";
  import ListView from "./lib/ListView.svelte";
  import TaskDetail from "./lib/TaskDetail.svelte";
  import TaskEditor from "./lib/TaskEditor.svelte";
  import AddLane from "./lib/AddLane.svelte";
  import SearchBox from "./lib/SearchBox.svelte";
  import SettingsPanel from "./lib/SettingsPanel.svelte";
  import { theme, setTheme } from "./lib/theme.svelte";

  // initial load, plus catch-up when a modal closes (change events are paused while editing)
  $effect(() => {
    if (!board.editing) board.refresh();
  });

  // keep the board in sync with CLI-side and other-tab writes, pushed over SSE
  $effect(() => {
    const source = new EventSource(eventsUrl);
    const refresh = () => {
      if (!document.hidden && !board.editing) board.refresh();
    };
    let opened = false;
    source.addEventListener("change", refresh);
    source.addEventListener("open", () => {
      // the server's initial sync event covers the first connect; catch up on reconnects
      if (opened) refresh();
      opened = true;
    });
    document.addEventListener("visibilitychange", refresh);
    return () => {
      source.close();
      document.removeEventListener("visibilitychange", refresh);
    };
  });

  // agent sessions run for minutes without touching the db, so poll for them
  $effect(() => {
    const poll = () => {
      if (!document.hidden) board.pollActivity();
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  });

  // after a search jump's modal closes, scroll the card into view and flash it
  $effect(() => {
    const id = board.flashId;
    if (!id || board.editing) return;
    board.flashId = null;
    const el = document.querySelector(`[data-card="${CSS.escape(id)}"]`);
    if (!el) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", inline: "center", behavior: reduced ? "auto" : "smooth" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1500);
  });
</script>

<div class="app">
  <header class="top">
    <div class="brand"><span class="mark"></span>kanban</div>
    <div class="view-toggle" role="tablist" aria-label="view">
      <button
        class:active={board.view === "board"}
        role="tab"
        aria-selected={board.view === "board"}
        title="lanes — work by stage"
        onclick={() => (board.view = "board")}>board</button
      >
      <button
        class:active={board.view === "list"}
        role="tab"
        aria-selected={board.view === "list"}
        title="hierarchy — parents and subtasks together"
        onclick={() => (board.view = "list")}>list</button
      >
    </div>
    <SearchBox />
    <div class="chips">
      <button class:active={board.projectFilter === ""} onclick={() => (board.projectFilter = "")}>
        all
      </button>
      {#each board.projects as p (p)}
        <button
          class:active={board.projectFilter === p}
          onclick={() => (board.projectFilter = board.projectFilter === p ? "" : p)}
        >
          {p}
        </button>
      {/each}
    </div>
    <div class="meta">{board.activeCount} tasks</div>
    <button
      class="theme-toggle"
      onclick={() => (agents.open = !agents.open)}
      aria-label="settings"
      title="settings"
    >
      ⚙
    </button>
    <button
      class="theme-toggle"
      onclick={() => setTheme(theme.name === "dark" ? "light" : "dark")}
      aria-label="toggle theme"
      title="toggle theme"
    >
      {theme.name === "dark" ? "☀" : "☾"}
    </button>
  </header>

  {#if board.loading}
    <div class="state">loading board…</div>
  {:else if board.view === "list"}
    <ListView />
  {:else}
    <main class="board">
      {#each board.lanes as lane, i (lane.id)}
        <LaneView {lane} index={i} />
      {/each}
      <AddLane />
    </main>
  {/if}

  {#if board.editing}
    <!-- keyed: navigating parent ↔ child inside the modal must remount it with fresh state -->
    {#key board.editing.id}
      {#if board.editMode}
        <TaskEditor />
      {:else}
        <TaskDetail />
      {/if}
    {/key}
  {/if}

  {#if agents.open}
    <SettingsPanel />
  {/if}

  {#if board.error}
    <button class="error-bar" onclick={() => (board.error = "")} title="dismiss">{board.error}</button>
  {/if}
</div>
