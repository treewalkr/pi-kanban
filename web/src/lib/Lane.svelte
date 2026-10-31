<script lang="ts">
  import type { Lane } from "../../../src/db";
  import { board } from "./board.svelte";
  import CardView from "./Card.svelte";
  import Composer from "./Composer.svelte";
  import { laneDwellLabel } from "./statsview";
  import { laneColor } from "./util";

  let { lane, index }: { lane: Lane; index: number } = $props();

  let el = $state<HTMLElement>();
  let composing = $state(false);
  let renaming = $state(false);
  let renameValue = $state("");
  let editingLimit = $state(false);
  let limitValue = $state("");

  let visible = $derived(board.visibleTasks(lane.id));
  let count = $derived(
    board.projectFilter !== "" ? board.visibleTasks(lane.id).length : board.laneCount(lane.id),
  );
  let hint = $derived(
    board.dropHint && board.dropHint.laneId === lane.id ? board.dropHint.index : -1,
  );
  let isArchive = $derived(lane.id === "archive");
  let collapsed = $derived(isArchive && !board.archiveOpen && !board.archiveSearchHit);

  function hintIndex(e: DragEvent): number {
    if (!el) return 0;
    const card = (e.target as HTMLElement).closest("[data-card]");
    const cards = [...el.querySelectorAll("[data-card]")];
    if (!card) return cards.length;
    const i = cards.indexOf(card as HTMLElement);
    const r = (card as HTMLElement).getBoundingClientRect();
    return i + (e.clientY > r.top + r.height / 2 ? 1 : 0);
  }

  function ondragover(e: DragEvent) {
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    board.dropHint = { laneId: lane.id, index: hintIndex(e) };
  }

  function ondrop(e: DragEvent) {
    e.preventDefault();
    const id = e.dataTransfer!.getData("text/plain");
    const at = hint >= 0 ? hint : undefined;
    board.dropHint = null;
    board.dragging = null;
    if (id) board.moveTask(id, lane.id, at);
  }

  function ondragleave(e: DragEvent) {
    const to = e.relatedTarget as Node | null;
    if (!el || !el.contains(to)) board.dropHint = null;
  }

  function commitRename() {
    renaming = false;
    const name = renameValue.trim();
    if (name && name !== lane.name) board.renameLane(lane.id, name);
  }

  function commitLimit() {
    editingLimit = false;
    const v = limitValue.trim();
    if (v === "") {
      if (lane.wipLimit !== null) board.setLaneLimit(lane.id, null);
    } else if (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 999) {
      if (Number(v) !== lane.wipLimit) board.setLaneLimit(lane.id, Number(v));
    }
    // anything else cancels
  }
</script>

{#if collapsed}
  <section
    class="lane collapsed"
    style="--accent: {laneColor(index)}"
    role="group"
    aria-label="{lane.name} (collapsed)"
    ondragover={(e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
    }}
    ondrop={(e) => {
      e.preventDefault();
      const id = e.dataTransfer!.getData("text/plain");
      board.dragging = null;
      if (id) board.moveTask(id, lane.id);
    }}
  >
    <button class="collapsed-head" title="expand {lane.name}" onclick={() => (board.archiveOpen = true)}>
      <span class="lane-dot"></span>
      <span class="collapsed-name">{lane.name}</span>
      <span class="count" class:over={lane.wipLimit !== null && count > lane.wipLimit}>
        {lane.wipLimit === null ? count : `${count}/${lane.wipLimit}`}
      </span>
    </button>
  </section>
{:else}
  <section
    class="lane"
    class:archive-lane={isArchive}
    bind:this={el}
    style="--accent: {laneColor(index)}"
    role="group"
    aria-label={lane.name}
    ondragover={ondragover}
    ondrop={ondrop}
    ondragleave={ondragleave}
  >
    <header class="lane-head">
      <span class="lane-dot"></span>
      {#if renaming}
        <input
          class="rename"
          bind:value={renameValue}
          onblur={commitRename}
          onkeydown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") renaming = false;
          }}
        />
      {:else}
        <h2 title="{lane.description} (double-click to rename)" ondblclick={() => { renameValue = lane.name; renaming = true; }}>
          {lane.name}
        </h2>
      {/if}
      {#if editingLimit}
        <input
          class="rename limit-input"
          bind:value={limitValue}
          title="WIP limit — Enter sets, empty clears, Escape cancels"
          onblur={commitLimit}
          onkeydown={(e) => {
            if (e.key === "Enter") commitLimit();
            if (e.key === "Escape") editingLimit = false;
          }}
        />
      {:else}
        <span
          role="button"
          tabindex="-1"
          class="count"
          class:over={lane.wipLimit !== null && count > lane.wipLimit}
          title="WIP limit — double-click to set or clear"
          ondblclick={() => {
            limitValue = lane.wipLimit === null ? "" : String(lane.wipLimit);
            editingLimit = true;
          }}
        >
          {lane.wipLimit === null ? count : `${count}/${lane.wipLimit}`}
        </span>
      {/if}
      {#if laneDwellLabel(board.stats, lane.id)}
        <span class="lane-dwell" title="average time per card in this lane">{laneDwellLabel(board.stats, lane.id)}</span>
      {/if}
      <span class="lane-tools">
        {#if isArchive}
          <button title="collapse lane" onclick={() => (board.archiveOpen = false)}>»</button>
        {/if}
        {#if index > 0}
          <button title="move lane left" onclick={() => board.moveLane(lane.id, index - 1)}>‹</button>
        {/if}
        {#if index < board.lanes.length - 1}
          <button title="move lane right" onclick={() => board.moveLane(lane.id, index + 1)}>›</button>
        {/if}
        {#if !lane.fixed}
          <button class="danger" title="delete lane" onclick={() => board.removeLane(lane.id)}>✕</button>
        {/if}
      </span>
    </header>

    <div class="cards">
      {#each visible as task, i (task.id)}
        {#if hint === i}<div class="drop-gap"></div>{/if}
        <CardView {task} />
      {/each}
      {#if hint >= visible.length}<div class="drop-gap"></div>{/if}
    </div>

    {#if composing}
      <Composer {lane} onclose={() => (composing = false)} />
    {:else}
      <button class="add-card" onclick={() => (composing = true)}>+ add a card</button>
    {/if}
  </section>
{/if}
