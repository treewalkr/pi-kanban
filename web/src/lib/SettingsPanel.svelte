<script lang="ts">
  import { agents } from "./agents.svelte";
  import { pools } from "./pools.svelte";
  import GeneralSettings from "./GeneralSettings.svelte";
  import AgentsSettings from "./AgentsSettings.svelte";
  import PoolsSettings from "./PoolsSettings.svelte";

  type Section = "general" | "agents" | "pools";

  let section = $state<Section>("general");
  // visited sections stay mounted so their form state survives tab switches
  let visited = $state(new Set<Section>(["general"]));

  function activate(next: Section): void {
    if (next === section) return;
    visited = new Set(visited).add(next);
    section = next;
    if (next === "agents" && !agents.loaded) void agents.load();
    if (next === "pools" && !pools.loaded) void pools.load();
  }

  function close(): void {
    agents.open = false;
  }

  function autofocus(node: HTMLElement) {
    node.focus();
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === "Escape") close(); }} />

<div
  class="settings-backdrop"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) close();
  }}
>
  <div class="settings-surface" role="dialog" aria-modal="true" aria-label="settings" tabindex="-1" use:autofocus>
    <div class="settings-header">
      <strong class="settings-title">settings</strong>
      <nav class="settings-tabs" aria-label="settings sections">
        <button
          type="button"
          class="settings-tab"
          aria-current={section === "general" ? "page" : undefined}
          onclick={() => activate("general")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 7h-9M14 17H5" />
            <circle cx="7" cy="7" r="3" />
            <circle cx="17" cy="17" r="3" />
          </svg>
          <span>General</span>
        </button>
        <button
          type="button"
          class="settings-tab"
          aria-current={section === "agents" ? "page" : undefined}
          onclick={() => activate("agents")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="5" y="7" width="14" height="11" rx="2" />
            <path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
          </svg>
          <span>Agents</span>
        </button>
        <button
          type="button"
          class="settings-tab"
          aria-current={section === "pools" ? "page" : undefined}
          onclick={() => activate("pools")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
          <span>Pools</span>
        </button>
      </nav>
      <button type="button" class="settings-close" onclick={close} aria-label="close settings" title="close settings">×</button>
    </div>
    <main class="settings-main">
      {#if visited.has("general")}
        <div class="settings-section-host" hidden={section !== "general"}><GeneralSettings /></div>
      {/if}
      {#if visited.has("agents")}
        <div class="settings-section-host" hidden={section !== "agents"}>
          {#if agents.loaded}
            <AgentsSettings />
          {:else}
            <!-- gate on load: mounting the form before the fetch lands initializes
                 every select from an empty store — the "settings look reset" race -->
            <p class="settings-loading">
              loading agent settings…
              <button type="button" onclick={() => void agents.load()}>retry</button>
            </p>
          {/if}
        </div>
      {/if}
      {#if visited.has("pools")}
        <div class="settings-section-host" hidden={section !== "pools"}>
          {#if pools.loaded}
            <PoolsSettings />
          {:else}
            <p class="settings-loading">
              loading pool settings…
              <button type="button" onclick={() => void pools.load()}>retry</button>
            </p>
          {/if}
        </div>
      {/if}
    </main>
  </div>
</div>
