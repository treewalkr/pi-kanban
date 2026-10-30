<script lang="ts">
  import { files } from "./files.svelte";
  import FileIcon from "./FileIcon.svelte";
  import { iconFor } from "./fileIcons";
  import { buildSearchTree } from "./fileview";
  import TreeNode from "./TreeNode.svelte";
  import { GitCommit, Loader2, RefreshCw, Search, X } from "@lucide/svelte";

  let searchOpen = $state(false);
  let searchQuery = $state("");
  let searchInputEl = $state<HTMLInputElement | null>(null);
  let refreshing = $state(false);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  const hasSearchQuery = $derived(searchQuery.trim().length > 0);

  function toggleSearch() {
    searchOpen = !searchOpen;
    if (searchOpen) {
      setTimeout(() => searchInputEl?.focus(), 50);
    } else {
      clearSearch();
    }
  }

  function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      void files.search(searchQuery);
    }, 150);
  }

  function clearSearch() {
    searchQuery = "";
    clearTimeout(searchTimer);
    files.clearSearch();
    searchInputEl?.focus();
  }

  function onSearchKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      toggleSearch();
    }
  }

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

  const sortedStatusEntries = $derived.by(() => {
    if (!files.status) return [];
    return Object.entries(files.status).sort(([a], [b]) => a.localeCompare(b));
  });
</script>

<svelte:window
  onfocus={() => {
    if (files.tab === "files") void files.refresh();
  }}
/>

<div class="files-panel">
  <div class="files-toolbar">
    <span class="files-title">Files</span>
    <div class="files-toolbar-actions">
      <button
        type="button"
        class="files-toolbar-btn"
        aria-label="search files"
        aria-pressed={searchOpen}
        title="search files"
        onclick={toggleSearch}
      >
        <Search size={13} strokeWidth={2} />
      </button>

      <button
        type="button"
        class="files-toolbar-btn"
        aria-label="changed files"
        aria-pressed={files.changesView}
        disabled={files.changesCount === 0}
        title={files.changesCount === 0 ? "no changed files" : `${files.changesCount} changed files`}
        onclick={() => files.toggleChangesView()}
      >
        <GitCommit size={13} strokeWidth={2} />
        {#if files.changesCount > 0}
          <span class="files-changes-badge">{files.changesCount}</span>
        {/if}
      </button>

      <button
        type="button"
        class="files-toolbar-btn"
        aria-label="refresh files"
        title="refresh files"
        onclick={handleRefresh}
      >
        <RefreshCw size={13} strokeWidth={2} class={refreshing ? "spin" : ""} />
      </button>
    </div>
  </div>

  {#if searchOpen}
    <div class="files-search-container">
      <div class="files-search-box">
        <Search size={12} strokeWidth={2} class="files-search-icon" />
        <input
          bind:this={searchInputEl}
          type="text"
          class="files-search-input"
          aria-label="search files"
          placeholder="search files…"
          bind:value={searchQuery}
          oninput={onSearchInput}
          onkeydown={onSearchKeydown}
        />
        {#if searchQuery}
          <button
            type="button"
            class="files-search-clear"
            aria-label="clear search"
            title="clear search"
            onclick={clearSearch}
          >
            <X size={10} strokeWidth={2.4} />
          </button>
        {/if}
      </div>

      {#if hasSearchQuery}
        <div class="files-search-results">
          {#if files.searching}
            <div class="files-search-status" role="status">searching…</div>
          {:else if files.searchError}
            <div class="files-search-status error" role="alert">failed to search files</div>
          {:else if files.searchMatches && files.searchMatches.length === 0}
            <div class="files-search-status">no matching files</div>
          {:else if files.searchMatches && files.searchMatches.length > 0}
            {@const searchRoots = buildSearchTree(files.searchMatches)}
            <div class="tree-list" role="tree">
              {#each searchRoots as node (node.path)}
                <TreeNode
                  path={node.path}
                  name={node.name}
                  isDir={node.isDir}
                  depth={0}
                  searchNode={node}
                />
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if !hasSearchQuery}
    {#if files.changesView && files.changesCount > 0}
      <div class="files-changes-view">
        <div class="files-changes-header">
          <span class="files-changes-count">{files.changesCount} changed</span>
          <span class="files-changes-additions">+{files.lineStats.additions}</span>
          <span class="files-changes-deletions">−{files.lineStats.deletions}</span>
        </div>
        <div class="files-changes-list">
          {#each sortedStatusEntries as [filePath, code] (filePath)}
            {@const lastSlash = filePath.lastIndexOf("/")}
            {@const dirPart = lastSlash >= 0 ? filePath.slice(0, lastSlash + 1) : ""}
            {@const baseName = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath}
            <div
              class="tree-row changes-row"
              role="button"
              tabindex="0"
              title={filePath}
              onclick={() => files.openFile(filePath, "diff")}
              onkeydown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  files.openFile(filePath, "diff");
                }
              }}
            >
              <span class="git-badge {code}">{code}</span>
              <FileIcon name={iconFor(baseName)} size={14} />
              <span class="tree-label">
                {#if dirPart}
                  <span class="tree-dir-prefix">{dirPart}</span>
                {/if}
                <span class="tree-name">{baseName}</span>
              </span>
            </div>
          {/each}
        </div>
      </div>
    {:else if files.loadError}
      <div class="files-error" role="alert">{files.loadError}</div>
    {:else if files.status === null && files.childrenOf("").length === 0}
      <div class="files-loading" role="status">
        <Loader2 size={13} strokeWidth={2} class="spin" />
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
  {/if}
</div>
