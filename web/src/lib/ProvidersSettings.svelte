<script lang="ts">
  import { CodeXml, Layers, RefreshCw, Terminal } from "@lucide/svelte";
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
    missing: "not found",
  };
  const BACKEND_STATUS: Record<ProviderView["status"], string> = {
    ok: "signed in",
    unsigned: "not signed in",
    cooling: "cooling",
  };

  const ICONS: Record<string, typeof Terminal> = { pi: Terminal, claude: CodeXml };

  // the rail's second line — the status word plus the one qualifier that identifies it
  function headline(h: HarnessView): string {
    if (h.status === "missing") return "not found · CLI not detected";
    if (h.status === "cooling") return "cooling · quota";
    if (h.id === "pi") return `ready · ${h.backends.length} backend${h.backends.length === 1 ? "" : "s"}`;
    return "ready · ambient auth";
  }
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
        {@const Icon = ICONS[h.id] ?? Layers}
        <button
          type="button"
          class="provider-row"
          data-harness={h.id}
          aria-current={h.id === harnesses.selected ? "true" : undefined}
          aria-label={`${h.label}, ${headline(h)}`}
          onclick={() => harnesses.select(h.id)}
        >
          <span class="provider-row-line1">
            <span class="provider-icon" aria-hidden="true"><Icon size={15} strokeWidth={1.8} /></span>
            <span class="provider-name" title={h.id}>{h.label}</span>
            {#if h.version}<code class="provider-version">{h.version}</code>{/if}
          </span>
          <span class="provider-row-line2">
            <span class="provider-dot" data-status={h.status} aria-hidden="true"></span>
            <span class="provider-row-status">{headline(h)}</span>
          </span>
        </button>
      {/each}
      {#if harnesses.list.length === 0}
        <p class="provider-empty">no harnesses registered</p>
      {/if}
    </nav>

    <div class="provider-detail">
      {#if view}
        {@const Icon = ICONS[view.id] ?? Layers}
        <header class="provider-header">
          <span class="provider-icon" aria-hidden="true"><Icon size={15} strokeWidth={1.8} /></span>
          <h4 class="provider-title">{view.label}</h4>
          {#if view.version}<code class="provider-version">{view.version}</code>{/if}
        </header>

        <section class="provider-section">
          <div class="provider-statusline">
            <span class="provider-dot" data-status={view.status} aria-hidden="true"></span>
            <span class="provider-status-word" data-status={view.status}>{STATUS[view.status]}</span>
            <span class="provider-status-detail">{view.detail}</span>
          </div>
          {#if view.id === "claude" && view.status === "ready"}
            <p class="provider-note">Auth is ambient — the CLI's own login or <code>ANTHROPIC_API_KEY</code>.</p>
          {/if}
          <div class="provider-engines">
            <span class="provider-label">engines</span>
            {#each view.engines as name, i (i)}
              <span class="chip">{name}</span>
            {:else}
              <span class="provider-none">none — add one in Engines</span>
            {/each}
          </div>
          {#each view.cooling as c (c.account)}
            <p class="provider-cooling" role="status">cooling · {c.account} until {new Date(c.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{#if c.cause} · {c.cause.replace(/-/g, " ")}{/if} — spawns on it wait</p>
          {/each}
        </section>

        {#if view.id === "pi"}
          {#if backends.length > 0}
            <section class="provider-section">
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
              {#each shownBackends as { backend, models } (backend.id)}
                <div class="provider-backend">
                  <header class="provider-backend-head">
                    <span class="provider-dot" data-status={backend.status} aria-hidden="true"></span>
                    <span class="provider-backend-id" title={backend.id}>{backend.id}</span>
                    <span class="provider-backend-status" data-status={backend.status}>{BACKEND_STATUS[backend.status]}</span>
                    <code class="provider-version">{backend.models.length}</code>
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
                          <span class="badge">{m.context} ctx</span>
                          <span class="badge">{m.maxOut} out</span>
                          {#if m.thinking}<span class="badge">thinks</span>{/if}
                          {#if m.images}<span class="badge">images</span>{/if}
                        </span>
                      </li>
                    {/each}
                  </ul>
                </div>
              {:else}
                <p class="provider-empty">no model matches “{harnesses.filter.trim()}”</p>
              {/each}
            </section>
          {:else}
            <p class="provider-empty">No LLM backends in pi's catalog.</p>
          {/if}
        {:else if view.models.length > 0}
          <section class="provider-section">
            <div class="provider-models-head">
              <span class="provider-label">models · {view.models.length}</span>
            </div>
            <ul class="provider-models">
              {#each view.models as m (m.id)}
                <li class="provider-model">
                  <span class="provider-model-id" title={m.id}>{m.label}</span>
                  <span class="provider-model-meta">
                    <span class="badge">{m.note}</span>
                  </span>
                </li>
              {/each}
            </ul>
            <p class="provider-note">Aliases — the harness resolves them to the current concrete model at spawn.</p>
          </section>
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
    grid-template-columns: 224px minmax(0, 1fr);
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-panel);
    background: var(--bg-panel);
    overflow: hidden;
  }

  /* t3code's rail: divided two-line rows, fill selection, no gaps */
  .provider-rail {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border);
    overflow-y: auto;
  }

  .provider-row {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 3px;
    padding: 11px 12px;
    border: 0;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
    background: transparent;
    color: var(--text-muted);
    text-align: left;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }

  .provider-row:last-child {
    border-bottom: 0;
  }

  .provider-row:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .provider-row[aria-current="true"] {
    background: var(--bg-selected);
    color: var(--text);
  }

  .provider-row:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .provider-row-line1 {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }

  .provider-row-line2 {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-left: 22px; /* lines up under the name, past icon + gap */
  }

  .provider-icon {
    display: flex;
    flex: none;
    align-items: center;
    color: var(--text-dim);
  }

  .provider-row[aria-current="true"] .provider-icon {
    color: var(--text-muted);
  }

  .provider-name {
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    font-size: 13px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .provider-version {
    flex: none;
    margin-left: auto;
    overflow: hidden;
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 10.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .provider-row-status {
    overflow: hidden;
    color: var(--text-dim);
    font-size: 11.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
  }

  /* t3code's editor header: icon + name + version chip, then divided sections */
  .provider-header {
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    padding: 12px 16px 10px;
  }

  .provider-title {
    margin: 0;
    color: var(--text);
    font-size: 13.5px;
    font-weight: 600;
  }

  .provider-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 16px 14px;
    border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
  }

  .provider-statusline {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 7px;
  }

  .provider-statusline .provider-dot {
    align-self: center;
  }

  .provider-status-word {
    color: var(--text);
    font-size: 12.5px;
    font-weight: 600;
  }

  .provider-status-word[data-status="cooling"] {
    color: var(--error);
  }

  .provider-status-detail {
    min-width: 0;
    color: var(--text-dim);
    font-size: 12px;
  }

  .provider-note {
    margin: 0;
    max-width: 60ch;
    color: var(--text-dim);
    font-size: 11.5px;
    line-height: 1.5;
  }

  .provider-note code {
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

  .provider-backend {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding-top: 4px;
  }

  .provider-backend + .provider-backend {
    margin-top: 6px;
    border-top: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
    padding-top: 10px;
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
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .provider-model {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 2px;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
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
    gap: 5px;
  }

  /* t3code's capability badges: bordered chips, not bare meta text */
  .badge {
    padding: 1px 6px;
    border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    border-radius: 4px;
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 1.5;
    white-space: nowrap;
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
      border-right: 0;
      border-bottom: 1px solid var(--border);
      overflow-x: auto;
      overflow-y: hidden;
    }

    .provider-row {
      min-width: 150px;
      border-bottom: 0;
      border-right: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
    }

    .provider-row[aria-current="true"] {
      box-shadow: inset 0 -2px 0 var(--accent);
    }

    .provider-detail {
      overflow-y: visible;
    }
  }
</style>
