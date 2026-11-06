<script lang="ts">
  /**
   * Composer controls: model + thinking-level picker chips (pi-web toolbar
   * variant). One shared implementation for both chat surfaces — ChatPanel
   * mounts it under the input box. Catalog comes from /chat-models — the
   * chat runtime's authed catalog (chat sessions run noExtensions, so CLI
   * extension models like antigravity are not offered); server caches 10 min.
   */
  import { Check, Cpu, Lightbulb, LoaderCircle } from "@lucide/svelte";
  import { api } from "../api";
  import type { CatalogModel } from "../../../src/models";
  import { chat } from "./chat.svelte";

  let open = $state<null | "model" | "thinking">(null); // one dropdown at a time
  let filter = $state("");
  let catalog = $state<CatalogModel[]>([]);

  // the catalog is re-read every time the menu opens: auth changes and the
  // Providers panel's per-model switches (hidden models never arrive) both
  // surface without a reload
  function readCatalog(): void {
    void api["chat-models"].get().then((res) => {
      if (!res.error) catalog = res.data.models;
    });
  }

  $effect(() => {
    if (open === "model") readCatalog();
  });

  // outside click closes (mousedown so it beats the chip's own click toggling)
  $effect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement | null)?.closest(".chat-select")) {
        open = null;
        filter = "";
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  });

  const locked = $derived(chat.switching || chat.streaming.isStreaming);
  const showFilter = $derived(catalog.length > 8);

  // catalog order is preserved (pi-web #783: never re-sort a provider's models);
  // duplicate provider/id rows are dropped (pi's table repeats ids across tiers)
  const groups = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    const seen = new Set<string>();
    const out: { provider: string; items: CatalogModel[] }[] = [];
    for (const m of catalog) {
      if (seen.has(`${m.provider}:${m.id}`)) continue;
      if (q && !`${m.id} ${m.provider}/${m.id}`.toLowerCase().includes(q)) continue;
      let group = out.at(-1);
      if (!group || group.provider !== m.provider) {
        group = { provider: m.provider, items: [] };
        out.push(group);
      }
      group.items.push(m);
      seen.add(`${m.provider}:${m.id}`);
    }
    return out;
  });

  function toggle(which: "model" | "thinking"): void {
    if (locked) return;
    const next = open === which ? null : which;
    open = next;
    filter = "";
  }

  function pickModel(provider: string, id: string): void {
    open = null;
    filter = "";
    void chat.setModel(provider, id);
  }

  function pickLevel(level: string): void {
    open = null;
    void chat.setThinkingLevel(level);
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === "Escape" && open) { open = null; filter = ""; } }} />

<div class="chat-selectors">
  <!-- model chip -->
  <div class="chat-select">
    <button
      type="button"
      class="chat-select-chip"
      class:open={open === "model"}
      class:locked
      aria-haspopup="listbox"
      aria-expanded={open === "model"}
      aria-label="model"
      title={locked ? chat.modelLabel || "pi default" : "change model"}
      onclick={() => toggle("model")}
    >
      {#if chat.switching}
        <LoaderCircle size={11} strokeWidth={2.4} class="chat-spin" />
      {:else}
        <Cpu size={11} strokeWidth={2} />
      {/if}
      <span class="chat-select-label">{chat.model ? chat.model.id : "pi default"}</span>
    </button>
    {#if open === "model"}
      <div class="chat-select-menu" role="listbox" aria-label="model">
        {#if showFilter}
          <div class="chat-select-filter">
            <input
              placeholder="filter models"
              aria-label="filter models"
              bind:value={filter}
              autocomplete="off"
              spellcheck="false"
            />
          </div>
        {/if}
        <div class="chat-select-list">
          {#if groups.length === 0}
            <div class="chat-select-empty">{filter.trim() ? "no matching models" : "no models available"}</div>
          {:else}
            {#each groups as group, gi (group.provider)}
              {#if groups.length > 1}
                <div class="chat-select-group" class:first={gi === 0}>{group.provider}</div>
              {/if}
              {#each group.items as m (`${m.provider}:${m.id}`)}
                <button
                  type="button"
                  class="chat-select-row"
                  class:active={chat.model?.provider === m.provider && chat.model?.id === m.id}
                  role="option"
                  aria-selected={chat.model?.provider === m.provider && chat.model?.id === m.id}
                  onclick={() => pickModel(m.provider, m.id)}
                >
                  <span class="chat-select-check">{#if chat.model?.provider === m.provider && chat.model?.id === m.id}<Check size={10} strokeWidth={2.5} />{/if}</span>
                  <span class="chat-select-row-label">{m.id}{#if m.context}&nbsp;· {m.context}{/if}{#if m.thinking}&nbsp;· thinks{/if}</span>
                </button>
              {/each}
            {/each}
          {/if}
        </div>
      </div>
    {/if}
  </div>

  <!-- thinking chip -->
  <div class="chat-select">
    <button
      type="button"
      class="chat-select-chip"
      class:open={open === "thinking"}
      class:locked
      aria-haspopup="listbox"
      aria-expanded={open === "thinking"}
      aria-label="thinking level"
      title={locked ? chat.thinkingLevel : "change thinking level"}
      onclick={() => toggle("thinking")}
    >
      <Lightbulb size={11} strokeWidth={2} />
      <span class="chat-select-label">{chat.thinkingLevel || "off"}</span>
    </button>
    {#if open === "thinking"}
      <div class="chat-select-menu" role="listbox" aria-label="thinking level">
        <div class="chat-select-list">
          {#each chat.thinkingLevels as level (level)}
            <button
              type="button"
              class="chat-select-row"
              class:active={chat.thinkingLevel === level}
              role="option"
              aria-selected={chat.thinkingLevel === level}
              onclick={() => pickLevel(level)}
            >
              <span class="chat-select-check">{#if chat.thinkingLevel === level}<Check size={10} strokeWidth={2.5} />{/if}</span>
              <span class="chat-select-row-label">{level}</span>
            </button>
          {/each}
          {#if chat.thinkingLevels.length === 0}
            <div class="chat-select-empty">no thinking levels</div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>
