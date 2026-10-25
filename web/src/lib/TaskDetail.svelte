<script lang="ts">
  import type { Attachment, Comment, Task } from "../../../src/db";
  import { api } from "../api";
  import { board } from "./board.svelte";
  import IdChip from "./IdChip.svelte";
  import { renderMarkdown } from "./markdown";
  import { laneColor, timeAgo } from "./util";

  const task = board.editing!;

  // live copy: refresh replaces board.tasks, so derive everything hierarchy-ish from it
  let me = $derived(board.taskById(task.id) ?? task);
  let plan = $derived(board.plans[task.id]);
  let ancestors = $derived(board.ancestorsOf(task.id));
  let progress = $derived(board.progressOf(me));

  // descendants flattened with depth for the tree list
  let childRows = $derived.by(() => {
    const rows: Array<{ t: Task; depth: number }> = [];
    const walk = (id: string, depth: number): void => {
      for (const c of board.childrenOf(id)) {
        rows.push({ t: c, depth });
        walk(c.id, depth + 1);
      }
    };
    walk(task.id, 0);
    return rows;
  });

  // subtasks cannot have children — hide the composer one level above that
  let canAddSubtasks = $derived(ancestors.length < 2);

  // live agent session on this card (badge's big sibling: the streamed log)
  let live = $derived(board.activity[me.id]);
  let logEl = $state<HTMLElement | null>(null);

  $effect(() => {
    void live?.log.length; // re-run as lines arrive
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  });

  let laneIndex = $derived(Math.max(0, board.lanes.findIndex((l) => l.id === me.laneId)));
  let laneName = $derived(board.lanes[laneIndex]?.name ?? me.laneId);
  let subtaskTitle = $state("");

  const fmt = (ts: number) => new Date(ts).toLocaleString();

  // move focus into the dialog so Tab doesn't cycle the board behind the overlay
  function autofocus(node: HTMLElement) {
    node.focus();
  }

  const childLaneIndex = (t: Task): number =>
    Math.max(0, board.lanes.findIndex((l) => l.id === t.laneId));

  async function toLane(laneId: string) {
    await board.moveTask(task.id, laneId);
    board.closeCard();
  }

  async function addSubtask() {
    const title = subtaskTitle.trim();
    if (!title) return;
    if (await board.addTask(me.laneId, title, undefined, task.id)) subtaskTitle = "";
  }

  // the plan gate: approve arms the plan-build builder, reject re-arms the planner
  let rejecting = $state(false);
  let rejectMsg = $state("");

  const gateFail = (error: unknown): void => {
    const value = (error as { value?: unknown })?.value as { error?: string } | undefined;
    board.error = value?.error ?? "request failed";
  };

  async function approve() {
    const { error } = await api.tasks({ id: task.id }).approve.post();
    if (error) return gateFail(error);
    board.closeCard(); // card now lives in Test + Implement
  }

  async function reject() {
    const message = rejectMsg.trim();
    if (!message) return;
    const { error } = await api.tasks({ id: task.id }).reject.post({ message });
    if (error) return gateFail(error);
    board.closeCard(); // planner re-plans with the feedback
  }

  // per-card thread state: fetch on open, append after own post — SSE refresh
  // is paused while a modal is open, so a reopen catches CLI-side comments
  let comments = $state<Comment[]>([]);
  let commentBody = $state("");

  // finished agent sessions saved on the card (live one renders above these)
  let sessionLogs = $state<Attachment[]>([]);

  $effect(() => {
    api.tasks({ id: task.id }).comments.get().then(({ data, error }) => {
      if (!error) comments = data;
    });
    api.tasks({ id: task.id }).sessions.get().then(({ data, error }) => {
      if (!error) sessionLogs = data;
    });
  });

  async function addComment() {
    const body = commentBody.trim();
    if (!body) return;
    const { data, error } = await api.tasks({ id: task.id }).comments.post({ body });
    if (error) return; // keep the text so a failed post isn't lost
    comments.push(data);
    commentBody = "";
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape") board.closeCard();
  }}
/>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) board.closeCard();
  }}
