<script lang="ts">
  import { board } from "./board.svelte";
  import { laneDrag } from "./laneDrag.svelte";

  let rowsEl = $state<HTMLElement | null>(null);
  let newName = $state("");
  let renaming = $state<string | null>(null);
  let renameValue = $state("");
  let editingLimit = $state<string | null>(null);
  let limitValue = $state("");

  const dragOpts = {
    get lanes() {
      return board.lanes;
    },
    axis: "y" as const,
    allowTouch: true,
    elementOf: (id: string) => rowsEl?.querySelector(`[data-lane="${CSS.escape(id)}"]`) as HTMLElement | null,
    scrollElement: () => rowsEl,
    onCommit: (id: string, anchor: string | null) => void board.moveLaneBefore(id, anchor),
  };

  async function submit() {
    const name = newName.trim();
    if (!name) return;
    if (!(await board.addLane(name))) return; // keep the text so a failed post isn't lost
    newName = "";
  }

  function commitRename(laneId: string, original: string) {
    renaming = null;
    const name = renameValue.trim();
    if (name && name !== original) board.renameLane(laneId, name);
  }

  function commitLimit(laneId: string, current: number | null) {
    editingLimit = null;
    const v = limitValue.trim();
    if (v === "") {
      if (current !== null) board.setLaneLimit(laneId, null);
    } else if (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 999) {
      if (Number(v) !== current) board.setLaneLimit(laneId, Number(v));
    }
    // anything else cancels
  }
</script>

<div class="settings-general">
  <section class="settings-general-section">
    <h3 class="settings-general-heading">Lanes</h3>
    <p class="settings-general-description">
      Workflow stages on the board. Drag rows by the grip to reorder — fixed lanes (Waiting on you, Backlog, Done, Archive) stay pinned and refuse rename-by-drag, deletion and reordering. A lane holding cards refuses deletion until emptied.
    </p>

    <div class="lane-rows" bind:this={rowsEl}>
      {#each board.lanes as lane (lane.id)}
        <div
          class="lane-row"
          class:fixed={!!lane.fixed}
          class:lane-dragged={laneDrag.draggingLaneId === lane.id}
          data-lane={lane.id}
        >
          {#if laneDrag.dropBefore === lane.id}
            <div class="lane-drop-line"></div>
          {/if}
          {#if !lane.fixed}
            <button
              type="button"
              class="lane-row-grip"
              aria-label="reorder {lane.name}"
              title="drag to reorder"
              onpointerdown={(e) => laneDrag.press(e, lane.id, dragOpts)}
            >
              ⠿
            </button>
          {:else}
            <span class="lane-row-grip pad" title="fixed lane"></span>
          {/if}

          <span class="lane-row-name">
            {#if renaming === lane.id}
              <input
                aria-label="rename {lane.name}"
                bind:value={renameValue}
                onblur={() => commitRename(lane.id, lane.name)}
                onkeydown={(e) => {
                  if (e.key === "Enter") commitRename(lane.id, lane.name);
                  if (e.key === "Escape") renaming = null;
                }}
              />
            {:else}
              <span
                role="button"
                tabindex="-1"
                class="lane-row-name-text"
                title="double-click to rename"
                ondblclick={() => {
                  renameValue = lane.name;
                  renaming = lane.id;
                }}
              >
                {lane.name}
              </span>
            {/if}
          </span>

          <code class="lane-row-id">{lane.id}</code>

          {#if editingLimit === lane.id}
            <input
              class="lane-row-wip-input"
              aria-label="wip limit {lane.name}"
              bind:value={limitValue}
              title="WIP limit — Enter sets, empty clears, Escape cancels"
              onblur={() => commitLimit(lane.id, lane.wipLimit)}
              onkeydown={(e) => {
                if (e.key === "Enter") commitLimit(lane.id, lane.wipLimit);
                if (e.key === "Escape") editingLimit = null;
              }}
            />
          {:else}
            <span
              role="button"
              tabindex="-1"
              class="lane-row-wip"
              title="WIP limit — double-click to set or clear"
              ondblclick={() => {
                limitValue = lane.wipLimit === null ? "" : String(lane.wipLimit);
                editingLimit = lane.id;
              }}
            >
              {lane.wipLimit === null ? "no limit" : `wip ${lane.wipLimit}`}
            </span>
          {/if}

          {#if !lane.fixed}
            <button type="button" class="danger lane-row-delete" aria-label="delete {lane.name}" title="delete lane" onclick={() => board.removeLane(lane.id)}>
              ✕
            </button>
          {/if}
        </div>
      {/each}
    </div>

    <div class="lane-add-row">
      <input
        aria-label="new lane name"
        placeholder="lane name…"
        bind:value={newName}
        onkeydown={(e) => {
          if (e.key === "Enter") void submit();
        }}
      />
      <button type="button" aria-label="add lane" onclick={() => void submit()}>add lane</button>
    </div>
  </section>
</div>
