<script lang="ts">
  import { Bot, Layers, Settings2 } from "@lucide/svelte";
  import { agents, type SettingsSection } from "./agents.svelte";
  import { pools } from "./pools.svelte";
  import GeneralSettings from "./GeneralSettings.svelte";
  import AgentsSettings from "./AgentsSettings.svelte";
  import PoolsSettings from "./PoolsSettings.svelte";

  type Section = SettingsSection;

  // the dialog remounts on every open, so this picks up the section the opener chose
  let section = $state<Section>(agents.section);
  // visited sections stay mounted so their form state survives tab switches
  let visited = $state(new Set<Section>([agents.section]));

  function activate(next: Section): void {
    if (next === section) return;
    visited = new Set(visited).add(next);
    section = next;
    agents.section = next; // reopening lands on the last-viewed section
  }

  // sections lazy-load their store on first view, including the section it opens on
  $effect(() => {
    if (section === "agents" && !agents.loaded) void agents.load();
    if (section === "pools" && !pools.loaded) void pools.load();
  });

  function close(): void {
    void agents.close();
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
          <Settings2 size={16} strokeWidth={1.8} />
          <span>General</span>
        </button>
        <button
          type="button"
          class="settings-tab"
          aria-current={section === "agents" ? "page" : undefined}
          onclick={() => activate("agents")}
        >
          <Bot size={16} strokeWidth={1.8} />
          <span>Agents</span>
        </button>
        <button
          type="button"
          class="settings-tab"
          aria-current={section === "pools" ? "page" : undefined}
          onclick={() => activate("pools")}
        >
          <Layers size={16} strokeWidth={1.8} />
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
