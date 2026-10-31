<script lang="ts">
  import { tick } from "svelte";
  import { board } from "./board.svelte";
  import { palette } from "./palette.svelte";
  import { paletteItems, type PaletteItem } from "./palette";

  let query = $state("");
  let selected = $state(0);

  let items = $derived(
    paletteItems({
      query,
      tasks: board.tasks,
      plans: board.plans,
      projects: board.projects,
      projectFilter: board.projectFilter,
      lanes: board.lanes,
      archiveOpen: board.archiveOpen,
    }),
  );
  let q = $derived(query.trim().toLowerCase());

  // clamp the selection when the result set shrinks under the cursor
  $effect(() => {
    selected = Math.max(0, Math.min(selected, items.length - 1));
  });

  // keep the keyboard selection visible in the scrolling list
  $effect(() => {
    void selected;
    document.querySelector(".palette-list [aria-selected=\"true\"]")?.scrollIntoView({ block: "nearest" });
  });

  function glyph(kind: PaletteItem["kind"]): string {
    if (kind === "project") return "~";
    if (kind === "lane") return "≡";
    return "▪";
  }

  function close(): void {
    palette.open = false;
    query = "";
    selected = 0;
  }

  async function run(item: PaletteItem): Promise<void> {
    const action = item.action;
    palette.open = false;
    query = "";
    selected = 0;
    if (action.type === "jump") {
      // tolerate an SSE-stale id: a missing task is a no-op
      const t = board.taskById(action.taskId);
      if (t) board.jumpTo(t);
    } else if (action.type === "project") {
      board.projectFilter = action.name;
    } else if (action.type === "lane-go") {
      // lanes only exist in board view
      if (board.view === "list") board.view = "board";
      if (action.laneId === "archive") board.archiveOpen = true;
      await tick();
      document
        .querySelector(`[data-lane="${CSS.escape(action.laneId)}"]`)
        ?.scrollIntoView({
          block: "center",
          inline: "center",
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        });
    } else if (action.type === "lane-move") {
      const i = board.lanes.findIndex((l) => l.id === action.laneId);
      if (i >= 0) void board.moveLane(action.laneId, i + action.dir);
    } else {
      board.archiveOpen = action.open;
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      // ⌘K must toggle the palette closed even while its own input is focused —
      // SearchBox's window handler early-returns on INPUT targets
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      selected = items.length ? (selected + dir + items.length) % items.length : 0;
    } else if (e.key === "Enter") {
      const item = items[selected];
      if (item) {
        e.preventDefault();
        void run(item);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  // move focus into the dialog so Tab doesn't cycle the board behind the overlay
  // — straight onto the query input so typing works immediately
  function autofocus(node: HTMLElement) {
    const input = node.querySelector<HTMLInputElement>("input.palette-input");
    (input ?? node).focus();
  }
</script>

<!-- backdrop click (on the overlay itself, not the panel) closes -->
<div
  class="overlay palette"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) close();
  }}
>
  <div
    class="palette-panel"
    role="dialog"
    aria-modal="true"
    aria-label="command palette"
    tabindex="-1"
    use:autofocus
  >
    <input
      class="palette-input"
      type="search"
      placeholder="jump to card, switch project, lane actions…"
      aria-label="command palette query"
      bind:value={query}
      oninput={() => (selected = 0)}
      onkeydown={onKeydown}
    />
    {#if items.length === 0}
      <div class="palette-empty">no matches</div>
    {:else}
      <div class="palette-list" role="listbox">
        {#each items as item, i (item.key)}
          {@const at = item.label.toLowerCase().indexOf(q)}
          <button
            class="palette-item"
            class:active={i === selected}
            role="option"
            aria-selected={i === selected}
            onpointerenter={() => (selected = i)}
            onclick={() => void run(item)}
          >
            <span class="glyph">{glyph(item.kind)}</span>
            <span class="body">
              <span class="palette-label">
                {#if at >= 0 && q !== ""}
                  {item.label.slice(0, at)}<mark>{item.label.slice(at, at + q.length)}</mark>{item.label.slice(at + q.length)}
                {:else}
                  {item.label}
                {/if}
              </span>
              <span class="palette-detail">{item.detail}</span>
            </span>
            <span class="jump">↵</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>
