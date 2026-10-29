<script lang="ts">
  import type { Lane } from "../../../src/db";
  import { board } from "./board.svelte";

  let { lane, onclose }: { lane: Lane; onclose: () => void } = $props();

  let value = $state("");
  let elaborate = $state(false);
  let el: HTMLTextAreaElement;

  function autofocus(node: HTMLElement) {
    node.focus();
  }

  async function submit() {
    const title = value.trim();
    if (!title) return onclose();
    if (!(await board.addTask(lane.id, title, undefined, undefined, elaborate))) return; // keep the text so a failed post isn't lost
    value = "";
    el.focus();
  }

  function key(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape") onclose();
  }
</script>

<div class="composer">
  <textarea
    bind:value
    bind:this={el}
    use:autofocus
    rows="2"
    placeholder="card title… (Enter to add, Shift+Enter for newline)"
    onkeydown={key}
  ></textarea>
  <div class="composer-actions">
    {#if board.projectFilter}<span class="hint">project: {board.projectFilter}</span>{/if}
    <span class="spacer"></span>
    <button
      class="ghost"
      aria-pressed={elaborate}
      title="queue a pi-elaborator session to expand the note (intent + acceptance criteria)"
      onclick={() => (elaborate = !elaborate)}>✨ elaborate</button>
    <button class="ghost" onclick={onclose}>close</button>
  </div>
</div>
