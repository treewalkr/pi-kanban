<script lang="ts">
  import type { AgentThinking, BuiltinAgentRole, WorkerPool } from "../../../src/db";
  import { X } from "@lucide/svelte";
  import { pools } from "./pools.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";

  let saving = $state<Record<string, boolean>>({});
  let savingSettings = $state(false);
  let poolToDelete = $state<WorkerPool | null>(null);

  let providers = $derived([...new Set(pools.models.map((m) => m.provider))].sort());

  function getModelGroups(providerFilter: string) {
    const forProvider = providerFilter ? pools.models.filter((m) => m.provider === providerFilter) : pools.models;
    const groups = new Map<string, Array<{ id: string; label: string }>>();
    for (const m of forProvider) {
      const list = groups.get(m.provider) ?? [];
      list.push({ id: m.id, label: `${m.id} · ${m.context}${m.thinking ? " · thinks" : ""}` });
      groups.set(m.provider, list);
    }
    return [...groups.entries()];
  }

  function addPool(): void {
    pools.addDraft();
  }

  function toggleRole(pool: WorkerPool, role: BuiltinAgentRole): void {
    if (pool.roles.includes(role)) {
      pool.roles = pool.roles.filter((r) => r !== role);
    } else {
      pool.roles = [...pool.roles, role];
    }
  }

  function addSlot(pool: WorkerPool): void {
    if (pool.slots.length < 8) {
      pool.slots = [...pool.slots, {}];
    }
  }

  function removeSlot(pool: WorkerPool, index: number): void {
    if (pool.slots.length > 1) {
      pool.slots = pool.slots.filter((_, i) => i !== index);
      if (pool.maxWorkers !== undefined) {
        pool.maxWorkers = Math.min(pool.maxWorkers, pool.slots.length);
      }
    }
  }

  async function saveSettings(): Promise<void> {
    if (savingSettings) return;
    savingSettings = true;
    try {
      await pools.saveSettings();
    } finally {
      savingSettings = false;
    }
  }

  async function savePool(pool: WorkerPool): Promise<void> {
    if (saving[pool.id]) return;
    saving[pool.id] = true;
    try {
      await pools.save(pool);
    } finally {
      saving[pool.id] = false;
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!poolToDelete) return;
    const target = poolToDelete;
    poolToDelete = null;
    await pools.remove(target.id);
  }
</script>

