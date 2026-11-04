<script lang="ts">
  import { ChevronDown, ChevronUp } from "@lucide/svelte";
  import { agents } from "./agents.svelte";
  import { engines, engineSummary, type EngineDraft } from "./engines.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";

  const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

  let saving = $state<Record<string, boolean>>({});
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

  function setHarness(e: EngineDraft, harness: "pi" | "claude"): void {
    if (e.harness === harness) return;
    e.harness = harness;
    // a claude engine takes an alias only — never carry a pi provider/model/thinking across
    e.provider = "";
    e.model = "";
    e.thinking = "";
  }

  async function save(e: EngineDraft): Promise<void> {
    if (saving[e.id]) return;
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

    {#each engines.engines as e, i (e.id)}
      {@const users = usedBy(e.id)}
      <div class="engine-card settings-form" data-engine={e.id} class:disabled={!e.enabled}>
        <div class="engine-head">
          <label class="engine-name">
            name
            <input bind:value={e.name} placeholder="e.g. GLM flash" />
          </label>
          <div>
            <span class="field-label">harness</span>
            <div class="seg">
              <button type="button" class="seg-option" class:on={e.harness === "pi"} aria-pressed={e.harness === "pi"} onclick={() => setHarness(e, "pi")}>
                <span class="seg-label">pi</span>
              </button>
              <button type="button" class="seg-option" class:on={e.harness === "claude"} aria-pressed={e.harness === "claude"} onclick={() => setHarness(e, "claude")}>
                <span class="seg-label">claude code</span>
              </button>
            </div>
          </div>
          <div class="engine-order">
            <button type="button" class="ghost" aria-label={`move ${e.name} up`} disabled={i === 0 || engines.isDraft(e.id)} onclick={() => void engines.move(e.id, -1)}>
              <ChevronUp size={14} strokeWidth={1.75} />
            </button>
            <button type="button" class="ghost" aria-label={`move ${e.name} down`} disabled={i === engines.engines.length - 1 || engines.isDraft(e.id)} onclick={() => void engines.move(e.id, 1)}>
              <ChevronDown size={14} strokeWidth={1.75} />
            </button>
          </div>
        </div>

        <div class="row engine-model">
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
            <p class="engine-note">Claude Code resolves its own login and thinking — no provider or thinking level here.</p>
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
        </div>

        <div class="row engine-capacity">
          <label>
            seats
            <input type="number" min="1" max="12" bind:value={e.seats} />
          </label>
          <label class="engine-flags">
            harness flags <span class="field-hint">one per line</span>
            <textarea
              rows="1"
              value={e.flags.join("\n")}
              placeholder={e.harness === "claude" ? "e.g. --max-turns 40" : "e.g. --no-mcp"}
              oninput={(ev) => (e.flags = (ev.currentTarget as HTMLTextAreaElement).value.split("\n"))}
            ></textarea>
          </label>
          <label class="engine-enabled">
            <input type="checkbox" bind:checked={e.enabled} />
            enabled
          </label>
        </div>

        <div class="engine-meta">
          <span class="chip mono" title="what a spawn on this engine passes">{engineSummary(e)}</span>
          {#if engines.settings.defaultEngine === e.id}<span class="chip">board default</span>{/if}
          <span class="engine-users">{users.length > 0 ? `runs ${users.join(", ")}` : "in no lineup yet"}</span>
          <span class="spacer"></span>
          <button type="button" class="ghost danger" onclick={() => (toDelete = e)}>delete</button>
          <button
            type="button"
            class:primary={engines.isDirty(e)}
            class:ghost={!engines.isDirty(e)}
            disabled={saving[e.id] || !e.name.trim() || !engines.isDirty(e)}
            onclick={() => save(e)}
          >
            {saving[e.id] ? "saving…" : engines.isDraft(e.id) ? "create" : engines.isDirty(e) ? "save" : "saved"}
          </button>
        </div>
      </div>
    {/each}

    <div class="new-pool-bar">
      <button type="button" class="ghost" onclick={() => engines.addDraft()}>+ new engine</button>
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
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .engine-card.disabled {
    opacity: 0.7;
  }
  .engine-head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 12px;
  }
  .engine-name {
    flex: 1 1 180px;
  }
  .engine-order {
    display: flex;
    gap: 2px;
    margin-left: auto;
  }
  .engine-model label,
  .engine-capacity label {
    flex: 1 1 140px;
    min-width: 0;
  }
  .engine-model select {
    width: 100%;
  }
  .engine-flags {
    flex: 2 1 200px;
  }
  .engine-enabled {
    flex: 0 0 auto !important;
    flex-direction: row !important;
    align-items: center;
    gap: 6px;
  }
  .engine-note {
    flex-basis: 100%;
    margin: 0;
    color: var(--text-dim);
    font-size: 12px;
  }
  .engine-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .engine-users {
    color: var(--text-dim);
    font-size: 12px;
  }
  .field-hint {
    color: var(--text-dim);
  }
  .spacer {
    flex: 1;
  }
</style>
