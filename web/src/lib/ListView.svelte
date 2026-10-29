<script lang="ts">
  import { board } from "./board.svelte";
  import { listRows } from "./listview";
  import IdChip from "./IdChip.svelte";
  import { laneColor, timeAgo } from "./util";

  // hierarchy-first lens: subtasks nest under parents regardless of lane,
  // so the board's lane-first scattering doesn't hide the structure
  let rows = $derived(listRows(board.tasks, (t) => board.matches(t)));

  // parents that have rendered children (look-ahead: rows deeper than this one)
  let hasKids = $derived.by(() => {
    const ids = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length && rows[j]!.depth > rows[i]!.depth; j++) {
        ids.add(rows[i]!.task.id);
      }
    }
    return ids;
  });

  // default open — collapse hides a parent's descendants
  let shown = $derived(
    rows.filter((r) => board.ancestorsOf(r.task.id).every((a) => !board.listCollapsed.has(a.id))),
  );

  let laneIndex = (id: string): number => Math.max(0, board.lanes.findIndex((l) => l.id === id));
</script>

<main class="list" aria-label="all cards by hierarchy">
  {#if shown.length === 0}
    <div class="state">{board.search.trim() ? "no cards match" : "no cards yet"}</div>
  {:else}
    <div class="list-panel">
      {#each shown as row (row.task.id)}
        {@const task = row.task}
        {@const collapsed = board.listCollapsed.has(task.id)}
        <div
          class="row"
          class:dim={row.dim}
          class:done={task.laneId === "done"}
          style="padding-left: {14 + row.depth * 22}px"
          data-card={task.id}
          role="button"
          tabindex="0"
          onclick={() => board.openCard(task)}
          onkeydown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              board.openCard(task);
            }
          }}
        >
          {#if hasKids.has(task.id)}
            <button
              class="disclosure"
              title={collapsed ? "expand subtasks" : "collapse subtasks"}
              aria-expanded={!collapsed}
              onclick={(e) => {
                e.stopPropagation();
                board.toggleListCollapsed(task.id);
              }}
            >
              {collapsed ? "▸" : "▾"}
            </button>
          {:else}
            <span class="leaf" aria-hidden="true"></span>
          {/if}
          <span class="lane-badge" style="--accent: {laneColor(laneIndex(task.laneId))}">
            <span class="lane-dot"></span>
            {board.lanes[laneIndex(task.laneId)]?.name ?? task.laneId}
          </span>
          <span class="row-title" title={task.title}>{task.title}</span>
          {#if task.priority === "high"}
            <span class="chip prio-high" title="high priority">▲</span>
          {:else if task.priority === "low"}
            <span class="chip prio-low" title="low priority">▼</span>
          {/if}
          {#if board.isBlocked(task.id)}<span class="chip blocked" title="blocked by unfinished work">⊘</span>{/if}
          {#if row.total > 0}
            <span class="progress" class:complete={row.done === row.total}>
              {row.done}/{row.total} ✓
            </span>
          {/if}
          {#if task.parentId && board.taskById(task.parentId)?.laneId === "archive"}
            {@const parent = board.taskById(task.parentId)!}
            <button
              class="parent-chip"
              title="open parent card (archived)"
              onclick={(e) => {
                e.stopPropagation();
                board.openCard(parent);
              }}
            >
              ↑ {parent.title}
            </button>
          {/if}
          {#if task.project}<span class="chip">{task.project}</span>{/if}
          {#if board.activity[task.id]}
            <span class="chip working" title="pi agent working — open the card for live output">◌ working</span>
          {/if}
          {#if board.queued[task.id]}
            <span class="chip queued" title="waiting for the running agent session">⧗ queued</span>
          {/if}
          <span class="row-meta">
            <IdChip id={task.id} />
            <span class="age" title={new Date(task.updatedAt).toLocaleString()}>{timeAgo(task.updatedAt)}</span>
          </span>
        </div>
      {/each}
    </div>
  {/if}
</main>
