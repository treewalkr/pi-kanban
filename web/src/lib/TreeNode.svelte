<script lang="ts">
  import { files, joinPath } from "./files.svelte";
  import FileIcon from "./FileIcon.svelte";
  import { iconFor } from "./fileIcons";
  import type { SearchNode } from "./fileview";
  import TreeNode from "./TreeNode.svelte";
  import { ChevronRight, Loader2 } from "@lucide/svelte";

  interface Props {
    path: string;
    name: string;
    isDir: boolean;
    depth: number;
    searchNode?: SearchNode;
  }

  const { path, name, isDir, depth, searchNode }: Props = $props();

  let searchOpen = $state(true);
  const isOpen = $derived(searchNode ? searchOpen : files.open.has(path));
  const isLoading = $derived(!searchNode && files.loading.has(path));
  const dirError = $derived(!searchNode ? files.dirErrors.get(path) : undefined);
  const children = $derived(searchNode ? searchNode.children : files.childrenOf(path));
  const statusBadge = $derived(!isDir ? files.codeFor(path) : undefined);
  const hasDirChange = $derived(isDir && files.dirChanged(path));

  function handleClick() {
    if (isDir) {
      if (searchNode) {
        searchOpen = !searchOpen;
      } else {
        void files.toggle(path);
      }
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
    style="padding-left: {6 + depth * 12}px"
    title={path}
    onclick={handleClick}
  >
    {#if isDir}
      <span class="tree-chevron" class:open={isOpen}>
        <ChevronRight size={10} strokeWidth={2.5} />
      </span>
      <FileIcon name={isOpen ? "_folder_open" : "_folder"} size={14} />
    {:else}
      <span class="tree-chevron spacer"></span>
      <FileIcon name={iconFor(name)} size={14} />
    {/if}

    <span class="tree-label">
      <span class="tree-name">{name}</span>
    </span>

    {#if isDir && hasDirChange}
      <span class="git-dot" title="contains modified files"></span>
    {:else if statusBadge}
      <span class="git-badge {statusBadge}">{statusBadge}</span>
    {/if}
  </button>

  {#if isDir && isOpen}
    <div class="tree-children" role="group">
      {#if isLoading}
        <div class="tree-loading" style="padding-left: {6 + (depth + 1) * 12 + 16}px">
          <Loader2 size={11} strokeWidth={2} class="spin" />
          <span>loading…</span>
        </div>
      {:else if dirError}
        <div class="tree-error" role="alert" style="padding-left: {6 + (depth + 1) * 12 + 16}px">
          {dirError}
        </div>
      {:else if children.length === 0}
        <div class="tree-empty" style="padding-left: {6 + (depth + 1) * 12 + 16}px">
          empty
        </div>
      {:else}
        {#each children as child (child.name)}
          <TreeNode
            path={searchNode ? (child as SearchNode).path : joinPath(path, child.name)}
            name={child.name}
            isDir={child.isDir}
            depth={depth + 1}
            searchNode={searchNode ? (child as SearchNode) : undefined}
          />
        {/each}
      {/if}
    </div>
  {/if}
</div>
