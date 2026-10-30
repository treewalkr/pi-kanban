<script lang="ts">
  import { files, joinPath } from "./files.svelte";
  import TreeNode from "./TreeNode.svelte";
  import { ChevronRight, FileText, Folder, FolderOpen, Loader2 } from "@lucide/svelte";

  interface Props {
    path: string;
    name: string;
    isDir: boolean;
    depth: number;
  }

  const { path, name, isDir, depth }: Props = $props();

  let isOpen = $derived(files.open.has(path));
  let isChildLoading = $derived(files.loading.has(path));
  let childError = $derived(files.dirErrors.get(path));
  let children = $derived(files.childrenOf(path));
  let statusBadge = $derived(!isDir ? files.codeFor(path) : undefined);
  let hasDirChange = $derived(isDir && files.dirChanged(path));

  function handleClick() {
    if (isDir) {
      void files.toggle(path);
    } else {
      void files.openFile(path);
    }
  }
</script>

<div class="tree-node">
  <button
    type="button"
    class="tree-row"
    role="treeitem"
    aria-selected={false}
    aria-expanded={isDir ? isOpen : undefined}
    style="padding-left: {8 + depth * 14}px"
    title={path}
    onclick={handleClick}
  >
    {#if isDir}
      <span class="tree-chevron" class:open={isOpen}>
        <ChevronRight size={10} strokeWidth={2} />
      </span>
      <span class="tree-icon">
        {#if isOpen}
          <FolderOpen size={14} strokeWidth={1.8} />
        {:else}
          <Folder size={14} strokeWidth={1.8} />
        {/if}
      </span>
    {:else}
      <span class="tree-chevron spacer"></span>
      <span class="tree-icon">
        <FileText size={14} strokeWidth={1.8} />
      </span>
    {/if}

    <span class="tree-label">{name}</span>

    {#if statusBadge}
      <span class="git-badge git-badge-{statusBadge}">{statusBadge}</span>
    {:else if hasDirChange}
      <span class="git-dot" title="changed files inside"></span>
    {/if}
  </button>

  {#if isDir && isOpen}
    <div class="tree-children" role="group">
      {#if isChildLoading}
        <div class="tree-loading" style="padding-left: {8 + (depth + 1) * 14}px">
          <Loader2 size={12} strokeWidth={2} class="spin" />
          <span>loading…</span>
        </div>
      {:else if childError}
        <div class="tree-error" role="alert" style="padding-left: {8 + (depth + 1) * 14}px">
          {childError}
        </div>
      {:else if children.length === 0}
        <div class="tree-empty" style="padding-left: {8 + (depth + 1) * 14}px">
          (empty)
        </div>
      {:else}
        {#each children as child (child.name)}
          <TreeNode
            path={joinPath(path, child.name)}
            name={child.name}
            isDir={child.isDir}
            depth={depth + 1}
          />
        {/each}
      {/if}
    </div>
  {/if}
</div>
