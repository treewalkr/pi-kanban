<script lang="ts">
  import { board } from "./lib/board.svelte";
  import { agents } from "./lib/agents.svelte";
  import { manager } from "./lib/manager.svelte";
  import { ui, startViewportSync } from "./lib/ui.svelte";
  import { eventsUrl } from "./api";
  import LaneView from "./lib/Lane.svelte";
  import ListView from "./lib/ListView.svelte";
  import VelocityView from "./lib/VelocityView.svelte";
  import TaskDetail from "./lib/TaskDetail.svelte";
  import TaskEditor from "./lib/TaskEditor.svelte";
  import FilePreview from "./lib/FilePreview.svelte";
  import ProjectPicker from "./lib/ProjectPicker.svelte";
  import DragLayer from "./lib/DragLayer.svelte";
  import AddLane from "./lib/AddLane.svelte";
  import SearchBox from "./lib/SearchBox.svelte";
  import Palette from "./lib/CommandPalette.svelte";
  import { palette } from "./lib/palette.svelte";
  import { projectPicker } from "./lib/projectPicker.svelte.js";
  import SettingsPanel from "./lib/SettingsPanel.svelte";
  import ManagerChat from "./lib/ManagerChat.svelte";
  import Sidebar from "./lib/Sidebar.svelte";
  import { theme, setTheme } from "./lib/theme.svelte";
  import { notify } from "./lib/notify.svelte";
  import { files } from "./lib/files.svelte";
  import { Settings, Sun, Moon, CircleSlash, PanelLeft, Menu, Hash, MessagesSquare, Eye, EyeOff, Square } from "@lucide/svelte";
  import { wheelPan } from "./lib/wheel";
  import { service, pollServe, restartService } from "./lib/service.svelte";
  import ConfirmDialog from "./lib/ConfirmDialog.svelte";
  import { QUIET_AFTER_MS, roleVerb, timeAgo } from "./lib/util";
  import type { AgentSessionInfo } from "../../src/autoreview";

  let boardEl = $state<HTMLElement | null>(null);
  let tagMenu = $state(false);
  let tagWrap = $state<HTMLElement | null>(null);
  let agentsMenu = $state(false);
  let agentsWrap = $state<HTMLElement | null>(null);
  // the session a stop confirm is pending on (header popover only; TaskDetail confirms in place)
  let stopTarget = $state<AgentSessionInfo | null>(null);

  // live sessions oldest-first, the popover's row order
  let liveSessions = $derived(Object.values(board.activity).sort((a, b) => a.startedAt - b.startedAt));

  function toggleTag(tag: string): void {
    board.tagFilter = board.tagFilter.includes(tag)
      ? board.tagFilter.filter((t) => t !== tag)
      : [...board.tagFilter, tag];
  }

  // sidebar width drag: pointer events on the thin handle between panel and board
  let resizing = $state(false);

  // the handle stacks above the modal overlays (z 45 > 40), so hide it while any is open
  const modalOpen = $derived(
    !!board.editing || !!files.preview || agents.open || manager.open || palette.open || projectPicker.open,
  );

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

  // initial load, plus catch-up when a modal closes (change events are paused while the editor is open)
  $effect(() => {
    if (!board.editing) board.refresh();
  });

  // the project chip scopes /stats, so switching projects refetches without a
  // DB write to trigger the SSE refresh
  let lastProject = board.projectFilter;
  $effect(() => {
    const project = board.projectFilter;
    if (project !== lastProject) {
      lastProject = project;
      if (!board.editMode) void board.refresh();
    }
  });

  // keep the board in sync with CLI-side and other-tab writes, pushed over SSE
  $effect(() => {
    const source = new EventSource(eventsUrl);
    const refresh = () => {
      if (!document.hidden && !board.editMode) board.refresh();
    };
    let opened = false;
    source.addEventListener("change", refresh);
    source.addEventListener("lane", (e) => notify.onLaneData((e as MessageEvent<string>).data));
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

  // serve runs old code until restarted (src changes don't hot-swap) — surface staleness
  $effect(() => {
    const poll = () => {
      if (!document.hidden) void pollServe();
    };
    poll();
    const timer = setInterval(poll, 30_000);
    return () => clearInterval(timer);
  });

  async function restartFromChip(): Promise<void> {
    if (service.restarting) return;
    const result = await restartService();
    if (result.ok) location.reload(); // fresh bundle, fresh SSE wiring
    else if (result.failed) alert(result.note); // refusals already spoke via confirm
  }

  // the branch row reads the serving repo's git state; checkouts can happen in a terminal too
  $effect(() => {
    void ui.loadGit();
    const timer = setInterval(() => {
      if (!document.hidden) {
        void ui.loadGit();
        // terminal worktree changes emit no DB event
        if (!board.editMode) board.refresh();
      }
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

  /** close the tag filter and agents menus on Escape or any click outside them (SearchBox pattern) */
  function onWindowEvent(e: MouseEvent | KeyboardEvent): void {
    if (!tagMenu && !agentsMenu) return;
    if (e instanceof KeyboardEvent) {
      if (e.key === "Escape") {
        tagMenu = false;
        agentsMenu = false;
      }
      return;
    }
    if (tagWrap && !tagWrap.contains(e.target as Node)) tagMenu = false;
    if (agentsWrap && !agentsWrap.contains(e.target as Node)) agentsMenu = false;
  }
</script>

<svelte:window onkeydown={onWindowEvent} onclick={onWindowEvent} />

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
    {#if !modalOpen}
      <div
        class="sidebar-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="resize sidebar"
        title="resize sidebar: drag"
        onpointerdown={startResize}
      ></div>
    {/if}
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
        <button
          class:active={board.view === "velocity"}
          role="tab"
          aria-selected={board.view === "velocity"}
          title="velocity — throughput per week and cycle time per lane"
          onclick={() => (board.view = "velocity")}>velocity</button
        >
      </div>
      <button
        type="button"
        class="view-chat"
        class:active={manager.open}
        title="board chat — the manager dispatches lane workers"
        aria-label="board chat"
        aria-pressed={manager.open}
        onclick={() => void manager.toggle()}
      >
        <MessagesSquare size={14} strokeWidth={1.8} aria-hidden="true" />
        <span class="view-chat-label">chat</span>
      </button>
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
        <button
          class:active={board.showEmptyLanes}
          onclick={() => (board.showEmptyLanes = !board.showEmptyLanes)}
          title="show empty lanes"
          aria-label="show empty lanes"
        >
          {#if board.showEmptyLanes}
            <Eye size={12} strokeWidth={1.75} />
          {:else}
            <EyeOff size={12} strokeWidth={1.75} />
          {/if}
        </button>
        {#if board.tags.length > 0}
          <div class="tag-filter" bind:this={tagWrap}>
            <button
              class:active={board.tagFilter.length > 0 || tagMenu}
              onclick={() => (tagMenu = !tagMenu)}
              title="filter by tag (AND)"
            >
              <Hash size={12} strokeWidth={1.75} /> tags{board.tagFilter.length > 0 ? ` ${board.tagFilter.length}` : ""}
            </button>
            {#if tagMenu}
              <div class="tag-menu" role="menu">
                {#each board.tags as tag (tag)}
                  <button
                    class="tag"
                    class:active={board.tagFilter.includes(tag)}
                    title="filter tag (AND)"
                    onclick={() => toggleTag(tag)}
                  >
                    #{tag}
                  </button>
                {/each}
                {#if board.tagFilter.length > 0}
                  <button class="tag-clear" onclick={() => (board.tagFilter = [])}>clear</button>
                {/if}
              </div>
            {/if}
          </div>
        {/if}
        {#if liveSessions.length > 0}
          <div class="agents-filter" bind:this={agentsWrap}>
            <button
              class:active={agentsMenu}
              onclick={() => (agentsMenu = !agentsMenu)}
              title="live agent sessions — open the list to watch or stop one"
              aria-haspopup="menu"
              aria-expanded={agentsMenu}
            >
              <span class="agents-dot" aria-hidden="true"></span>
              {liveSessions.length} agent{liveSessions.length === 1 ? "" : "s"}
            </button>
            {#if agentsMenu}
              <div class="agents-menu" role="menu" aria-label="live agent sessions">
                {#each liveSessions as s (s.taskId)}
                  {@const card = board.taskById(s.taskId)}
                  {@const quiet = Date.now() - s.lastActivityAt > QUIET_AFTER_MS}
                  <div class="agents-row" title={card?.title ?? s.taskId}>
                    <button
                      class="agents-main"
                      onclick={() => {
                        agentsMenu = false;
                        if (card) board.openCard(card);
                      }}
                    >
                      <span class="agents-verb">{roleVerb(s.role)}</span>
                      <span class="agents-id">{s.taskId}</span>
                      <span class="agents-active" class:quiet>active {timeAgo(s.lastActivityAt)}</span>
                    </button>
                    <button
                      class="agents-stop"
                      title="kill this session — its transcript is kept and a resume offer appears on the card"
                      onclick={() => (stopTarget = s)}
                    >
                      <Square size={10} strokeWidth={2} aria-hidden="true" />
                    </button>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
      {#if stopTarget}
        <ConfirmDialog
          title="stop agent session"
          message={`Kill the live ${roleVerb(stopTarget.role)} session on ${stopTarget.taskId}? Its transcript is kept and a resume offer appears on the card.`}
          confirmLabel="stop"
          onconfirm={() => {
            const id = stopTarget?.taskId;
            stopTarget = null;
            if (id) void board.stopSession(id);
          }}
          oncancel={() => (stopTarget = null)}
        />
      {/if}
      {#if service.stale || service.restarting}
        <button
          class="stale-chip"
          onclick={() => void restartFromChip()}
          title={service.detail ?? "rebuilding + restarting the server…"}
        >
          ⟳ {service.restarting ? "restarting…" : "stale"}
        </button>
      {/if}
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
    {:else if board.view === "velocity"}
      <VelocityView />
    {:else}
      <main class="board" bind:this={boardEl}>
        {#each board.visibleLanes as { lane, index } (lane.id)}
          <LaneView {lane} {index} />
        {/each}
        <AddLane />
      </main>
      <DragLayer />
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

  {#if projectPicker.open}
    <ProjectPicker />
  {/if}

  {#if agents.open}
    <SettingsPanel />
  {/if}

  {#if manager.open}
    <ManagerChat />
  {/if}

  {#if palette.open}<Palette />{/if}

  {#if board.error}
    <button class="error-bar" onclick={() => (board.error = "")} title="dismiss">{board.error}</button>
  {/if}
</div>
