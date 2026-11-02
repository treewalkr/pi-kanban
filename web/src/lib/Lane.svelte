<script lang="ts">
  import { flip } from "svelte/animate";
  import type { Lane } from "../../../src/db";
  import { board } from "./board.svelte";
  import { agents } from "./agents.svelte";
  import { drag, FLIP_DURATION_MS } from "./drag.svelte";
  import CardView from "./Card.svelte";
  import Composer from "./Composer.svelte";
  import { laneDwellLabel } from "./statsview";
  import { laneColor } from "./util";

  let { lane, index }: { lane: Lane; index: number } = $props();

  let composing = $state(false);
  let renaming = $state(false);
  let renameValue = $state("");
  let editingLimit = $state(false);
  let limitValue = $state("");

  let count = $derived(
    board.projectFilter !== "" ? board.visibleTasks(lane.id).length : board.laneCount(lane.id),
  );
  let isArchive = $derived(lane.id === "archive");
  let collapsed = $derived(board.collapsedLanes.has(lane.id) && !board.laneSearchHit(lane.id));

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
    data-lane={lane.id}
    style="--accent: {laneColor(index)}"
    role="group"
    aria-label="{lane.name} (collapsed)"
  >
    <button class="collapsed-head" title="expand {lane.name}" onclick={() => board.setLaneCollapsed(lane.id, false)}>
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
    data-lane={lane.id}
    style="--accent: {laneColor(index)}"
    role="group"
    aria-label={lane.name}
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
        {#if lane.id !== "waiting" && lane.id !== "done" && lane.id !== "archive"}
          <button title="lane workflow settings" aria-label="configure {lane.name}" onclick={() => agents.openLane(lane.id)}>⚙</button>
        {/if}
        <button title="collapse lane" aria-label="collapse {lane.name}" onclick={() => board.setLaneCollapsed(lane.id, true)}>«</button>
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
      {#each drag.displayTasks(lane.id) as task (task.id)}
        <div animate:flip={{ duration: FLIP_DURATION_MS }}>
          <CardView {task} />
        </div>
      {/each}
    </div>

    {#if composing}
      <Composer {lane} onclose={() => (composing = false)} />
    {:else}
      <button class="add-card" onclick={() => (composing = true)}>+ add a card</button>
    {/if}
  </section>
{/if}
