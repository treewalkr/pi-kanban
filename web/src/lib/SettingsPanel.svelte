<script lang="ts">
  import { Bot, Columns3, FolderGit2, Layers, Settings2, X } from "@lucide/svelte";
  import { agents, type SettingsSection } from "./agents.svelte";
  import { pools } from "./pools.svelte";
  import { projects } from "./projects.svelte";
  import GeneralSettings from "./GeneralSettings.svelte";
  import AgentsSettings from "./AgentsSettings.svelte";
  import PoolsSettings from "./PoolsSettings.svelte";
  import ProjectsSettings from "./ProjectsSettings.svelte";
  import LanesSettings from "./LanesSettings.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";

  type Section = SettingsSection;

  const TABS: Array<{ id: Section; label: string; icon: typeof Settings2 }> = [
    { id: "general", label: "General", icon: Settings2 },
    { id: "agents", label: "Agents", icon: Bot },
    { id: "pools", label: "Pools", icon: Layers },
    { id: "projects", label: "Projects", icon: FolderGit2 },
    { id: "lanes", label: "Lanes", icon: Columns3 },
  ];

  // the dialog remounts on every open, so this picks up the section the opener chose
  let section = $state<Section>(agents.section);
  // visited sections stay mounted so their form state survives tab switches
  let visited = $state(new Set<Section>([agents.section]));
  let surface = $state<HTMLElement | null>(null);
  let confirmDiscard = $state(false);
  // the control that opened the dialog; focus returns here on close
  let opener: HTMLElement | null = typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
    if (section === "projects" && !projects.loaded) void projects.load();
  });

  // focus starts on the surface (use:autofocus) and returns to the opener on unmount
  $effect(() => {
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  });

  function dirtyElsewhere(): boolean {
    return projects.dirty || pools.dirty;
  }

  function close(): void {
    if (dirtyElsewhere()) {
      confirmDiscard = true;
      return;
    }
    void agents.close();
  }

  function discardAndClose(): void {
    confirmDiscard = false;
    projects.revert();
    pools.revert();
    void agents.close();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      // a nested confirm owns Escape; closing both layers is the bug this guards
      if (document.querySelector('[role="alertdialog"]')) return;
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab" || !surface) return;
    const list = [...surface.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (list.length === 0) return;
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (!active || !surface.contains(active)) {
      e.preventDefault();
      first.focus();
      return;
    }
    if (e.shiftKey && (active === first || active === surface)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function autofocus(node: HTMLElement) {
    node.focus();
  }

  function statusText(): string {
    if (agents.saveState === "saving") return "saving…";
    if (agents.saveState === "failed") return "save failed";
    if (agents.saveState === "saved") return "saved";
    if (pools.dirty || projects.dirty) return "unsaved changes";
    return "";
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="settings-backdrop"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) close();
  }}
>
  <div class="settings-surface" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabindex="-1" bind:this={surface} use:autofocus>
    <div class="settings-header">
      <h2 class="settings-title" id="settings-title">settings</h2>
      <div class="settings-tabs" role="tablist" aria-label="settings sections">
        {#each TABS as tab (tab.id)}
          {@const Icon = tab.icon}
          <button
            type="button"
            class="settings-tab"
            id={`settings-tab-${tab.id}`}
            role="tab"
            aria-selected={section === tab.id}
            aria-controls={`settings-panel-${tab.id}`}
            tabindex={section === tab.id ? 0 : -1}
            onclick={() => activate(tab.id)}
          >
            <Icon size={16} strokeWidth={1.75} />
            <span>{tab.label}</span>
          </button>
        {/each}
      </div>
      <span class="settings-status" data-state={agents.saveState} aria-live="polite">{statusText()}</span>
      {#if agents.saveState === "failed"}
        <button type="button" class="ghost settings-retry" onclick={() => void agents.flush()}>retry</button>
      {/if}
      <button type="button" class="settings-close" onclick={close} aria-label="close settings" title="close settings">
        <X size={16} strokeWidth={1.75} />
      </button>
    </div>
    <main class="settings-main">
      {#if visited.has("general")}
        <div class="settings-section-host" id="settings-panel-general" role="tabpanel" aria-labelledby="settings-tab-general" hidden={section !== "general"}><GeneralSettings /></div>
      {/if}
      {#if visited.has("agents")}
        <div class="settings-section-host" id="settings-panel-agents" role="tabpanel" aria-labelledby="settings-tab-agents" hidden={section !== "agents"}>
          {#if agents.loaded}
            <AgentsSettings />
          {:else}
            <!-- gate on load: mounting the form before the fetch lands initializes
                 every select from an empty store — the "settings look reset" race -->
            <p class="settings-loading" class:err={agents.loadFailed}>
              {agents.loadFailed ? "could not load agent settings" : "loading agent settings…"}
              <button type="button" onclick={() => void agents.load()}>{agents.loadFailed ? "retry" : "reload"}</button>
            </p>
          {/if}
        </div>
      {/if}
      {#if visited.has("pools")}
        <div class="settings-section-host" id="settings-panel-pools" role="tabpanel" aria-labelledby="settings-tab-pools" hidden={section !== "pools"}>
          {#if pools.loaded}
            <PoolsSettings />
          {:else}
            <p class="settings-loading" class:err={pools.loadFailed}>
              {pools.loadFailed ? "could not load pool settings" : "loading pool settings…"}
              <button type="button" onclick={() => void pools.load()}>{pools.loadFailed ? "retry" : "reload"}</button>
            </p>
          {/if}
        </div>
      {/if}
      {#if visited.has("projects")}
        <div class="settings-section-host" id="settings-panel-projects" role="tabpanel" aria-labelledby="settings-tab-projects" hidden={section !== "projects"}>
          {#if projects.loaded}
            <ProjectsSettings />
          {:else}
            <p class="settings-loading" class:err={projects.loadFailed}>
              {projects.loadFailed ? "could not load project settings" : "loading project settings…"}
              <button type="button" onclick={() => void projects.load()}>{projects.loadFailed ? "retry" : "reload"}</button>
            </p>
          {/if}
        </div>
      {/if}
      {#if visited.has("lanes")}
        <!-- no load gate: lanes live in the board store, already SSE-refreshed -->
        <div class="settings-section-host" id="settings-panel-lanes" role="tabpanel" aria-labelledby="settings-tab-lanes" hidden={section !== "lanes"}>
          <LanesSettings />
        </div>
      {/if}
    </main>
  </div>
</div>

{#if confirmDiscard}
  <ConfirmDialog
    title="Unsaved changes"
    message="Pool or project edits have not been saved. Close and discard them?"
    confirmLabel="discard"
    onconfirm={discardAndClose}
    oncancel={() => (confirmDiscard = false)}
  />
{/if}
