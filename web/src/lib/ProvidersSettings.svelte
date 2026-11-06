<script lang="ts">
  import { RefreshCw } from "@lucide/svelte";
  import { causeLabel, checkedAgo, FILTER_THRESHOLD, filterModels, providers, type ProviderView } from "./providers.svelte";

  // "checked N ago" ticks on its own — 10s keeps the label within 10s of the real
  // age; the button is the only thing that refetches
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 10_000);
    return () => clearInterval(timer);
  });

  let view = $derived(providers.list.find((p) => p.id === providers.selected) ?? null);
  let shown = $derived(view ? filterModels(view.models, providers.filter) : []);

  const STATUS: Record<ProviderView["status"], string> = {
    ok: "signed in",
    unsigned: "not signed in",
    cooling: "cooling",
  };

  function timeOf(ms: number): string {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
</script>

<div class="settings-general providers-settings">
  <div class="providers-head">
    <div class="providers-head-text">
      <h3 class="settings-general-heading">Providers</h3>
      <p class="settings-general-description">
        Who serves the models. <em>Signed in</em> means the chat runtime has the provider authed; <em>not signed in</em> means only the pi CLI
        knows it — pi owns auth. Which model an actor runs, and how many sessions it may run, lives in Engines.
      </p>
    </div>
    <button
      type="button"
      class="ghost provider-refresh"
      disabled={providers.loading}
      title="re-read the model catalogs and live engine health"
      onclick={() => void providers.refresh()}
    >
      <RefreshCw size={13} strokeWidth={1.9} />
      {providers.loading ? "checking…" : checkedAgo(providers.checkedAt, now)}
    </button>
  </div>

  {#if providers.loadFailed && providers.loaded}
    <p class="provider-failed" role="status">catalogs unreachable — showing the last check</p>
  {/if}

  <div class="provider-split">
    <nav class="provider-rail" aria-label="providers">
      {#each providers.list as p (p.id)}
        <button
          type="button"
          class="provider-row"
          data-provider={p.id}
          aria-current={p.id === providers.selected ? "true" : undefined}
          aria-label={`${p.id}, ${STATUS[p.status]}, ${p.models.length} model${p.models.length === 1 ? "" : "s"}`}
          onclick={() => providers.select(p.id)}
        >
          <span class="provider-dot" data-status={p.status} aria-hidden="true"></span>
          <span class="provider-name" title={p.id}>{p.id}</span>
          <span class="provider-count" aria-hidden="true">{p.models.length}</span>
        </button>
      {/each}
      {#if providers.list.length === 0}
        <p class="provider-empty">no providers in the catalog</p>
      {/if}
    </nav>

    <div class="provider-detail">
      {#if view}
        <div class="provider-top">
          <h4 class="provider-headline" data-status={view.status}>
            <span class="provider-dot" data-status={view.status} aria-hidden="true"></span>
            {STATUS[view.status]}
          </h4>
          <p class="provider-detail-line">
            {#if view.status === "ok"}
              Signed in — available to chat sessions and engine spawns.
            {:else if view.status === "unsigned"}
              Not signed in — visible to the pi CLI only. Sign in with
              <code>pi auth login --provider {view.id}</code>, then refresh.
            {:else}
              Cooling · {causeLabel(view.coolingCause)}
              {#if view.coolingUntil}until {timeOf(view.coolingUntil)}{/if} — every engine on this account waits.
            {/if}
          </p>
          <div class="provider-engines">
            <span class="provider-label">engines</span>
            {#each view.engines as name, i (i)}
              <span class="chip">{name}</span>
            {:else}
              <span class="provider-none">in no enabled engine lineup</span>
            {/each}
          </div>
        </div>

        <div class="provider-models-head">
          <span class="provider-label">models · {view.models.length}</span>
          {#if view.models.length > FILTER_THRESHOLD}
            <input
              type="search"
              class="provider-filter"
              placeholder="filter models"
              aria-label="filter models"
              spellcheck="false"
              bind:value={providers.filter}
            />
          {/if}
        </div>

        {#if view.models.length === 0}
          <p class="provider-empty">No models in the catalog.</p>
        {:else}
          <ul class="provider-models">
            {#each shown as m (m.id)}
              <li class="provider-model" data-model={m.id}>
                <span class="provider-model-id" title={m.id}>{m.id}</span>
                <span class="provider-model-meta">
                  <span>{m.context} ctx</span>
                  <span>{m.maxOut} out</span>
                  {#if m.thinking}<span>thinks</span>{/if}
                  {#if m.images}<span>images</span>{/if}
                </span>
              </li>
            {:else}
              <li class="provider-empty">no model matches “{providers.filter.trim()}”</li>
            {/each}
          </ul>
        {/if}
      {:else}
        <p class="provider-empty">Pick a provider to see its models and engines.</p>
      {/if}
    </div>
  </div>
</div>

<style>
  /* two panes own their scroll: the dialog clips, each side scrolls itself */
  .providers-settings {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-bottom: 18px;
    overflow: hidden;
  }

  /* the split fills the section width; the 600px readable column would starve it */
  .settings-general.providers-settings > * {
    max-width: none;
    margin-inline: 0;
  }

  .providers-head {
    display: flex;
    flex: none;
    align-items: flex-start;
    gap: 16px;
  }

  .providers-head-text {
    flex: 1;
    min-width: 0;
  }

  .providers-head .settings-general-description {
    margin-bottom: 0;
  }

  .provider-refresh {
    display: flex;
    flex: none;
    align-items: center;
    gap: 5px;
    height: 26px;
    padding: 0 9px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .provider-failed {
    flex: none;
    margin: 0;
    color: var(--warn);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .provider-split {
    display: grid;
    flex: 1;
    grid-template-columns: 172px minmax(0, 1fr);
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-panel);
    background: var(--bg-panel);
    overflow: hidden;
  }

  .provider-rail {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
    padding: 6px;
    border-right: 1px solid var(--border);
    overflow-y: auto;
  }

  .provider-row {
    display: grid;
    flex: none;
    grid-template-columns: 8px minmax(0, 1fr) auto;
    align-items: center;
    gap: 7px;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--radius-small);
    background: transparent;
    color: var(--text-muted);
    text-align: left;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }

  .provider-row:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  /* selection is more than a hue shift: fill, accent bar, and weight */
  .provider-row[aria-current="true"] {
    background: var(--bg-selected);
    box-shadow: inset 2px 0 0 var(--accent);
    color: var(--text);
    font-weight: 600;
  }

  .provider-row:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
  }

  .provider-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .provider-count {
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 400;
  }

  .provider-dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 999px;
  }

  .provider-dot[data-status="ok"] {
    background: var(--ok);
  }

  .provider-dot[data-status="unsigned"] {
    background: var(--warn);
  }

  .provider-dot[data-status="cooling"] {
    background: var(--error);
  }

  .provider-detail {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    min-height: 0;
    padding: 14px 16px 16px;
    overflow-y: auto;
  }

  .provider-top {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .provider-headline {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 0;
    color: var(--text);
    font-size: 13px;
    font-weight: 600;
  }

  .provider-headline .provider-dot {
    width: 8px;
    height: 8px;
  }

  .provider-headline[data-status="cooling"] {
    color: var(--error);
  }

  .provider-detail-line {
    margin: 0;
    max-width: 60ch;
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.5;
  }

  .provider-detail-line code {
    color: var(--text-muted);
    font-size: 11px;
    white-space: nowrap; /* a command never breaks mid-flag */
  }

  .provider-engines {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  .provider-label {
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .provider-none {
    color: var(--text-dim);
    font-size: 12px;
  }

  .provider-models-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding-top: 2px;
    border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
  }

  .provider-filter {
    flex: 0 1 180px;
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-small);
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .provider-filter:focus-visible {
    border-color: var(--accent);
    outline: none;
  }

  .provider-models {
    display: flex;
    flex-direction: column;
    gap: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .provider-model {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 5px 2px;
    border-bottom: 1px dashed color-mix(in srgb, var(--border) 60%, transparent);
  }

  .provider-model:last-child {
    border-bottom: 0;
  }

  .provider-model-id {
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 11.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .provider-model-meta {
    display: flex;
    flex: none;
    gap: 7px;
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 10px;
  }

  .provider-empty {
    margin: 0;
    padding: 2px;
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.5;
  }

  /* one pane at a time on a phone: the rail becomes a scrolling strip above */
  @media (max-width: 640px) {
    .provider-split {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr);
    }

    .provider-rail {
      flex-direction: row;
      padding: 4px;
      border-right: 0;
      border-bottom: 1px solid var(--border);
      overflow-x: auto;
      overflow-y: hidden;
    }

    /* a horizontal strip marks the selection along its bottom edge, not the side */
    .provider-row[aria-current="true"] {
      box-shadow: inset 0 -2px 0 var(--accent);
    }

    .provider-row {
      padding: 6px 9px;
    }

    .provider-detail {
      padding: 12px;
    }
  }
</style>
