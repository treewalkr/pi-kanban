<script lang="ts">
  import type { Attachment, Comment, Task } from "../../../src/db";
  import { isAgentChatter, latestStateIndex } from "../../../src/thread";
  import { GitBranch, Sparkles } from "@lucide/svelte";
  import { api } from "../api";
  import { board } from "./board.svelte";
  import IdChip from "./IdChip.svelte";
  import { copyText } from "./copy";
  import { renderMarkdown, toggleTaskLine } from "./markdown";
  import { collapseDiff, parseUnifiedDiff } from "./fileview";
  import { canPromoteToPlan, laneColor, roleAuthor, timeAgo } from "./util";
  import { canResume } from "./waiting";
  import { blockerCandidates } from "./blockerPicker";

  const task = board.editing!;

  // live copy: refresh replaces board.tasks, so derive everything hierarchy-ish from it
  let me = $derived(board.taskById(task.id) ?? task);
  let plan = $derived(board.plans[task.id]);
  let pathCopied = $state(false);
  let pathTimer: ReturnType<typeof setTimeout> | undefined;
  async function copyPlanPath(e: MouseEvent): Promise<void> {
    e.preventDefault(); // inside <summary>: keep the plan section's open/closed state
    const source = plan?.source ?? "";
    if (!source) return;
    if (await copyText(source)) {
      pathCopied = true;
      clearTimeout(pathTimer);
      pathTimer = setTimeout(() => (pathCopied = false), 1200);
    }
  }
  let ancestors = $derived(board.ancestorsOf(task.id));
  let progress = $derived(board.progressOf(me));

  // dependency chips: direct blockers and dependents (soft edges; done/archive stops blocking)
  let blockers = $derived.by(() =>
    (board.blockedBy[me.id] ?? [])
      .map((id) => board.taskById(id))
      .filter((t): t is Task => t !== undefined),
  );
  let dependents = $derived(
    board.tasks.filter((t) => (board.blockedBy[t.id] ?? []).includes(me.id)),
  );
  let links = $derived.by(() =>
    (board.links[me.id] ?? [])
      .map((id) => board.taskById(id))
      .filter((t): t is Task => t !== undefined),
  );

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
  let queuedJob = $derived(board.queued[me.id]);
  let inFlightCount = $derived(Object.keys(board.activity).length);
  let logEl = $state<HTMLElement | null>(null);

  $effect(() => {
    void live?.log.length; // re-run as lines arrive
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  });

  let laneIndex = $derived(Math.max(0, board.lanes.findIndex((l) => l.id === me.laneId)));
  let laneName = $derived(board.lanes[laneIndex]?.name ?? me.laneId);
  let canPromote = $derived(canPromoteToPlan(me, board.lanes));
  let subtaskTitle = $state("");
  let linkTarget = $state("");
  async function addLink() {
    const t = linkTarget.trim();
    if (!t) return;
    if (await board.addLink(me.id, t)) linkTarget = "";
  }

  // add-blocker picker: local query inside the modal (never board.search — that
  // drives the header SearchBox and would filter the board behind the dialog)
  let blockerQuery = $state("");
  let blockerHighlighted = $state(0);
  let blockerOpen = $state(false);
  let blockerError = $state("");
  let blockerCandidatesList = $derived(
    blockerCandidates(board.tasks, blockerQuery, me.id, board.blockedBy[me.id] ?? []),
  );
  let showBlockerDropdown = $derived(
    blockerOpen && blockerQuery.trim() !== "" && blockerCandidatesList.length > 0,
  );

  // clamp the highlight when the candidate set shrinks under the cursor
  $effect(() => {
    blockerHighlighted = Math.max(0, Math.min(blockerHighlighted, blockerCandidatesList.length - 1));
  });

  // keep the keyboard highlight visible in the scrolling dropdown
  $effect(() => {
    void blockerHighlighted;
    if (showBlockerDropdown)
      document.querySelector('.dep-picker-results [aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  });

  const laneCrumb = (t: Task): string => board.lanes.find((l) => l.id === t.laneId)?.name ?? t.laneId;

  async function commitBlocker(picked: Task): Promise<void> {
    blockerQuery = "";
    blockerError = "";
    const err = await board.addBlocker(me.id, picked.id);
    if (err) blockerError = err; // the API's own 409/404 message, inline
  }

  async function unblock(blockerId: string): Promise<void> {
    const err = await board.removeBlocker(me.id, blockerId);
    blockerError = err ?? "";
  }

  function blockerKeydown(e: KeyboardEvent): void {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!showBlockerDropdown) return;
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      blockerHighlighted = (blockerHighlighted + dir + blockerCandidatesList.length) % blockerCandidatesList.length;
    } else if (e.key === "Enter") {
      if (showBlockerDropdown && blockerCandidatesList[blockerHighlighted]) {
        e.preventDefault();
        void commitBlocker(blockerCandidatesList[blockerHighlighted]!);
      }
    } else if (e.key === "Escape" && blockerOpen) {
      e.preventDefault();
      e.stopPropagation(); // the first Escape closes the dropdown only; the next closes the modal
      blockerOpen = false;
    }
  }

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

  async function toggleNoteTask(e: MouseEvent) {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || el.type !== "checkbox") return;
    const rawIndex = el.dataset.task;
    if (rawIndex === undefined) return;
    const index = Number.parseInt(rawIndex, 10);
    if (!Number.isInteger(index)) return;

    const next = toggleTaskLine(me.note, index);
    if (next === me.note) {
      el.checked = !el.checked;
      return;
    }

    await board.updateTask(me.id, { note: next });
    if (board.error) {
      el.checked = !el.checked;
    }
  }

  async function addSubtask() {
    const title = subtaskTitle.trim();
    if (!title) return;
    if (await board.addTask(me.laneId, title, undefined, task.id)) subtaskTitle = "";
  }

  // the plan gate: approve arms the plan-build builder, reject re-arms the planner —
  // both work on a card parked in Waiting on you from Plan (a passed review)
  const atPlanGate = $derived(me.laneId === "plan" || (me.laneId === "waiting" && me.previousLane === "plan"));
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
  let stateIdx = $derived(latestStateIndex(comments));
  let commentBody = $state("");

  // finished agent sessions saved on the card (live one renders above these)
  let sessionLogs = $state<Attachment[]>([]);

  // card files (plan + named attachments): latest per name on open; a file's full
  // version history is fetched lazily when its section is expanded (drives the picker)
  let cardFiles = $state<Attachment[]>([]);
  let versionsByKind = $state<Record<string, Attachment[]>>({});
  let pickedVersion = $state<Record<string, number>>({});

  async function loadVersions(kind: string, e: Event): Promise<void> {
    const details = e.currentTarget as HTMLDetailsElement;
    if (!details.open || versionsByKind[kind]) return;
    const res = await api.tasks({ id: task.id }).files({ name: kind }).get();
    if (res.error) return;
    versionsByKind[kind] = res.data;
    if (!pickedVersion[kind]) pickedVersion[kind] = res.data.at(-1)?.version ?? 1;
  }

  // what to render for a kind: the picked version once its history loaded, else the latest
  function shownVersion(kind: string, latest: Attachment): Attachment {
    const want = pickedVersion[kind];
    return want === undefined ? latest : (versionsByKind[kind]?.find((v) => v.version === want) ?? latest);
  }

  // per-file diff view: picked version vs its predecessor, fetched only while toggled on
  let showDiff = $state<Record<string, boolean>>({});
  let diffPatch = $state<Record<string, string | null>>({});

  async function loadDiff(kind: string): Promise<void> {
    const picked = pickedVersion[kind] ?? cardFiles.find((f) => f.kind === kind)?.version ?? 1;
    if (picked <= 1) return;
    const res = await api.tasks({ id: task.id }).files({ name: kind }).diff.get({
      query: { from: picked - 1, to: picked },
    });
    diffPatch[kind] = res.error ? null : res.data.patch;
  }

  const isMarkdown = (kind: string): boolean => kind === "plan" || kind.endsWith(".md");
  let otherFiles = $derived(cardFiles.filter((f) => f.kind !== "plan"));

  async function reloadThread(): Promise<void> {
    const [commentsRes, sessionsRes, filesRes] = await Promise.all([
      api.tasks({ id: task.id }).comments.get(),
      api.tasks({ id: task.id }).sessions.get(),
      api.tasks({ id: task.id }).files.get(),
    ]);
    if (!commentsRes.error) comments = commentsRes.data;
    if (!sessionsRes.error) sessionLogs = sessionsRes.data;
    if (!filesRes.error) cardFiles = filesRes.data;
  }

  $effect(() => {
    void reloadThread();
  });

  // finished-session pickup: an open card doesn't ride the SSE refresh (paused
  // while a modal is open) — pull the board and thread when this card's live
  // session ends, so the elaborated note appears without closing the card
  let hadLive = false;
  $effect(() => {
    const running = live !== undefined;
    if (hadLive && !running) {
      void board.refresh();
      void reloadThread();
    }
    hadLive = running;
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
      {#if me.tags.length > 0}{#each me.tags as tag (tag)}<span class="chip tag">#{tag}</span>{/each}{/if}
      {#if board.workspaces[me.id]}
        {@const ws = board.workspaces[me.id]}
        <span class="chip ws" title={ws.path ?? "branch exists — no worktree checked out"}>
          <GitBranch size={11} strokeWidth={1.75} /> {ws.branch}
        </span>
      {/if}
    </div>
    {#if ancestors.length > 0}
      <nav class="breadcrumb" aria-label="parent cards">
        {#each ancestors as a, i (a.id)}
          {#if i > 0}<span class="sep">›</span>{/if}
          <button title="open {a.title}" onclick={() => board.openCard(a)}>{a.title}</button>
        {/each}
      </nav>
    {/if}
    <div class="detail-deps">
      <div class="dep-row">
        <span class="dep-k" class:stuck={board.isBlocked(me.id)}>blocked by</span>
        {#each blockers as b (b.id)}
          <button class="dep-chip" title="open {b.title}" onclick={() => board.openCard(b)}>
            <span class="id">{b.id}</span>
            <span class="t">{b.title}</span>
            {#if b.laneId === "done" || b.laneId === "archive"}<span class="ok">✓</span>{/if}
          </button>
          <button class="dep-x" title="unblock {b.title}" onclick={() => unblock(b.id)}>✕</button>
        {/each}
        <span class="dep-add blocker-add">
          <input
            placeholder="block by title or id…"
            aria-label="add blocker"
            aria-haspopup="listbox"
            bind:value={blockerQuery}
            onfocus={() => (blockerOpen = true)}
            onblur={() => (blockerOpen = false)}
            oninput={() => {
              blockerOpen = true;
              blockerHighlighted = 0;
              blockerError = "";
            }}
            onkeydown={blockerKeydown}
          />
          {#if showBlockerDropdown}
            <div class="dep-picker-results" role="listbox">
              {#each blockerCandidatesList as t, i (t.id)}
                <button
                  class="dep-option"
                  class:active={i === blockerHighlighted}
                  role="option"
                  aria-selected={i === blockerHighlighted}
                  onmousedown={(e) => e.preventDefault()}
                  onpointerenter={() => (blockerHighlighted = i)}
                  onclick={() => void commitBlocker(t)}
                >
                  <span class="id">{t.id}</span>
                  <span class="t">{t.title}</span>
                  <span class="crumb">{laneCrumb(t)}</span>
                </button>
              {/each}
            </div>
          {/if}
        </span>
        {#if blockerError}<span class="dep-error" role="alert">{blockerError}</span>{/if}
      </div>
      {#if dependents.length > 0}
        <div class="dep-row">
          <span class="dep-k">blocking</span>
          {#each dependents as d (d.id)}
            <button class="dep-chip" title="open {d.title}" onclick={() => board.openCard(d)}>
              <span class="id">{d.id}</span>
              <span class="t">{d.title}</span>
            </button>
          {/each}
        </div>
      {/if}
      <div class="dep-row">
        <span class="dep-k">linked</span>
        {#each links as l (l.id)}
          <button class="dep-chip" title="open {l.title}" onclick={() => board.openCard(l)}>
            <span class="id">{l.id}</span><span class="t">{l.title}</span>
          </button>
          <button class="dep-x" title="unlink {l.title}" onclick={() => board.removeLink(me.id, l.id)}>✕</button>
        {/each}
        <span class="dep-add">
          <input placeholder="link by id…" bind:value={linkTarget} onkeydown={(e) => e.key === "Enter" && addLink()} />
          <button class="dep-add-btn" onclick={addLink}>link</button>
        </span>
      </div>
    </div>
    <h2 class="detail-title">{me.title}</h2>
    <div class="detail-body">
      {#if me.note}
        <div class="detail-note md" role="presentation" onclick={toggleNoteTask}>
          {@html renderMarkdown(me.note, { interactiveTasks: true })}
        </div>
      {:else}
        <p class="detail-note empty">no note</p>
      {/if}
      {#if plan}
        <details class="detail-plan" ontoggle={(e) => loadVersions("plan", e)}>
          <summary>
            plan
            <span class="plan-meta">
              {#if (versionsByKind["plan"]?.length ?? 0) > 1}
                <select
                  class="version-pick"
                  aria-label="plan version"
                  onclick={(e) => e.stopPropagation()}
                  onchange={(e) => {
                    pickedVersion["plan"] = Number((e.target as HTMLSelectElement).value);
                    if (showDiff["plan"]) void loadDiff("plan");
                  }}>
                  {#each versionsByKind["plan"].slice().reverse() as v (v.version)}
                    <option value={v.version} selected={pickedVersion["plan"] === v.version}>v{v.version}</option>
                  {/each}
                </select>
                <button
                  class="diff-toggle"
                  class:on={showDiff["plan"]}
                  disabled={pickedVersion["plan"] === 1}
                  title={pickedVersion["plan"] === 1 ? "v1 is the first version" : "diff against the previous version"}
                  onclick={(e) => {
                    e.stopPropagation();
                    showDiff["plan"] = !showDiff["plan"];
                    if (showDiff["plan"]) void loadDiff("plan");
                  }}>diff</button
                >
              {:else}v{plan.version}{/if} · {timeAgo(shownVersion("plan", plan).createdAt)}{#if plan.source} · <button
                class="plan-path"
                class:copied={pathCopied}
                title={plan.source}
                onclick={copyPlanPath}>{#if pathCopied}✓ copied{:else}{plan.source}{/if}</button
              >{/if}
            </span>
          </summary>
          {#if showDiff["plan"] && diffPatch["plan"] !== null}
            {#if diffPatch["plan"] === ""}
              <p class="diff-empty">no changes</p>
            {:else}
              {@const segments = collapseDiff(parseUnifiedDiff(diffPatch["plan"]!), 3)}
              <div class="card-diff">
                {#each segments as seg}
                  {#if seg.kind === "gap"}
                    <div class="viewer-diff-gap">⋯ {seg.count} unchanged lines</div>
                  {:else}
                    {#each seg.lines as dLine}
                      <div class="viewer-diff-line {dLine.kind}">
                        <span class="viewer-line-num">
                          {dLine.kind === "del" ? (dLine.oldNo ?? "") : (dLine.newNo ?? "")}
                        </span>
                        <span class="viewer-diff-prefix">
                          {dLine.kind === "add" ? "+" : dLine.kind === "del" ? "−" : " "}
                        </span>
                        <span class="viewer-line-code">{dLine.text}</span>
                      </div>
                    {/each}
                  {/if}
                {/each}
              </div>
            {/if}
          {:else}
            <div class="detail-note md">{@html renderMarkdown(shownVersion("plan", plan).content)}</div>
          {/if}
        </details>
      {/if}
      {#if otherFiles.length > 0}
        <details class="detail-plan card-files">
          <summary>
            files · {otherFiles.length}
            <span class="plan-meta">card attachments — `kanban cat` prints them from the CLI</span>
          </summary>
          {#each otherFiles as f (f.kind)}
            {@const shown = shownVersion(f.kind, f)}
            <details class="session-log card-file" ontoggle={(e) => loadVersions(f.kind, e)}>
              <summary>
                {f.kind}
                <span class="plan-meta">
                  {#if (versionsByKind[f.kind]?.length ?? 0) > 1}
                    <select
                      class="version-pick"
                      aria-label={`${f.kind} version`}
                      onclick={(e) => e.stopPropagation()}
                      onchange={(e) => {
                        pickedVersion[f.kind] = Number((e.target as HTMLSelectElement).value);
                        if (showDiff[f.kind]) void loadDiff(f.kind);
                      }}>
                      {#each versionsByKind[f.kind].slice().reverse() as v (v.version)}
                        <option value={v.version} selected={pickedVersion[f.kind] === v.version}>v{v.version}</option>
                      {/each}
                    </select>
                    <button
                      class="diff-toggle"
                      class:on={showDiff[f.kind]}
                      disabled={pickedVersion[f.kind] === 1}
                      title={pickedVersion[f.kind] === 1 ? "v1 is the first version" : "diff against the previous version"}
                      onclick={(e) => {
                        e.stopPropagation();
                        showDiff[f.kind] = !showDiff[f.kind];
                        if (showDiff[f.kind]) void loadDiff(f.kind);
                      }}>diff</button
                    >
                  {:else}v{shown.version}{/if} · {timeAgo(shown.createdAt)}
                </span>
              </summary>
              {#if showDiff[f.kind] && diffPatch[f.kind] !== null}
                {#if diffPatch[f.kind] === ""}
                  <p class="diff-empty">no changes</p>
                {:else}
                  {@const segments = collapseDiff(parseUnifiedDiff(diffPatch[f.kind]!), 3)}
                  <div class="card-diff">
                    {#each segments as seg}
                      {#if seg.kind === "gap"}
                        <div class="viewer-diff-gap">⋯ {seg.count} unchanged lines</div>
                      {:else}
                        {#each seg.lines as dLine}
                          <div class="viewer-diff-line {dLine.kind}">
                            <span class="viewer-line-num">
                              {dLine.kind === "del" ? (dLine.oldNo ?? "") : (dLine.newNo ?? "")}
                            </span>
                            <span class="viewer-diff-prefix">
                              {dLine.kind === "add" ? "+" : dLine.kind === "del" ? "−" : " "}
                            </span>
                            <span class="viewer-line-code">{dLine.text}</span>
                          </div>
                        {/each}
                      {/if}
                    {/each}
                  </div>
                {/if}
              {:else if isMarkdown(f.kind)}
                <div class="detail-note md">{@html renderMarkdown(shown.content)}</div>
              {:else}
                <pre class="file-raw">{shown.content}</pre>
              {/if}
            </details>
          {/each}
        </details>
      {/if}
      {#if queuedJob}
        {@const author = roleAuthor(queuedJob.role)}
        {@const plural = inFlightCount === 1 ? "" : "s"}
        <div class="detail-activity queued">
          <div class="children-head">
            {author} · queued · {timeAgo(queuedJob.enqueuedAt)} — behind {inFlightCount} running session{plural}
          </div>
        </div>
      {/if}
      {#if live}
        <div class="detail-activity">
          <div class="children-head">
            {roleAuthor(live.role)} · live · {timeAgo(live.startedAt)}{#if live.modelLabel} · {live.modelLabel}{/if}
          </div>
          <div class="activity-log" bind:this={logEl}>
            {#each live.log as line, i (i)}
              <div class="line">{line}</div>
            {/each}
          </div>
        </div>
      {/if}
      {#if canResume(board.waiting[me.id], !!board.activity[me.id])}
        <div class="detail-activity resume-offer">
          <div class="children-head">last session died — its context is one click away</div>
          <button
            class="resume-btn"
            title="continue the dead pi session where it left off (a comment re-runs fresh)"
            onclick={() => board.resumeSession(me.id)}>↻ resume session</button>
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
            {#each comments as comment, i (comment.id)}
              <li class:loop={isAgentChatter(comment)} class:latest-state={i === stateIdx}>
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
      {#if atPlanGate}
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
      {#if !queuedJob && !live}
        <button
          class="ghost icon-only"
          aria-label="queue a pi-elaborator session to expand the note (intent + acceptance criteria) and fix an obviously broken title"
          title="queue a pi-elaborator session to expand the note (intent + acceptance criteria) and fix an obviously broken title"
          onclick={() => board.elaborate(me.id)}>
          <Sparkles size={13} strokeWidth={1.75} />
        </button>
      {/if}
      <span class="spacer"></span>
      {#if canPromote}
        <button class="ghost" onclick={() => toLane("plan")}>→ plan</button>
      {/if}
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
