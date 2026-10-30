<script lang="ts">
  import { files } from "./files.svelte";
  import TreeNode from "./TreeNode.svelte";
  import { Loader2, RefreshCw } from "@lucide/svelte";

  let refreshing = $state(false);

  async function handleRefresh() {
    refreshing = true;
    try {
      await files.refresh();
    } finally {
      refreshing = false;
    }
  }

  $effect(() => {
    if (files.tab === "files" && files.status === null && !files.loadError) {
      void files.load();
    }
  });
</script>

<div class="files-panel">
  <div class="files-header">
    <span class="files-title">Files</span>
    <button
      type="button"
      class="files-refresh-btn"
      title="refresh file tree and git status"
      aria-label="refresh files"
      onclick={handleRefresh}
    >
      <RefreshCw size={12} strokeWidth={1.8} class={refreshing ? "spin" : ""} />
    </button>
  </div>

  {#if files.loadError}
    <div class="files-error" role="alert">{files.loadError}</div>
  {:else if files.status === null && files.childrenOf("").length === 0}
    <div class="files-loading">
      <Loader2 size={14} strokeWidth={2} class="spin" />
      <span>loading files…</span>
    </div>
  {:else if files.childrenOf("").length === 0}
    <div class="files-empty">no files in repository</div>
  {:else}
    <div class="tree-list" role="tree">
      {#each files.childrenOf("") as entry (entry.name)}
        <TreeNode path={entry.name} name={entry.name} isDir={entry.isDir} depth={0} />
      {/each}
    </div>
  {/if}
</div>