<div class="settings-general">
  <section class="settings-general-section">
    <h3 class="settings-general-heading">Worker pools</h3>
    <p class="settings-general-description">
      Named pools of parallel execution slots for auto-review. Each pool serves specified roles. Unset slot fields inherit from the role's agent config.
    </p>

    <div class="global-cap-row settings-form">
      <label>
        Max workers (global)
        <input type="number" min="1" max="20" bind:value={pools.settings.maxWorkers} />
      </label>
      <button
        type="button"
        class:primary={pools.settingsDirty}
        class:ghost={!pools.settingsDirty}
        disabled={savingSettings || !pools.settingsDirty}
        onclick={saveSettings}
      >
        {savingSettings ? "saving…" : pools.settingsDirty ? "save" : "saved"}
      </button>
    </div>

    {#if pools.pools.length === 0}
      <p class="settings-general-description">
        No worker pools configured. Tasks run serially using the implicit default slot.
      </p>
    {/if}

    {#each pools.pools as pool (pool.id)}
      <div class="pool-card settings-form">
        <div class="pool-card-header">
          <label>
            name
            <input bind:value={pool.name} placeholder="e.g. heavy" />
          </label>
          <div>
            <span class="field-label">status</span>
            <div class="seg">
              <button
                type="button"
                class="seg-option"
                class:on={pool.enabled}
                aria-pressed={pool.enabled}
                onclick={() => (pool.enabled = true)}
              >
                <span class="seg-label">enabled</span>
              </button>
              <button
                type="button"
                class="seg-option"
                class:on={!pool.enabled}
                aria-pressed={!pool.enabled}
                onclick={() => (pool.enabled = false)}
              >
                <span class="seg-label">disabled</span>
              </button>
            </div>
          </div>
        </div>

        <div class="roles-group">
          <span class="field-label">roles served</span>
          <div class="seg">
            <button
              type="button"
              class="seg-option"
              class:on={pool.roles.includes("planner")}
              aria-pressed={pool.roles.includes("planner")}
              onclick={() => toggleRole(pool, "planner")}
            >
              <span class="seg-label">planner</span>
            </button>
            <button
              type="button"
              class="seg-option"
              class:on={pool.roles.includes("reviewer")}
              aria-pressed={pool.roles.includes("reviewer")}
              onclick={() => toggleRole(pool, "reviewer")}
            >
              <span class="seg-label">reviewer</span>
            </button>
            <button
              type="button"
              class="seg-option"
              class:on={pool.roles.includes("builder")}
              aria-pressed={pool.roles.includes("builder")}
              onclick={() => toggleRole(pool, "builder")}
            >
              <span class="seg-label">builder</span>
            </button>
            <button
              type="button"
              class="seg-option"
              class:on={pool.roles.includes("plan-reviewer")}
              aria-pressed={pool.roles.includes("plan-reviewer")}
              onclick={() => toggleRole(pool, "plan-reviewer")}
            >
              <span class="seg-label">plan reviewer</span>
            </button>
            <button
              type="button"
              class="seg-option"
              class:on={pool.roles.includes("elaborator")}
              aria-pressed={pool.roles.includes("elaborator")}
              onclick={() => toggleRole(pool, "elaborator")}
            >
              <span class="seg-label">elaborator</span>
            </button>
          </div>
        </div>

        <div class="slots-group">
          <div class="slots-header">
            <span class="field-label">slots ({pool.slots.length} of 8)</span>
            <div class="slots-header-actions">
              <label class="pool-max-workers-label">
                max workers
                <input
                  type="number"
                  min="1"
                  max={pool.slots.length}
                  value={pool.maxWorkers ?? pool.slots.length}
                  onchange={(e) => {
                    const v = parseInt((e.currentTarget as HTMLInputElement).value, 10);
                    if (!isNaN(v)) {
                      pool.maxWorkers = v < pool.slots.length ? v : undefined;
                    }
                  }}
                />
              </label>
              <button
                type="button"
                class="ghost"
                disabled={pool.slots.length >= 8}
                onclick={() => addSlot(pool)}
              >
                + add slot
              </button>
            </div>
          </div>

          <!-- one header row instead of provider/model/thinking repeated on all 8 slots -->
          <div class="slot-grid">
            <div class="slot-head" aria-hidden="true">
              <span>provider</span>
              <span>model</span>
              <span>thinking</span>
              <span></span>
            </div>
            {#each pool.slots as slot, sIndex (sIndex)}
              <div class="slot-row">
                {#if pools.models.length > 0}
                  <select aria-label={`slot ${sIndex + 1} provider`} bind:value={slot.provider}>
                    <option value="">inherit role</option>
                    {#each providers as p (p)}
                      <option value={p}>{p}</option>
                    {/each}
                    {#if slot.provider && !providers.includes(slot.provider)}
                      <option value={slot.provider}>{slot.provider} · custom</option>
                    {/if}
                  </select>
                  <select
                    aria-label={`slot ${sIndex + 1} model`}
                    bind:value={slot.model}
                    onchange={(e) => {
                      const id = (e.currentTarget as HTMLSelectElement).value;
                      const hit = pools.models.find(
                        (m) => m.id === id && (!slot.provider || m.provider === slot.provider),
                      );
                      if (hit) slot.provider = hit.provider;
                    }}
                  >
                    <option value="">inherit role</option>
                    {#each getModelGroups(slot.provider ?? "") as [provider, ms] (provider)}
                      <optgroup label={provider}>
                        {#each ms as m (m.id)}
                          <option value={m.id}>{m.label}</option>
                        {/each}
                      </optgroup>
                    {/each}
                    {#if slot.model && !pools.models.some((m) => m.id === slot.model)}
                      <option value={slot.model}>{slot.model} · custom</option>
                    {/if}
                  </select>
                {:else}
                  <input aria-label={`slot ${sIndex + 1} provider`} bind:value={slot.provider} placeholder="inherit role (e.g. anthropic)" />
                  <input aria-label={`slot ${sIndex + 1} model`} bind:value={slot.model} placeholder="inherit role" />
                {/if}
                <select aria-label={`slot ${sIndex + 1} thinking`} bind:value={slot.thinking}>
                  <option value="">inherit role</option>
                  <option value="off">off</option>
                  <option value="minimal">minimal</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="xhigh">xhigh</option>
                  <option value="max">max</option>
                </select>
                {#if pool.slots.length > 1}
                  <button
                    type="button"
                    class="ghost remove-slot-btn"
                    aria-label={`remove slot ${sIndex + 1}`}
                    title="remove slot"
                    onclick={() => removeSlot(pool, sIndex)}
                  >
                    <X size={14} strokeWidth={1.75} />
                  </button>
                {:else}
                  <span></span>
                {/if}
              </div>
            {/each}
          </div>
        </div>

        <div class="pool-actions">
          <button type="button" class="ghost danger" onclick={() => (poolToDelete = pool)}>
            delete pool
          </button>
          <span class="spacer"></span>
          <button
            type="button"
            class:primary={pools.isPoolDirty(pool)}
            class:ghost={!pools.isPoolDirty(pool)}
            onclick={() => savePool(pool)}
            disabled={saving[pool.id] || !pool.name.trim() || !pools.isPoolDirty(pool)}
          >
            {saving[pool.id] ? "saving…" : pools.isPoolDirty(pool) ? "save pool" : "saved"}
          </button>
        </div>
      </div>
    {/each}

    <div class="new-pool-bar">
      <button type="button" class="ghost" onclick={addPool}>+ new pool</button>
    </div>
  </section>
</div>

{#if poolToDelete}
  <ConfirmDialog
    title="Delete pool"
    message={'Delete pool “' + (poolToDelete.name || poolToDelete.id) + '”? In-flight sessions will finish normally.'}
    onconfirm={confirmDelete}
    oncancel={() => (poolToDelete = null)}
  />
{/if}

<style>
  .pool-card {
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    margin-bottom: 16px;
    background: var(--bg-panel);
  }
  .pool-card-header {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 12px;
  }
  .pool-card-header label {
    flex: 1;
    min-width: 200px;
  }
  .field-label {
    display: block;
    margin-bottom: 6px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
  }
  .slot-grid {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .slot-head,
  .slot-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr) minmax(0, 0.9fr) 32px;
    gap: 8px;
    align-items: center;
  }
  .slot-head span {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
  }
  .remove-slot-btn {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    padding: 0;
    color: var(--text-dim);
  }
  .remove-slot-btn:hover {
    color: var(--error);
  }
  .pool-actions {
    display: flex;
    align-items: center;
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .spacer {
    flex: 1;
  }
  .new-pool-bar {
    margin-top: 16px;
    margin-bottom: 24px;
    display: flex;
    justify-content: center;
  }
  .roles-group {
    margin: 12px 0;
  }
  .slots-group {
    margin: 12px 0;
  }
  .slots-header {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .slots-header-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
  .pool-max-workers-label {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 6px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
  }
  .pool-max-workers-label input {
    width: 60px;
  }
  .global-cap-row {
    display: flex;
    flex-direction: row;
    align-items: flex-end;
    gap: 12px;
    margin-bottom: 20px;
  }
  .global-cap-row label {
    width: 150px;
  }

  @media (max-width: 640px) {
    .slot-head {
      display: none; /* labels move to each control's aria-label */
    }
    .slot-row {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 6px;
    }
    .slot-row > :nth-child(3) {
      grid-column: 1 / 2;
    }
    .remove-slot-btn {
      grid-column: 2 / 3;
      justify-self: end;
    }
  }
</style>
