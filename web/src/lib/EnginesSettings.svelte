<script lang="ts">
  import { tick } from "svelte";
  import { agents } from "./agents.svelte";
  import { draftProblem, engines, engineSummary, MAX_SEATS, type EngineDraft } from "./engines.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";

  const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  /** Claude Code's `--effort` levels (CLAUDE_EFFORT_LEVELS in src/db.ts). */
  const EFFORT = ["low", "medium", "high", "xhigh", "max"] as const;

  let saving = $state<Record<string, boolean>>({});
  /** Per-engine "advanced" disclosure; unset = open only when the engine already carries flags. */
  let advanced = $state<Record<string, boolean>>({});
  const flagCount = (e: EngineDraft) => e.flags.filter((f) => f.trim()).length;
  let savingSettings = $state(false);
  let toDelete = $state<EngineDraft | null>(null);

  let providers = $derived([...new Set(engines.models.map((m) => m.provider))].sort());

  /** Models for one engine's select: filtered to its provider, so a pair is always coherent. */
  function modelsFor(provider: string) {
    return engines.models.filter((m) => !provider || m.provider === provider);
  }

  /** Who runs on an engine: board-role and lane-actor lineups (ids dedupe). */
  function usedBy(id: string): string[] {
    const users = new Set<string>();
    for (const [role, cfg] of Object.entries(agents.configs)) if (cfg.runsOn?.includes(id)) users.add(role);
    for (const ctx of Object.values(agents.laneContexts)) {
      for (const a of ctx?.actors ?? []) if (a.config?.runsOn?.includes(id)) users.add(a.id);
    }
    return [...users];
  }

  /** The Providers rail's master switch; engines spawn only when their harness is on. */
  function harnessOn(harness: "pi" | "claude"): boolean {
    return engines.settings.harnesses?.[harness] !== false;
  }

  function setHarness(e: EngineDraft, harness: "pi" | "claude"): void {
    if (e.harness === harness) return;
    e.harness = harness;
    // a claude engine takes an alias only — never carry a pi provider/model/thinking across
    e.provider = "";
    e.model = "";
    e.thinking = "";
  }

  async function save(e: EngineDraft): Promise<void> {
    if (saving[e.id] || draftProblem(e)) return;
    saving[e.id] = true;
    try {
      await engines.save(e);
    } finally {
      saving[e.id] = false;
    }
  }

  async function saveSettings(): Promise<void> {
    if (savingSettings) return;
    savingSettings = true;
    try {
      await engines.saveSettings();
    } finally {
      savingSettings = false;
    }
  }

  /** A never-saved draft has nothing to lose server-side: discard it without a dialog. */
  function requestDelete(e: EngineDraft): void {
    if (engines.isDraft(e.id)) void engines.remove(e.id);
    else toDelete = e;
  }

  /** "+ new engine" lands the caret in the new draft's name, ready to type. */
  async function addEngine(): Promise<void> {
    const draft = engines.addDraft();
    await tick();
    const input = document.querySelector<HTMLInputElement>(`[data-engine="${draft.id}"] .engine-name input`);
    input?.focus();
    input?.select();
  }

  async function confirmDelete(): Promise<void> {
    if (!toDelete) return;
    const target = toDelete;
    toDelete = null;
    if (await engines.remove(target.id)) void agents.load(); // lineups lost the engine server-side
  }

  let effective = $derived(Math.min(engines.settings.maxWorkers, engines.totalSeats));
</script>

