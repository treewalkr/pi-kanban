<script lang="ts">
  import type { Task } from "../../../src/db";
  import { board } from "./board.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import IdChip from "./IdChip.svelte";

  const source = board.editing!;

  let title = $state(source.title);
  let note = $state(source.note);
  let project = $state(source.project);
  let tagsText = $state(source.tags.join(" "));
  let laneId = $state(source.laneId);
  let parentId = $state(source.parentId ?? "");
  let priority = $state<Task["priority"]>(source.priority);
  let confirming = $state(false);

  // candidates mirror the api rule: depth(candidate) + 1 + subtree height ≤ 2
  let candidates = $derived.by(() => {
    const heightOf = (id: string): number => {
      const kids = board.childrenOf(id);
      return kids.length === 0 ? 0 : 1 + Math.max(...kids.map((k) => heightOf(k.id)));
    };
    const banned = new Set([source.id, ...board.descendantsOf(source.id).map((t) => t.id)]);
    const height = heightOf(source.id);
    return board.tasks
      .filter((t) => !banned.has(t.id))
      .filter((t) => board.ancestorsOf(t.id).length + 1 + height <= 2)
      .sort((a, b) => a.title.localeCompare(b.title));
  });

  let descendantCount = $derived(board.descendantsOf(source.id).length);

  async function save() {
    if (!title.trim()) return;
    await board.updateTask(source.id, {
      title: title.trim(),
      note,
      project: project.trim(),
      tags: tagsText.split(/[\s,]+/).filter(Boolean),
      lane: laneId,
      parent: parentId || null,
      priority,
    });
    board.closeCard();
  }

  function confirmRemove() {
    confirming = false;
    board.deleteTask(source.id, true); // the confirm dialog is the guard
  }

  // move focus into the dialog so Tab doesn't cycle the board behind the overlay
  function autofocus(node: HTMLElement) {
    node.focus();
  }

  // size the note textarea to its content instead of a fixed 6-row keyhole;
  // capped at half the viewport so the dialog still fits
  function fitNote(node: HTMLTextAreaElement) {
    const fit = () => {
      node.style.height = "auto";
      node.style.height = Math.min(node.scrollHeight, Math.floor(window.innerHeight / 2)) + "px";
    };
    fit();
    node.addEventListener("input", fit);
    return { destroy: () => node.removeEventListener("input", fit) };
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key !== "Escape") return;
    if (confirming) confirming = false;
    else board.closeCard();
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
    class="editor"
    role="dialog"
    aria-modal="true"
    aria-label="edit card"
    tabindex="-1"
    use:autofocus
  >
    <label>
      title
      <input bind:value={title} />
    </label>
    <label>
      note
      <textarea bind:value={note} use:fitNote rows="6" placeholder="details, links, acceptance criteria… (markdown ok)"></textarea>
    </label>
    <div class="row">
      <label>
        project
        <input list="editor-projects" bind:value={project} placeholder="optional tag" />
        <datalist id="editor-projects">
          {#each board.projects as p (p)}<option value={p}></option>{/each}
        </datalist>
      </label>
      <label>
        tags
        <input list="editor-tags" bind:value={tagsText} placeholder="space separated" />
        <datalist id="editor-tags">
          {#each board.tags as t (t)}<option value={t}></option>{/each}
        </datalist>
      </label>
      <label>
        lane
        <select bind:value={laneId}>
          {#each board.lanes as l (l.id)}<option value={l.id}>{l.name}</option>{/each}
        </select>
      </label>
    </div>
    <div class="field">
      priority
      <div class="seg">
        <label class="seg-option">
          <input type="radio" name="priority" value="high" bind:group={priority} />
          <span class="seg-label">▲ high</span>
        </label>
        <label class="seg-option">
          <input type="radio" name="priority" value="normal" bind:group={priority} />
          <span class="seg-label">normal</span>
        </label>
        <label class="seg-option">
          <input type="radio" name="priority" value="low" bind:group={priority} />
          <span class="seg-label">▼ low</span>
        </label>
      </div>
    </div>
    <label>
      parent
      <select bind:value={parentId}>
        <option value="">(none)</option>
        {#each candidates as c (c.id)}
          <option value={c.id}>{c.title} · {c.id}</option>
        {/each}
      </select>
    </label>
    <div class="editor-actions">
      <IdChip id={source.id} />
      <span class="spacer"></span>
      <button class="danger" onclick={() => (confirming = true)}>delete</button>
      <button class="primary" onclick={save} disabled={!title.trim()}>save</button>
    </div>
  </div>
</div>

{#if confirming}
  <ConfirmDialog
    title="Delete card"
    message={
      descendantCount > 0
        ? 'Permanently delete “' +
          source.title +
          '” and its ' +
          (descendantCount === 1 ? '1 subtask' : descendantCount + ' subtasks') +
          '? There is no undo.'
        : 'Permanently delete “' + source.title + '”? There is no undo.'
    }
    onconfirm={confirmRemove}
    oncancel={() => (confirming = false)}
  />
{/if}
