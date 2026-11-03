<script lang="ts">
  import type { ProjectRoute } from "../../../src/db";
  import type { DirListing } from "../../../src/files";
  import { projects } from "./projects.svelte";

  let saving = $state<Record<string, boolean>>({});
  let pickerOpen = $state(false);
  let listing = $state<DirListing | null>(null);
  let loadingDirs = $state(false);
  let creating = $state(false);
  let pickerName = $state("");

  async function save(route: ProjectRoute): Promise<void> {
    if (saving[route.name]) return;
    saving[route.name] = true;
    try {
      const repoPath = route.repoPath && route.repoPath.trim() !== "" ? route.repoPath.trim() : null;
      if (await projects.save({ name: route.name, repoPath, testGate: route.testGate })) {
        route.repoPath = repoPath; // the server normalized the draft — reflect it
      }
    } finally {
      saving[route.name] = false;
    }
  }

  async function browse(dirPath = ""): Promise<void> {
    loadingDirs = true;
    try {
      const nextListing = await projects.listDirs(dirPath);
      if (nextListing) {
        listing = nextListing;
        pickerName = nextListing.path.split("/").filter(Boolean).pop() ?? "";
      }
    } finally {
      loadingDirs = false;
    }
  }

  async function openPicker(): Promise<void> {
    pickerOpen = true;
    await browse("");
  }

  function closePicker(): void {
    pickerOpen = false;
    listing = null;
    pickerName = "";
  }

  async function createFromPicker(): Promise<void> {
    if (!listing || !pickerName.trim() || creating) return;
    creating = true;
    try {
      const ok = await projects.save({
        name: pickerName.trim(),
        repoPath: listing.path,
        testGate: true,
      });
      if (ok) {
        closePicker();
      }
    } finally {
      creating = false;
    }
  }
</script>

<div class="settings-general">
  <section class="settings-general-section">
    <div class="projects-header-row">
      <h3 class="settings-general-heading">Projects</h3>
      <button type="button" class="ghost" aria-label="add project" onclick={openPicker}>Add project</button>
    </div>
    <p class="settings-general-description">
      Route each project tag to the repo its cards' agents work in. An empty repo path falls back to the directory the board is served from. The test gate runs <code>bun test</code> in the routed repo before a card is reviewed.
    </p>

    {#if pickerOpen}
      <div class="project-picker settings-form">
        <div class="picker-path-bar">
          <button
            type="button"
            class="ghost"
            aria-label="parent directory"
            disabled={!listing || listing.parent === null || loadingDirs}
            onclick={() => listing?.parent && browse(listing.parent)}
          >
            ↑ up
          </button>
          <code class="picker-current-path" aria-label="current directory">{listing?.path ?? "…"}</code>
          {#if listing?.isGitRepo}
            <span class="picker-git-badge">.git</span>
          {/if}
        </div>

        <div class="picker-dirs">
          {#if listing}
            {#if listing.dirs.length === 0}
              <div class="picker-empty">No subdirectories</div>
            {:else}
              {#each listing.dirs as dir (dir.path)}
                <button
                  type="button"
                  class="picker-dir-row"
                  aria-label={`open directory ${dir.name}`}
                  onclick={() => browse(dir.path)}
                >
                  <span class="picker-dir-name">{dir.name}</span>
                  {#if dir.isGitRepo}
                    <span class="picker-git-badge">.git</span>
                  {/if}
                </button>
              {/each}
            {/if}
          {:else if loadingDirs}
            <div class="picker-empty">Loading…</div>
          {/if}
        </div>

        <div class="picker-footer">
          <label class="picker-name-field">
            project name
            <input aria-label="new project name" bind:value={pickerName} placeholder="project name" />
          </label>
          <button type="button" class="ghost" onclick={closePicker}>cancel</button>
          <button
            type="button"
            class="primary"
            aria-label="create project"
            disabled={creating || !listing || !pickerName.trim()}
            onclick={createFromPicker}
          >
            {creating ? "adding…" : "Use this directory"}
          </button>
        </div>
      </div>
    {/if}

    {#if projects.projects.length === 0}
      <p class="settings-general-description">No projects yet — tags appear here as cards use them.</p>
    {/if}

    {#each projects.projects as route (route.name)}
      <div class="project-row settings-form">
        <span class="project-name">{route.name}</span>
        <label class="project-repo">
          repo path
          <input aria-label={`repo path ${route.name}`} bind:value={route.repoPath} placeholder="serve directory (fallback)" />
          {#if !route.repoPath}
            <span class="fallback-hint">fallback</span>
          {/if}
        </label>
        <label class="project-gate">
          <input type="checkbox" aria-label={`test gate ${route.name}`} bind:checked={route.testGate} />
          test gate
        </label>
        <button
          type="button"
          class="primary"
          aria-label={`save project ${route.name}`}
          disabled={saving[route.name]}
          onclick={() => save(route)}
        >
          {saving[route.name] ? "saving…" : "save"}
        </button>
      </div>
    {/each}
  </section>
</div>

<style>
  .projects-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 5px;
  }
  .projects-header-row .settings-general-heading {
    margin: 0;
  }
  .project-picker {
    border: 1px solid var(--border);
    border-radius: var(--radius-small);
    padding: 12px;
    margin-bottom: 16px;
    background: var(--bg-surface);
  }
  .picker-path-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .picker-current-path {
    flex: 1;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-small);
    padding: 4px 8px;
  }
  .picker-git-badge {
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent);
    font-weight: 600;
  }
  .picker-dirs {
    max-height: 220px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-small);
    padding: 4px;
    background: var(--bg);
  }
  .picker-dir-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    border: none;
    background: transparent;
    cursor: pointer;
    text-align: left;
    width: 100%;
    border-radius: var(--radius-small);
  }
  .picker-dir-row:hover {
    background: var(--bg-hover);
  }
  .picker-dir-name {
    font-size: 12px;
    color: var(--text);
    font-family: var(--font-mono);
  }
  .picker-empty {
    padding: 12px;
    text-align: center;
    color: var(--text-muted);
    font-size: 11px;
  }
  .picker-footer {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .picker-name-field {
    flex: 1;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }
  .picker-name-field input {
    flex: 1;
  }
  .project-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 10px;
  }
  .project-name {
    width: 140px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
  }
  .project-repo {
    flex: 1;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
  }
  .project-repo input {
    flex: 1;
  }
  .fallback-hint {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .project-gate {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
</style>