<div class="settings-general">
  <section class="settings-general-section">
    <h3 class="settings-general-heading">Engines</h3>
    <p class="settings-general-description">
      An engine is the only place a model is chosen: a harness, its model, and how many sessions it may run at once (seats).
      Actors pick engines in Agents → <em>runs on</em>; the first engine with a free seat wins and the rest are fallbacks.
      A quota or auth failure cools every engine on the same provider account.
    </p>

    <div class="engine-board settings-form">
      <label>
        board default
        <select bind:value={engines.settings.defaultEngine}>
          <option value={null}>pi default (pi's own settings, 1 seat)</option>
          {#each engines.engines.filter((e) => !engines.isDraft(e.id)) as e (e.id)}
            <option value={e.id}>{e.name}</option>
          {/each}
        </select>
      </label>
      <label>
        board concurrency
        <input type="number" min="1" max="20" bind:value={engines.settings.maxWorkers} />
      </label>
      <button
        type="button"
        class:primary={engines.settingsDirty}
        class:ghost={!engines.settingsDirty}
        disabled={savingSettings || !engines.settingsDirty}
        onclick={saveSettings}
      >
        {savingSettings ? "saving…" : engines.settingsDirty ? "save" : "saved"}
      </button>
      <p class="engine-effective" data-testid="engine-effective">
        at most {effective} session{effective === 1 ? "" : "s"} at once — {engines.totalSeats} enabled seat{engines.totalSeats === 1 ? "" : "s"}{engines.settings.maxWorkers < engines.totalSeats ? `, capped at ${engines.settings.maxWorkers}` : ""}
      </p>
    </div>

    {#if engines.engines.length === 0}
      <p class="settings-general-description">No engines yet — every actor runs on pi's own default model, one session at a time.</p>
    {/if}

    {#each engines.engines as e (e.id)}
      {@const users = usedBy(e.id)}
      {@const problem = draftProblem(e)}
      {@const failure = engines.errorFor(e)}
      {@const dirty = engines.isDirty(e)}
      {@const draft = engines.isDraft(e.id)}
      <section class="engine-card settings-form" data-engine={e.id} class:off={!e.enabled} aria-label={`engine ${e.name.trim() || "(unnamed)"}`}>
        <div class="engine-identity">
          <label class="engine-name">
            name
            <input bind:value={e.name} placeholder="e.g. GLM flash" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore aria-invalid={!e.name.trim()} />
          </label>
          <div class="engine-field">
            <span class="engine-field-label" id={`engine-${e.id}-harness`}>harness</span>
            <div class="seg" role="group" aria-labelledby={`engine-${e.id}-harness`}>
              <button
                type="button"
                class="seg-option"
                class:on={e.harness === "pi"}
                aria-pressed={e.harness === "pi"}
                disabled={e.harness !== "pi" && !harnessOn("pi")}
                title={e.harness !== "pi" && !harnessOn("pi") ? "pi is off — enable it in Providers" : undefined}
                onclick={() => setHarness(e, "pi")}
              >
                <span class="seg-label">pi</span>
              </button>
              <button
                type="button"
                class="seg-option"
                class:on={e.harness === "claude"}
                aria-pressed={e.harness === "claude"}
                disabled={e.harness !== "claude" && !harnessOn("claude")}
                title={e.harness !== "claude" && !harnessOn("claude") ? "Claude Code is off — enable it in Providers" : undefined}
                onclick={() => setHarness(e, "claude")}
              >
                <span class="seg-label">claude code</span>
              </button>
            </div>
          </div>
          <label class="engine-enabled">
            <input type="checkbox" bind:checked={e.enabled} />
            enabled
          </label>
        </div>

        <div class="engine-fields">
          {#if e.harness === "claude"}
            <label>
              model
              <select bind:value={e.model} aria-label={`${e.name} model`}>
                <option value="">claude default (sonnet)</option>
                {#each engines.claudeModels as m (m.id)}
                  <option value={m.id}>{m.label} · {m.note}</option>
                {/each}
                {#if e.model && !engines.claudeModels.some((m) => m.id === e.model)}
                  <option value={e.model}>{e.model} · custom</option>
                {/if}
              </select>
            </label>
            <label>
              effort
              <select bind:value={e.thinking} aria-label={`${e.name} effort`}>
                <option value="">claude default</option>
                {#each EFFORT as t (t)}
                  <option value={t}>{t}</option>
                {/each}
              </select>
            </label>
          {:else}
            {#if engines.models.length > 0}
              <label>
                provider
                <select bind:value={e.provider} aria-label={`${e.name} provider`} onchange={() => { if (e.model && !modelsFor(e.provider).some((m) => m.id === e.model)) e.model = ""; }}>
                  <option value="">pi default</option>
                  {#each providers as p (p)}
                    <option value={p}>{p}</option>
                  {/each}
                  {#if e.provider && !providers.includes(e.provider)}
                    <option value={e.provider}>{e.provider} · custom</option>
                  {/if}
                </select>
              </label>
              <label>
                model
                <select
                  bind:value={e.model}
                  aria-label={`${e.name} model`}
                  onchange={() => {
                    const hit = engines.models.find((m) => m.id === e.model && (!e.provider || m.provider === e.provider));
                    if (hit) e.provider = hit.provider; // picking a model fixes its provider
                  }}
                >
                  <option value="">pi default</option>
                  {#each modelsFor(e.provider) as m (`${m.provider}/${m.id}`)}
                    <option value={m.id}>{e.provider ? m.id : `${m.provider} · ${m.id}`} · {m.context}{m.thinking ? " · thinks" : ""}</option>
                  {/each}
                  {#if e.model && !engines.models.some((m) => m.id === e.model)}
                    <option value={e.model}>{e.model} · custom</option>
                  {/if}
                </select>
              </label>
            {:else}
              <label>provider <input bind:value={e.provider} placeholder="pi default (e.g. zai)" /></label>
              <label>model <input bind:value={e.model} placeholder="pi default" /></label>
            {/if}
            <label>
              thinking
              <select bind:value={e.thinking} aria-label={`${e.name} thinking`}>
                <option value="">default (max for planner/reviewers)</option>
                {#each THINKING as t (t)}
                  <option value={t}>{t}</option>
                {/each}
              </select>
            </label>
          {/if}
          <label class="engine-seats">
            seats
            <input type="number" min="1" max={MAX_SEATS} step="1" bind:value={e.seats} aria-invalid={problem?.startsWith("seats") ?? false} />
          </label>
        </div>

        <details class="engine-advanced" bind:open={() => advanced[e.id] ?? flagCount(e) > 0, (v) => (advanced[e.id] = v)}>
          <summary>advanced{flagCount(e) > 0 ? ` · ${flagCount(e)} harness flag${flagCount(e) === 1 ? "" : "s"}` : ""}</summary>
          <label class="engine-flags">
            <span>harness flags <span class="field-hint">one per line, passed to every spawn</span></span>
            <textarea
              rows="2"
              value={e.flags.join("\n")}
              placeholder={e.harness === "claude" ? "e.g. --max-turns 40" : "e.g. --no-mcp"}
              oninput={(ev) => (e.flags = (ev.currentTarget as HTMLTextAreaElement).value.split("\n"))}
            ></textarea>
          </label>
        </details>

        {#if (dirty && problem) || failure}
          <p class="engine-error" role="alert">{failure ?? problem}</p>
        {/if}

        <div class="engine-meta">
          <span class="chip mono" title={engineSummary(e)}>{engineSummary(e)}</span>
          {#if engines.settings.defaultEngine === e.id}<span class="chip">board default</span>{/if}
          {#if !e.enabled}<span class="chip">disabled</span>{/if}
          {#if !harnessOn(e.harness)}<span class="chip">harness off</span>{/if}
          <span class="engine-users">{users.length > 0 ? `runs ${users.join(", ")}` : "in no lineup yet"}</span>
          <span class="spacer"></span>
          <button type="button" class="ghost danger" onclick={() => requestDelete(e)}>{draft ? "discard" : "delete"}</button>
          <button
            type="button"
            class:primary={dirty && !problem}
            class:ghost={!dirty || Boolean(problem)}
            disabled={saving[e.id] || Boolean(problem) || !dirty}
            onclick={() => save(e)}
          >
            {saving[e.id] ? "saving…" : draft ? "create" : dirty ? "save" : "saved"}
          </button>
        </div>
      </section>
    {/each}

    <div class="engine-new">
      <button type="button" class="ghost" onclick={addEngine}>+ new engine</button>
    </div>
  </section>
</div>

{#if toDelete}
  {@const users = usedBy(toDelete.id)}
  <ConfirmDialog
    title="Delete engine"
    message={`Delete engine “${toDelete.name}”?${users.length ? ` It is dropped from ${users.join(", ")} — an emptied lineup falls back to the board default.` : ""} In-flight sessions finish normally.`}
    onconfirm={confirmDelete}
    oncancel={() => (toDelete = null)}
  />
{/if}

<style>
  .engine-board {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 140px auto;
    align-items: end;
    gap: 10px;
    margin-bottom: 14px;
  }
  .engine-effective {
    grid-column: 1 / -1;
    margin: 0;
    color: var(--text-dim);
    font-size: 12px;
  }
  .engine-card {
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    margin-bottom: 12px;
    background: var(--bg-panel);
    gap: 10px;
  }
  /* band 1 — identity: what it is called, which harness, whether it runs */
  .engine-identity {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 12px;
  }
  .engine-name {
    flex: 1 1 200px;
    min-width: 0;
  }
  .engine-name input {
    font-weight: 600;
  }
  .engine-field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  /* the shared .settings-form label voice, for a label that heads a button group */
  .engine-field-label {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
  }
  .engine-enabled {
    flex-direction: row !important;
    align-items: center;
    gap: 6px;
    min-height: 36px;
    font-weight: 400 !important;
  }
  /* band 2 — what runs: model fields flex, seats stays number-sized */
  .engine-fields {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 10px 12px;
  }
  .engine-fields label {
    flex: 1 1 150px;
    min-width: 0;
  }
  .engine-fields select {
    width: 100%;
    min-width: 0;
  }
  .engine-fields .engine-seats {
    flex: 0 0 76px;
  }
  .engine-seats input {
    width: 100%;
    font-variant-numeric: tabular-nums;
  }
  /* band 3 — raw harness flags, disclosed on demand */
  .engine-advanced > summary {
    width: fit-content;
    cursor: pointer;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
    list-style: none;
  }
  .engine-advanced > summary::-webkit-details-marker {
    display: none;
  }
  .engine-advanced > summary::before {
    content: "▸ ";
  }
  .engine-advanced[open] > summary::before {
    content: "▾ ";
  }
  .engine-advanced > summary:hover {
    color: var(--text);
  }
  .engine-advanced > summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: var(--radius-small);
  }
  .engine-flags {
    margin-top: 8px;
  }
  .engine-flags textarea {
    font-family: var(--font-mono);
    font-size: 12px;
    resize: vertical;
  }
  .field-hint {
    color: var(--text-dim);
    font-weight: 400;
  }
  .engine-card [aria-invalid="true"] {
    border-color: var(--error-border);
  }
  .engine-error {
    margin: 0;
    color: var(--error);
    font-size: 12px;
  }
  .engine-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding-top: 10px;
    border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
  }
  /* the spawn spec is the card's summary: meta size, never truncated */
  .engine-meta .chip.mono {
    max-width: none;
    font-size: 11px;
  }
  .engine-card.off .engine-meta .chip.mono {
    text-decoration: line-through;
    color: var(--text-dim);
  }
  .engine-users {
    color: var(--text-dim);
    font-size: 12px;
  }
  .spacer {
    flex: 1;
  }
  @media (max-width: 640px) {
    .engine-fields label {
      flex-basis: 100%;
    }
    .engine-fields .engine-seats {
      flex: 0 0 96px;
    }
  }
  .seg-option:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }
</style>
