<script lang="ts">
  import { board } from "./lib/board.svelte";
  import { agents } from "./lib/agents.svelte";
  import { ui, startViewportSync } from "./lib/ui.svelte";
  import { eventsUrl } from "./api";
  import LaneView from "./lib/Lane.svelte";
  import ListView from "./lib/ListView.svelte";
  import TaskDetail from "./lib/TaskDetail.svelte";
  import TaskEditor from "./lib/TaskEditor.svelte";
  import FilePreview from "./lib/FilePreview.svelte";
  import AddLane from "./lib/AddLane.svelte";
  import SearchBox from "./lib/SearchBox.svelte";
  import SettingsPanel from "./lib/SettingsPanel.svelte";
  import Sidebar from "./lib/Sidebar.svelte";
  import { theme, setTheme } from "./lib/theme.svelte";
  import { files } from "./lib/files.svelte";
  import { Settings, Sun, Moon, CircleSlash, PanelLeft, Menu } from "@lucide/svelte";
  import { wheelPan } from "./lib/wheel";

  let boardEl = $state<HTMLElement | null>(null);

  // sidebar width drag: pointer events on the thin handle between panel and board
  let resizing = $state(false);

  function startResize(e: PointerEvent): void {
    e.preventDefault();
    resizing = true;
    const startX = e.clientX;
    const startWidth = ui.sidebarWidth;
    const move = (ev: PointerEvent) => {
      ui.sidebarWidth = startWidth + (ev.clientX - startX);
    };
    const up = () => {
      resizing = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

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

  // reflect address-bar hash edits and back/forward navigation in the project focus
  $effect(() => {
    const onHashChange = () => board.applyProjectHash();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
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

  // the branch row reads the serving repo's git state; checkouts can happen in a terminal too
  $effect(() => {
    void ui.loadGit();
    const timer = setInterval(() => {
      if (!document.hidden) void ui.loadGit();
    }, 10_000);
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

  // narrow viewports: the sidebar starts (and becomes) a closed drawer over the board
  $effect(() => startViewportSync());

  // wheel over the board background (not over a lane) pans the lanes horizontally
  $effect(() => {
    const el = boardEl;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.target !== el) return; // over a lane: leave its scrolling alone
      const left = wheelPan(e, el);
      if (left === null) return;
      e.preventDefault();
      el.scrollLeft = left;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });
</script>

<div class="app" class:resizing>
  <aside
    class="sidebar"
    class:closed={!ui.sidebarOpen}
    style="--sidebar-width: {ui.sidebarWidth}px"
    aria-label="board sidebar"
  >
    <Sidebar />
  </aside>
  {#if ui.sidebarOpen}
    <div
      class="sidebar-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="resize sidebar"
      title="resize sidebar: drag"
      onpointerdown={startResize}
    ></div>
    <div class="sidebar-backdrop" onclick={() => (ui.sidebarOpen = false)} aria-hidden="true"></div>
  {/if}

  <div class="main">
    <header class="top">
      <button
        class="sidebar-toggle"
        onclick={() => (ui.sidebarOpen = !ui.sidebarOpen)}
        title={ui.sidebarOpen ? "hide sidebar" : "show sidebar"}
        aria-label={ui.sidebarOpen ? "hide sidebar" : "show sidebar"}
      >
        {#if ui.sidebarOpen}
          <PanelLeft size={16} strokeWidth={2} />
        {:else}
          <Menu size={18} strokeWidth={2} />
        {/if}
      </button>
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
        <button
          class:active={board.prioFilter === "high"}
          onclick={() => (board.prioFilter = board.prioFilter === "high" ? "" : "high")}
          title="filter high priority"
        >
          ▲ high
        </button>
        <button
          class:active={board.blockedOnly}
          onclick={() => (board.blockedOnly = !board.blockedOnly)}
          title="filter blocked only"
        >
          <CircleSlash size={12} strokeWidth={1.75} /> blocked
        </button>
        <button
          class:active={board.waitingOnly}
          onclick={() => (board.waitingOnly = !board.waitingOnly)}
          title="filter cards waiting on you"
        >
          ☉ {board.waitingCount} waiting
        </button>
      </div>
      <div class="meta">{board.activeCount} tasks</div>
      <button
        class="theme-toggle"
        onclick={() => {
          if (agents.open) void agents.close();
          else agents.open = true;
        }}
        aria-label="settings"
        title="settings"
      >
        <Settings size={14} strokeWidth={1.75} />
      </button>
      <button
        class="theme-toggle"
        onclick={() => setTheme(theme.name === "dark" ? "light" : "dark")}
        aria-label="toggle theme"
        title="toggle theme"
      >
        {#if theme.name === "dark"}
          <Sun size={14} strokeWidth={1.75} />
        {:else}
          <Moon size={14} strokeWidth={1.75} />
        {/if}
      </button>
    </header>

    {#if board.loading}
      <div class="state">loading board…</div>
    {:else if board.view === "list"}
      <ListView />
    {:else}
      <main class="board" bind:this={boardEl}>
        {#each board.visibleLanes as { lane, index } (lane.id)}
          <LaneView {lane} {index} />
        {/each}
        <AddLane />
      </main>
    {/if}
  </div>

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

  {#if files.preview}
    <FilePreview />
  {/if}

  {#if agents.open}
    <SettingsPanel />
  {/if}

  {#if board.error}
    <button class="error-bar" onclick={() => (board.error = "")} title="dismiss">{board.error}</button>
  {/if}
</div>
