<script lang="ts">
  import { board } from "./board.svelte";
  import type { SearchResult } from "../../../src/search";
  import { files } from "./files.svelte";
  import { agents } from "./agents.svelte";
  import { palette } from "./palette.svelte";
  import { laneCrumb } from "./palette";

  let input = $state<HTMLInputElement>();
  let open = $state(false);
  let selected = $state(0);

  let results = $derived(board.searchResults);
  let q = $derived(board.search.trim().toLowerCase());
  let showDropdown = $derived(open && q !== "" && results.length > 0);

  // clamp the selection when the result set shrinks under the cursor
  $effect(() => {
    selected = Math.max(0, Math.min(selected, results.length - 1));
  });

  // keep the keyboard selection visible in the scrolling list
  $effect(() => {
    void selected;
    if (showDropdown)
      document.querySelector('.search-results [aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  });

  function glyph(r: SearchResult): string {
    if (r.kind === "checklist") return r.checked ? "✓" : "☐";
    if (r.kind === "tag") return "#";
    if (r.kind === "note") return "¶";
    if (r.kind === "plan") return "✎";
    return "▪";
  }

  function jump(r: SearchResult): void {
    open = false;
    board.jumpTo(r.task);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!showDropdown) return;
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      selected = (selected + dir + results.length) % results.length;
    } else if (e.key === "Enter") {
      if (showDropdown && results[selected]) {
        e.preventDefault();
        jump(results[selected]!);
      }
    } else if (e.key === "Escape" && open) {
      e.preventDefault(); // also blocks the native type=search clear
      open = false;
    }
  }

  function onWindowKeydown(e: KeyboardEvent): void {
    if (board.editing) return; // modals own the keyboard while open
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      if (files.preview || agents.open) return; // never stack over those overlays
      e.preventDefault();
      palette.open = !palette.open;
      return;
    }
    if (e.key === "/") {
      e.preventDefault();
      input?.focus();
      input?.select();
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="search-box">
  <input
    class="search"
    id="board-search"
    type="search"
    placeholder="search…"
    aria-label="search cards"
    title="press / to focus"
    bind:this={input}
    bind:value={board.search}
    onfocus={() => (open = true)}
    onblur={() => (open = false)}
    oninput={() => {
      open = true;
      selected = 0;
    }}
    onkeydown={onKeydown}
    aria-haspopup="listbox"
  />
  {#if showDropdown}
    <div class="search-results" role="listbox">
      {#each results as r, i (`${r.kind}:${r.task.id}:${r.text}`)}
        {@const at = r.text.toLowerCase().indexOf(q)}
        <button
          class="search-result"
          class:active={i === selected}
          role="option"
          aria-selected={i === selected}
          onmousedown={(e) => e.preventDefault()}
          onpointerenter={() => (selected = i)}
          onclick={() => jump(r)}
        >
          <span class="glyph">{glyph(r)}</span>
          <span class="body">
            <span class="match">
              {#if at >= 0}
                {r.text.slice(0, at)}<mark>{r.text.slice(at, at + q.length)}</mark>{r.text.slice(at + q.length)}
              {:else}
                {r.text}
              {/if}
            </span>
            <span class="crumb">{laneCrumb(board.tasks, board.lanes, r.task.id)}</span>
          </span>
          <span class="jump">↵</span>
        </button>
      {/each}
    </div>
  {/if}
</div>
