<script lang="ts">
  import { RefreshCw } from "@lucide/svelte";
  import {
    backendHint,
    checkedAgo,
    FILTER_THRESHOLD,
    filterModels,
    harnesses,
    type HarnessView,
    type ProviderView,
  } from "./harnesses.svelte";

  // "checked N ago" ticks on its own — 10s keeps the label within 10s of the real
  // age; the button is the only thing that refetches
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 10_000);
    return () => clearInterval(timer);
  });

  let view = $derived(harnesses.list.find((h) => h.id === harnesses.selected) ?? null);
  // the pi filter runs per backend; sections with no match hide entirely
  let backends = $derived(view?.id === "pi" ? view.backends : []);
  let totalModels = $derived(backends.reduce((n, b) => n + b.models.length, 0));
  let shownBackends = $derived(
    backends
      .map((b) => ({ backend: b, models: filterModels(b.models, harnesses.filter) }))
      .filter((s) => s.models.length > 0),
  );

  const STATUS: Record<HarnessView["status"], string> = {
    ready: "ready",
    cooling: "cooling",
    missing: "not installed",
  };
  const BACKEND_STATUS: Record<ProviderView["status"], string> = {
    ok: "signed in",
    unsigned: "not signed in",
    cooling: "cooling",
  };
</script>

