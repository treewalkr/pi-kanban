<script lang="ts">
  import { board } from "./board.svelte";
  import { laneCycleRows, throughputBars } from "./statsview";
  import { formatDuration, shortDate } from "../../../src/thread";

  // velocity lens over the already-fetched /stats payload — no extra requests
  let bars = $derived(throughputBars(board.stats));
  let laneRows = $derived(laneCycleRows(board.stats, board.lanes));
</script>

<section class="velocity" aria-label="velocity — throughput per week and cycle time per lane">
  {#if board.stats === null}
    <div class="state">loading stats…</div>
  {:else}
    <div class="meta">
      {board.stats.board.wip} in progress{#if board.stats.board.cycleAvgMs !== null}&nbsp;· avg cycle {formatDuration(board.stats.board.cycleAvgMs)}{/if}
    </div>

    <h2>throughput / week</h2>
    <div class="tp-chart">
      {#each bars as bar, i (bar.weekStart)}
        <div class="tp-bar" class:current={i === bars.length - 1} data-done={bar.done}>
          <span class="tp-count">{bar.done}</span>
          <div class="tp-fill" style="height: {bar.heightPct}%"></div>
          <span class="tp-date">{shortDate(bar.weekStart, board.stats.generatedAt)}</span>
        </div>
      {/each}
    </div>

    <h2>cycle time per lane</h2>
    {#if laneRows.length === 0}
      <div class="empty">no lane visits yet</div>
    {:else}
      <div class="lane-rows">
        {#each laneRows as row (row.laneId)}
          <div class="lane-row" data-lane={row.laneId}>
            <span class="lane-name">{row.name}</span>
            <div class="lane-track">
              <div class="lane-bar" style="width: {row.widthPct}%"></div>
            </div>
            <span class="lane-ms">{formatDuration(row.avgMs)}</span>
            <span class="lane-cards">{row.cards} cards</span>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</section>
