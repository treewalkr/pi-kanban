<script lang="ts">
  import { flip } from "svelte/animate";
  import type { Task } from "../../../src/db";
  import { board } from "./board.svelte";
  import { drag, FLIP_DURATION_MS } from "./drag.svelte";
  import CardView from "./Card.svelte";
  import IdChip from "./IdChip.svelte";
  import { renderMarkdown } from "./markdown";
  import { CircleSlash, GitBranch } from "@lucide/svelte";
  import { cycleChip, laneAgeChip } from "./statsview";
  import { ghChip } from "./ghview";
  import { canPromoteToPlan, nextPriority, queuedChip, QUIET_AFTER_MS, roleVerb, timeAgo } from "./util";
  import { waitingBadge } from "./waiting";

  let { task, child = false }: { task: Task; child?: boolean } = $props();

  let nested = $derived(board.nestedChildren(task));
  let progress = $derived(board.progressOf(task));
  let open = $derived(board.expanded.has(task.id));
  let parent = $derived(task.parentId ? board.taskById(task.parentId) : undefined);
  let parentChip = $derived(!!parent && !board.nestsUnder(task));
  let waiting = $derived(waitingBadge(board.waiting[task.id], !!board.activity[task.id] || !!board.queued[task.id]));
  let canPromote = $derived(canPromoteToPlan(task, board.lanes));
  let laneName = $derived(board.lanes.find((l) => l.id === task.laneId)?.name ?? task.laneId);
  let ageChip = $derived(laneAgeChip(board.stats, task, laneName));

  function openDetail(e: Event): void {
    e.stopPropagation();
    board.openCard(task);
  }
</script>

<div
  class="card"
  class:child
  class:blocked={board.isBlocked(task.id)}
  class:drag-slot={drag.taskId === task.id}
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
  onpointerdown={(e) => drag.press(task, e)}
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
    <button
      class="chip prio-chip prio-{task.priority}"
      aria-label={`priority ${task.id}: ${task.priority}`}
      title={`priority ${task.priority} — click to set ${nextPriority(task.priority)}; high rises to the lane top, low sinks to the bottom`}
      onclick={(e) => {
        e.stopPropagation();
        void board.cyclePriority(task.id);
      }}
      onkeydown={(e) => e.stopPropagation()}
    >
      {task.priority === "high" ? "▲" : task.priority === "low" ? "▼" : "·"}
    </button>
    {#if board.isBlocked(task.id)}
      <span class="chip blocked"><CircleSlash size={11} strokeWidth={1.75} /> blocked</span>
    {/if}
    {#if task.project}<span class="chip">{task.project}</span>{/if}
    {#if task.tags.length > 0}{#each task.tags as tag (tag)}<span class="chip tag">#{tag}</span>{/each}{/if}
    {#if board.workspaces[task.id]}
      {@const ws = board.workspaces[task.id]}
      <span class="chip ws" title={ws.path ?? "branch exists — no worktree checked out"}>
        <GitBranch size={11} strokeWidth={1.75} /> {ws.branch}
      </span>
    {/if}
    {#each board.ghLinks[task.id] ?? [] as link (link.id)}
      {@const chip = ghChip(link, board.ghStatuses[link.url] ?? null)}
      <a
        class={chip.className}
        href={link.url}
        title={chip.title}
        target="_blank"
        rel="noreferrer"
        onclick={(e) => e.stopPropagation()}>{chip.label}</a>
    {/each}
    {#if board.activity[task.id]}
      {@const live = board.activity[task.id]}
      {@const quiet = Date.now() - live.lastActivityAt > QUIET_AFTER_MS}
      <span
        class="chip working"
        class:quiet
        title={`started ${timeAgo(live.startedAt)} · last output ${timeAgo(live.lastActivityAt)}${live.model ? ` · ${live.model}` : ""} — open the card for live output`}
      >
        ◌ {roleVerb(live.role)} · active {timeAgo(live.lastActivityAt)}{#if live.model} · {live.model}{/if}
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
    {#if ageChip}
      <span class="age" title={ageChip.title}>{ageChip.label}</span>
    {:else}
      <span class="age" title={new Date(task.updatedAt).toLocaleString()}>{timeAgo(task.updatedAt)}</span>
    {/if}
  </div>
  {#if open && nested.length > 0}
    <div class="card-children" role="group" aria-label="subtasks of {task.title}">
      {#each drag.displayNest(task) as sub (sub.id)}
        <div animate:flip={{ duration: FLIP_DURATION_MS }}>
          <CardView task={sub} child />
        </div>
      {/each}
    </div>
  {/if}
</div>