<div class="settings-general providers-settings">
  <div class="providers-head">
    <div class="providers-head-text">
      <h3 class="settings-general-heading">Providers</h3>
      <p class="settings-general-description">
        The harness runtimes the board spawns agents on. Backing LLMs, model choice, and concurrency live in Engines; auth belongs to each
        harness.
      </p>
    </div>
    <button
      type="button"
      class="ghost provider-refresh"
      disabled={harnesses.loading}
      title="re-read the harness probes, model catalogs, and live engine health"
      onclick={() => void harnesses.refresh()}
    >
      <RefreshCw size={13} strokeWidth={1.9} />
      {harnesses.loading ? "checking…" : checkedAgo(harnesses.checkedAt, now)}
    </button>
  </div>

  {#if harnesses.loadFailed && harnesses.loaded}
    <p class="provider-failed" role="status">harness probes unreachable — showing the last check</p>
  {/if}

  <div class="provider-split">
    <nav class="provider-rail" aria-label="harness providers">
      {#each harnesses.list as h (h.id)}
        <button
          type="button"
          class="provider-row"
          data-harness={h.id}
          aria-current={h.id === harnesses.selected ? "true" : undefined}
          aria-label={`${h.label}, ${STATUS[h.status]}, ${h.engines.length} engine${h.engines.length === 1 ? "" : "s"}`}
          onclick={() => harnesses.select(h.id)}
        >
          <span class="provider-dot" data-status={h.status} aria-hidden="true"></span>
          <span class="provider-name" title={h.id}>{h.label}</span>
          <span class="provider-count" aria-hidden="true">{h.engines.length}</span>
        </button>
      {/each}
      {#if harnesses.list.length === 0}
        <p class="provider-empty">no harnesses registered</p>
      {/if}
    </nav>

    <div class="provider-detail">
      {#if view}
        <div class="provider-top">
          <h4 class="provider-headline" data-status={view.status}>
            <span class="provider-dot" data-status={view.status} aria-hidden="true"></span>
            {STATUS[view.status]}
          </h4>
          <p class="provider-detail-line">{view.detail}</p>
          {#if view.id === "claude" && view.status === "ready"}
            <p class="provider-detail-line">Auth is ambient — the CLI's own login or <code>ANTHROPIC_API_KEY</code>.</p>
          {/if}
          <div class="provider-engines">
            <span class="provider-label">engines</span>
            {#each view.engines as name, i (i)}
              <span class="chip">{name}</span>
            {:else}
              <span class="provider-none">no enabled engine runs on it — add one in Engines</span>
            {/each}
          </div>
          {#each view.cooling as c (c.account)}
            <p class="provider-cooling" role="status">cooling · {c.account} until {new Date(c.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{#if c.cause} · {c.cause.replace(/-/g, " ")}{/if} — spawns on it wait</p>
          {/each}
        </div>

        {#if view.id === "pi"}
          {#if backends.length > 0}
            <div class="provider-models-head">
              <span class="provider-label">backends · {backends.length} · {totalModels} models</span>
              {#if totalModels > FILTER_THRESHOLD}
                <input
                  type="search"
                  class="provider-filter"
                  placeholder="filter models"
                  aria-label="filter models"
                  spellcheck="false"
                  bind:value={harnesses.filter}
                />
              {/if}
            </div>
            <div class="provider-backends">
              {#each shownBackends as { backend, models } (backend.id)}
                <section class="provider-backend">
                  <header class="provider-backend-head">
                    <span class="provider-dot" data-status={backend.status} aria-hidden="true"></span>
                    <span class="provider-backend-id" title={backend.id}>{backend.id}</span>
                    <span class="provider-backend-status" data-status={backend.status}>{BACKEND_STATUS[backend.status]}</span>
                    <span class="provider-count" aria-hidden="true">{backend.models.length}</span>
                    {#each backend.engines as name, i (i)}
                      <span class="chip">{name}</span>
                    {/each}
                  </header>
                  {#if backendHint(backend)}
                    <p class="provider-backend-hint">
                      {#each backendHint(backend) ?? [] as seg, i (i)}{#if seg.code}<code>{seg.text}</code>{:else}{seg.text}{/if}{/each}
                    </p>
                  {/if}
                  <ul class="provider-models">
                    {#each models as m (m.id)}
                      <li class="provider-model" data-model={m.id}>
                        <span class="provider-model-id" title={m.id}>{m.id}</span>
                        <span class="provider-model-meta">
                          <span>{m.context} ctx</span>
                          <span>{m.maxOut} out</span>
                          {#if m.thinking}<span>thinks</span>{/if}
                          {#if m.images}<span>images</span>{/if}
                        </span>
                      </li>
                    {/each}
                  </ul>
                </section>
              {:else}
                <p class="provider-empty">no model matches “{harnesses.filter.trim()}”</p>
              {/each}
            </div>
          {:else}
            <p class="provider-empty">No LLM backends in pi's catalog.</p>
          {/if}
        {:else if view.models.length > 0}
          <div class="provider-models-head">
            <span class="provider-label">models · {view.models.length}</span>
          </div>
          <ul class="provider-models">
            {#each view.models as m (m.id)}
              <li class="provider-model">
                <span class="provider-model-id" title={m.id}>{m.label}</span>
                <span class="provider-model-meta">
                  <span>{m.note}</span>
                </span>
              </li>
            {/each}
          </ul>
          <p class="provider-detail-line">Aliases — the harness resolves them to the current concrete model at spawn.</p>
        {/if}
      {:else}
        <p class="provider-empty">Pick a harness to see its status, engines, and models.</p>
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

  .provider-dot[data-status="ok"],
  .provider-dot[data-status="ready"] {
    background: var(--ok);
  }

  .provider-dot[data-status="unsigned"],
  .provider-dot[data-status="missing"] {
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

  .provider-cooling {
    margin: 0;
    color: var(--error);
    font-family: var(--font-mono);
    font-size: 11px;
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

  .provider-backends {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .provider-backend {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .provider-backend-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 7px;
  }

  .provider-backend-head .provider-dot {
    align-self: center;
  }

  .provider-backend-id {
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
  }

  .provider-backend-status {
    color: var(--text-dim);
    font-size: 11px;
  }

  .provider-backend-status[data-status="cooling"] {
    color: var(--error);
  }

  .provider-backend-hint {
    margin: 0;
    color: var(--text-dim);
    font-size: 11.5px;
  }

  .provider-backend-hint code {
    color: var(--text-muted);
    font-size: 11px;
    white-space: nowrap;
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