>
  <div
    class="editor detail"
    role="dialog"
    aria-modal="true"
    aria-label="card details"
    tabindex="-1"
    use:autofocus
    style="--accent: {laneColor(laneIndex)}"
  >
    <div class="detail-head">
      <span class="lane-dot"></span>
      <span class="detail-lane">{laneName}</span>
      {#if me.project}<span class="chip">{me.project}</span>{/if}
    </div>
    {#if ancestors.length > 0}
      <nav class="breadcrumb" aria-label="parent cards">
        {#each ancestors as a, i (a.id)}
          {#if i > 0}<span class="sep">›</span>{/if}
          <button title="open {a.title}" onclick={() => board.openCard(a)}>{a.title}</button>
        {/each}
      </nav>
    {/if}
    <h2 class="detail-title">{me.title}</h2>
    <div class="detail-body">
      {#if me.note}
        <div class="detail-note md">{@html renderMarkdown(me.note)}</div>
      {:else}
        <p class="detail-note empty">no note</p>
      {/if}
      {#if plan}
        <details class="detail-plan">
          <summary>
            plan
            <span class="plan-meta" title="{plan.source}">
              v{plan.version} · {timeAgo(plan.createdAt)}{#if plan.source} · {plan.source}{/if}
            </span>
          </summary>
          <div class="detail-note md">{@html renderMarkdown(plan.content)}</div>
        </details>
      {/if}
      {#if live}
        <div class="detail-activity">
          <div class="children-head">
            {live.role === "reviewer" ? "pi-reviewer" : live.role === "planner" ? "pi-planner" : "pi-builder"} · live · {timeAgo(live.startedAt)}
          </div>
          <div class="activity-log" bind:this={logEl}>
            {#each live.log as line, i (i)}
              <div class="line">{line}</div>
            {/each}
          </div>
        </div>
      {/if}
      {#if sessionLogs.length > 0}
        <details class="detail-plan agent-sessions">
          <summary>
            agent sessions · {sessionLogs.length}
            <span class="plan-meta">transcripts kept on the card</span>
          </summary>
          {#each sessionLogs as log, i (log.id)}
            <details class="session-log" open={i === sessionLogs.length - 1}>
              <summary>
                <span class="plan-meta">{log.content.split("\n")[0]}</span>
              </summary>
              <div class="activity-log">
                {#each log.content.split("\n").slice(1) as line, j (j)}
                  <div class="line">{line}</div>
                {/each}
              </div>
            </details>
          {/each}
        </details>
      {/if}
      <div class="detail-comments">
        <div class="children-head">thread · {comments.length}</div>
        {#if comments.length === 0}
          <p class="comments-empty">no comments — the card is the forum</p>
        {:else}
          <ul class="comment-list">
            {#each comments as comment (comment.id)}
              <li>
                <div class="comment-meta">
                  <span class="author">{comment.author}</span>
                  {#if comment.kind !== "comment"}<span class="kind {comment.kind}">{comment.kind}</span>{/if}
                  <span class="when">{timeAgo(comment.createdAt)}</span>
                </div>
                <div class="comment-body md">{@html renderMarkdown(comment.body)}</div>
              </li>
            {/each}
          </ul>
        {/if}
        <form
          class="add-comment"
          onsubmit={(e) => {
            e.preventDefault();
            addComment();
          }}
        >
          <input placeholder="+ comment" bind:value={commentBody} />
        </form>
      </div>
      {#if childRows.length > 0}
        <div class="detail-children">
          <div class="children-head">
            subtasks
            {#if progress.total > 0}
              <span class="progress" class:complete={progress.done === progress.total}>
                {progress.done}/{progress.total} ✓
              </span>
            {/if}
          </div>
          <ul>
            {#each childRows as row (row.t.id)}
              <li style="padding-left: {row.depth * 14}px">
                <button class="child-row" title="open {row.t.title}" onclick={() => board.openCard(row.t)}>
                  <span class="lane-dot" style="--accent: {laneColor(childLaneIndex(row.t))}"></span>
                  <span class="t">{row.t.title}</span>
                  {#if row.t.laneId === "done"}<span class="tick">✓</span>{/if}
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
    <div class="detail-meta">
      <div><span class="k">created</span>{fmt(me.createdAt)}</div>
      <div><span class="k">updated</span>{fmt(me.updatedAt)} · {timeAgo(me.updatedAt)}</div>
    </div>
    {#if canAddSubtasks}
      <form
        class="add-subtask"
        onsubmit={(e) => {
          e.preventDefault();
          addSubtask();
        }}
      >
        <input placeholder="+ add subtask" bind:value={subtaskTitle} />
      </form>
    {/if}
    <div class="editor-actions">
      <IdChip id={me.id} />
      {#if me.laneId === "plan"}
        {#if rejecting}
          <form
            class="reject-form"
            onsubmit={(e) => {
              e.preventDefault();
              reject();
            }}
          >
            <input placeholder="why reject? this steers the next plan" bind:value={rejectMsg} />
            <button class="ghost" type="button" onclick={() => (rejecting = false)}>cancel</button>
            <button class="primary reject" type="submit" disabled={!rejectMsg.trim()}>reject</button>
          </form>
        {:else}
          {#if plan}<button class="ghost approve" onclick={approve}>✓ approve plan</button>{/if}
          <button class="ghost reject" onclick={() => (rejecting = true)}>✗ reject</button>
        {/if}
      {/if}
      <span class="spacer"></span>
      {#if me.laneId !== "done"}
        <button class="ghost" onclick={() => toLane("done")}>✓ done</button>
      {/if}
      {#if me.laneId !== "archive"}
        <button class="ghost" onclick={() => toLane("archive")}>archive</button>
      {/if}
      <button class="primary" onclick={() => (board.editMode = true)}>edit</button>
    </div>
  </div>
</div>
