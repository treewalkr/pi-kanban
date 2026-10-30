<script lang="ts">
  import type { Task } from "../../../src/db";
  import { board } from "./board.svelte";
  import CardView from "./Card.svelte";
  import IdChip from "./IdChip.svelte";
  import { renderMarkdown } from "./markdown";
  import { CircleSlash, GitBranch } from "@lucide/svelte";
  import { cycleChip } from "./statsview";
  import { canPromoteToPlan, queuedChip, timeAgo } from "./util";
  import { waitingBadge } from "./waiting";

  let { task, child = false }: { task: Task; child?: boolean } = $props();

  let nested = $derived(board.nestedChildren(task));
  let progress = $derived(board.progressOf(task));
  let open = $derived(board.expanded.has(task.id));
  let parent = $derived(task.parentId ? board.taskById(task.parentId) : undefined);
  let parentChip = $derived(!!parent && !board.nestsUnder(task));
  let waiting = $derived(waitingBadge(board.waiting[task.id], !!board.activity[task.id] || !!board.queued[task.id]));
  let canPromote = $derived(canPromoteToPlan(task, board.lanes));

  function openDetail(e: Event): void {
    e.stopPropagation();
    board.openCard(task);
  }
</script>

<div
  class="card"
  class:child
  class:blocked={board.isBlocked(task.id)}
  class:dragging={board.dragging === task.id}
  draggable="true"
  data-card={task.id}
  role="button"
  tabindex="0"
  onclick={openDetail}
  onkeydown={(e) => {
    // role="button" convention: both Enter and Space activate
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDetail(e);
    }
  }}
  ondragstart={(e) => {
    e.dataTransfer!.setData("text/plain", task.id);
    e.dataTransfer!.effectAllowed = "move";
    board.dragging = task.id;
  }}
  ondragend={() => {
    board.dragging = null;
    board.dropHint = null;
  }}
>
  {#if canPromote}
    <button
      class="promote"
      title="move to Plan"
      onclick={(e) => {
        e.stopPropagation();
        board.moveTask(task.id, "plan");
      }}
      onkeydown={(e) => e.stopPropagation()}
    >
      → Plan
    </button>
  {/if}
  {#if parentChip && parent}
    <button
      class="parent-chip"
      title="open parent card"
      onclick={(e) => {
        e.stopPropagation();
        board.openCard(parent);
      }}
    >
      ↑ {parent.title}
    </button>
  {/if}
  <div class="card-title">
    {#if nested.length > 0}
      <button
        class="disclosure"
        title={open ? "collapse subtasks" : "expand subtasks"}
        aria-expanded={open}
        onclick={(e) => {
          e.stopPropagation();
          board.toggleExpanded(task.id);
        }}
      >
        {open ? "▾" : "▸"}
      </button>
    {/if}
    {task.title}
    {#if progress.total > 0}
      <span class="progress" class:complete={progress.done === progress.total}>
        {progress.done}/{progress.total} ✓
      </span>
    {/if}
  </div>
  {#if task.note}<div class="card-note md">{@html renderMarkdown(task.note)}</div>{/if}
  <div class="card-meta">
    <IdChip id={task.id} />
    {#if task.priority === "high"}
      <span class="chip prio-high">▲ high</span>
    {:else if task.priority === "low"}
      <span class="chip prio-low">▼ low</span>
    {/if}
    {#if board.isBlocked(task.id)}
      <span class="chip blocked"><CircleSlash size={11} strokeWidth={1.75} /> blocked</span>
    {/if}
    {#if task.project}<span class="chip">{task.project}</span>{/if}
    {#if board.workspaces[task.id]}
      {@const ws = board.workspaces[task.id]}
      <span class="chip ws" title={ws.path ?? "branch exists — no worktree checked out"}>
        <GitBranch size={11} strokeWidth={1.75} /> {ws.branch}
      </span>
    {/if}
    {#if board.activity[task.id]}
      <span class="chip working" title="pi agent working — open the card for live output">
        ◌ {board.activity[task.id].role === "reviewer"
          ? "reviewing"
          : board.activity[task.id].role === "plan-reviewer"
            ? "checking plan"
            : board.activity[task.id].role === "planner"
              ? "planning"
              : board.activity[task.id].role === "elaborator"
                ? "elaborating"
                : "building"} · {timeAgo(board.activity[task.id].startedAt)}{#if board.activity[task.id].model} · {board.activity[task.id].model}{/if}
      </span>
    {/if}
    {#if board.queued[task.id]}
      <span class="chip queued" title={queuedChip(board.queued[task.id]).title}>
        {queuedChip(board.queued[task.id]).label}
      </span>
    {/if}
    {#if waiting}
      <span class="chip waiting waiting-{waiting.state}" title={waiting.title}>{waiting.label}</span>
    {/if}
    {#if task.laneId === "waiting" && task.previousLane}
      {@const originName = board.lanes.find((l) => l.id === task.previousLane)?.name ?? task.previousLane}
      <span class="chip origin" title="returns to {originName} when you reply">↩ from {originName}</span>
    {/if}
    {#if cycleChip(board.stats, task)}
      {@const chip = cycleChip(board.stats, task)!}
      <span class="cycle-chip" title={chip.title}>⏱ {chip.label}</span>
    {/if}
    <span class="age" title={new Date(task.updatedAt).toLocaleString()}>{timeAgo(task.updatedAt)}</span>
  </div>
  {#if open && nested.length > 0}
    <div class="card-children" role="group" aria-label="subtasks of {task.title}">
      {#each nested as sub (sub.id)}
        <CardView task={sub} child />
      {/each}
    </div>
  {/if}
</div>
