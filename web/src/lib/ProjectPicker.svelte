<script lang="ts">
  import { ArrowUp, Folder, X } from "@lucide/svelte";
  import type { DirListing } from "../../../src/files";
  import { board } from "./board.svelte";
  import { projectPicker } from "./projectPicker.svelte.js";
  import { filterDirs, projectNameFromPath, projectNameProblem } from "./projectPicker";
  import { projects } from "./projects.svelte";

  let step = $state<"dirs" | "name">("dirs");
  let listing = $state<DirListing | null>(null);
  let pathInput = $state("");
  let filterQuery = $state("");
  let createOpen = $state(false);
  let newName = $state("");
  let name = $state("");
  let loadError = $state("");
  let busy = $state(false);

  const visibleDirs = $derived(listing ? filterDirs(listing.dirs, filterQuery) : []);
  const nameProblem = $derived(projectNameProblem(name, board.projects));

  $effect(() => {
    navigate("");
    filterQuery = "";
    createOpen = false;
    loadError = "";
    step = "dirs";
    name = "";
    newName = "";
  });

  async function navigate(dirPath: string): Promise<void> {
    busy = true;
    try {
      const next = await projects.listDirs(dirPath);
      if (next) {
        listing = next;
        pathInput = next.path;
        filterQuery = "";
        createOpen = false;
        loadError = "";
      } else {
        loadError = board.error;
        board.error = "";
      }
    } finally {
      busy = false;
    }
  }

  async function create(): Promise<void> {
    if (!listing || !newName.trim() || busy) return;
    busy = true;
    try {
      const res = await projects.makeDir(listing.path, newName);
      if (res) {
        createOpen = false;
        newName = "";
        loadError = "";
        await navigate(res.path);
      } else {
        loadError = board.error;
        board.error = "";
      }
    } finally {
      busy = false;
    }
  }

  async function register(): Promise<void> {
    if (!listing || nameProblem !== null || busy) return;
    busy = true;
    try {
      const ok = await projects.save({ name: name.trim(), repoPath: listing.path, testGate: true });
      if (ok) {
        await board.refresh();
        board.projectFilter = name.trim();
        projectPicker.close();
      } else {
        loadError = board.error;
        board.error = "";
      }
    } finally {
      busy = false;
    }
  }

  function autofocus(node: HTMLElement) {
    node.focus();
  }

  function handleBackdropClick(e: MouseEvent): void {
    if (!busy && e.target === e.currentTarget) {
      projectPicker.close();
    }
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (busy) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      if (createOpen) {
        createOpen = false;
        loadError = "";
      } else if (step === "name") {
        step = "dirs";
        loadError = "";
      } else {
        projectPicker.close();
      }
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="overlay project-add" role="presentation" onclick={handleBackdropClick}>
  <div class="pp-panel" role="dialog" aria-modal="true" aria-label="Select directory" tabindex="-1" use:autofocus>
    <div class="pp-head">
      <h3>Select directory</h3>
        <button
          type="button"
          class="icon-btn"
          aria-label="close directory picker"
          disabled={busy}
          onclick={() => projectPicker.close()}
        >
          <X size={16} strokeWidth={1.75} />
        </button>
    </div>

    {#if step === "dirs"}
      <form
        class="pp-nav"
        onsubmit={(e) => {
          e.preventDefault();
          if (!busy && pathInput.trim() !== "") navigate(pathInput);
        }}
      >
        <button
          type="button"
          aria-label="parent directory"
          disabled={!listing || listing.parent === null || busy}
          onclick={() => {
            if (listing?.parent) navigate(listing.parent);
          }}
        >
          <ArrowUp size={16} strokeWidth={1.75} />
        </button>
        <input
          class="pp-path"
          aria-label="directory path"
          placeholder="/path/to/project or ~/project"
          bind:value={pathInput}
          autocomplete="off"
        />
        <button
          type="submit"
          aria-label="go to path"
          disabled={busy || pathInput.trim() === ""}
        >
          Go
        </button>
      </form>

      {#if loadError && !createOpen}
        <div class="pp-alert" role="alert">{loadError}</div>
      {/if}

      {#if listing && listing.dirs.length > 0}
        <input
          class="pp-path pp-filter"
          aria-label="filter directories"
          placeholder="filter directories…"
          bind:value={filterQuery}
        />
      {/if}

      <div class="pp-list">
        {#if !listing}
          <div class="pp-empty">Loading directories…</div>
        {:else if listing.dirs.length === 0}
          <div class="pp-empty">No subdirectories</div>
        {:else if visibleDirs.length === 0}
          <div class="pp-empty">No matching directories</div>
        {:else}
          {#each visibleDirs as dir (dir.path)}
            <button
              type="button"
              class="pp-row"
              aria-label={`open directory ${dir.name}`}
              title={dir.path}
              onclick={() => navigate(dir.path)}
            >
              <Folder size={14} strokeWidth={1.75} />
              <span class="pp-name">{dir.name}</span>
              {#if dir.isGitRepo}
                <span class="pp-git">.git</span>
              {/if}
            </button>
          {/each}
        {/if}
      </div>

      {#if createOpen}
        <div class="pp-sub">
          <div class="pp-sub-panel">
            <div class="pp-sub-head">New directory</div>
            <form
              class="pp-sub-body"
              onsubmit={(e) => {
                e.preventDefault();
                create();
              }}
            >
              <label class="pp-sub-label" for="pp-new-name">New directory name</label>
              <input
                id="pp-new-name"
                class="pp-path"
                aria-label="new directory name"
                bind:value={newName}
                use:autofocus
              />
              {#if loadError}
                <div class="pp-alert" role="alert">{loadError}</div>
              {/if}
              <div class="pp-sub-actions">
                <button
                  type="button"
                  aria-label="cancel new directory"
                  disabled={busy}
                  onclick={() => {
                    createOpen = false;
                    newName = "";
                    loadError = "";
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  class="primary-btn"
                  aria-label="create directory"
                  disabled={busy || newName.trim() === ""}
                >
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      {/if}

      <div class="pp-foot">
        <button
          type="button"
          aria-label="new directory"
          disabled={busy || !listing}
          onclick={() => {
            createOpen = true;
            newName = "";
            loadError = "";
          }}
        >
          New directory
        </button>
        <div class="pp-foot-right">
          <button
            type="button"
            aria-label="cancel"
            disabled={busy}
            onclick={() => projectPicker.close()}
          >
            Cancel
          </button>
          <button
            type="button"
            class="primary-btn"
            aria-label="select this folder"
            disabled={!listing || pathInput.trim() !== listing.path || busy}
            onclick={() => {
              if (listing) {
                step = "name";
                name = projectNameFromPath(listing.path);
                loadError = "";
              }
            }}
          >
            Select this folder
          </button>
        </div>
      </div>
    {:else}
      <div class="pp-confirm">
        <h4>Add project</h4>
        <div class="pp-confirm-row">
          <span class="pp-confirm-label">Folder</span>
          <code class="pp-chosen">{listing?.path}</code>
        </div>
        <div class="pp-confirm-row">
          <label class="pp-confirm-label" for="pp-project-name">Project name</label>
          <input
            id="pp-project-name"
            class="pp-path"
            aria-label="project name"
            bind:value={name}
            maxlength="48"
          />
        </div>
        {#if nameProblem || loadError}
          <div class="pp-alert" role="alert">{nameProblem || loadError}</div>
        {/if}
      </div>

      <div class="pp-foot">
        <button
          type="button"
          aria-label="back to directories"
          disabled={busy}
          onclick={() => {
            step = "dirs";
            loadError = "";
          }}
        >
          Back
        </button>
        <button
          type="button"
          class="primary-btn"
          aria-label="register project"
          disabled={nameProblem !== null || busy}
          onclick={register}
        >
          Add project
        </button>
      </div>
    {/if}
  </div>
</div>
