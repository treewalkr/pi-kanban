<script lang="ts">
  import type { ProjectRoute } from "../../../src/db";
  import { projects } from "./projects.svelte";

  let saving = $state<Record<string, boolean>>({});

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
</script>

<div class="settings-general">
  <section class="settings-general-section">
    <h3 class="settings-general-heading">Projects</h3>
    <p class="settings-general-description">
      Route each project tag to the repo its cards' agents work in. An empty repo path falls back to the directory the board is served from. The test gate runs <code>bun test</code> in the routed repo before a card is reviewed.
    </p>

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
