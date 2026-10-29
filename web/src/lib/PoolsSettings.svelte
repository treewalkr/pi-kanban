<script lang="ts">
  import type { AgentRole, AgentThinking, WorkerPool } from "../../../src/db";
  import { pools } from "./pools.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";

  let saving = $state<Record<string, boolean>>({});
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

  function toggleRole(pool: WorkerPool, role: AgentRole): void {
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
          </div>
        </div>

        <div class="slots-group">
          <div class="slots-header">
            <span class="field-label">slots ({pool.slots.length} of 8)</span>
            <button
              type="button"
              class="ghost"
              disabled={pool.slots.length >= 8}
              onclick={() => addSlot(pool)}
            >
              + add slot
            </button>
          </div>

          {#each pool.slots as slot, sIndex (sIndex)}
            {#if pools.models.length > 0}
              <div class="row slot-row">
                <label>
                  provider
                  <select bind:value={slot.provider}>
                    <option value="">inherit role</option>
                    {#each providers as p (p)}
                      <option value={p}>{p}</option>
                    {/each}
                    {#if slot.provider && !providers.includes(slot.provider)}
                      <option value={slot.provider}>{slot.provider} · custom</option>
                    {/if}
                  </select>
                </label>
                <label>
                  model
                  <select
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
                </label>
                <label>
                  thinking
                  <select bind:value={slot.thinking}>
                    <option value="">inherit role</option>
                    <option value="off">off</option>
                    <option value="minimal">minimal</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="xhigh">xhigh</option>
                    <option value="max">max</option>
                  </select>
                </label>
                {#if pool.slots.length > 1}
                  <button
                    type="button"
                    class="ghost remove-slot-btn"
                    title="remove slot"
                    onclick={() => removeSlot(pool, sIndex)}
                  >
                    ×
                  </button>
                {/if}
              </div>
            {:else}
              <div class="row slot-row">
                <label>
                  provider
                  <input bind:value={slot.provider} placeholder="inherit role (e.g. anthropic)" />
                </label>
                <label>
                  model
                  <input bind:value={slot.model} placeholder="inherit role" />
                </label>
                <label>
                  thinking
                  <select bind:value={slot.thinking}>
                    <option value="">inherit role</option>
                    <option value="off">off</option>
                    <option value="minimal">minimal</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="xhigh">xhigh</option>
                    <option value="max">max</option>
                  </select>
                </label>
                {#if pool.slots.length > 1}
                  <button
                    type="button"
                    class="ghost remove-slot-btn"
                    title="remove slot"
                    onclick={() => removeSlot(pool, sIndex)}
                  >
                    ×
                  </button>
                {/if}
              </div>
            {/if}
          {/each}
        </div>

        <div class="pool-actions">
          <button type="button" class="ghost danger" onclick={() => (poolToDelete = pool)}>
            delete pool
          </button>
          <span class="spacer"></span>
          <button
            type="button"
            class="primary"
            onclick={() => savePool(pool)}
            disabled={saving[pool.id] || !pool.name.trim()}
          >
            {saving[pool.id] ? "saving…" : "save pool"}
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
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius, 8px);
    margin-bottom: 20px;
    background: var(--bg-surface, var(--bg));
  }
  .pool-card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 14px;
  }
  .pool-card-header label {
    flex: 1;
  }
  .field-label {
    display: block;
    margin-bottom: 6px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
  }
  .slot-row {
    align-items: flex-end;
    margin-bottom: 10px;
  }
  .remove-slot-btn {
    height: 31px;
    padding: 0 10px;
    color: var(--text-dim);
    font-size: 16px;
    line-height: 1;
  }
  .remove-slot-btn:hover {
    color: var(--error, #f85149);
  }
  .pool-actions {
    display: flex;
    align-items: center;
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid var(--border-subtle, var(--border));
  }
  .spacer {
    flex: 1;
  }
  .new-pool-bar {
    margin-top: 20px;
    margin-bottom: 30px;
    display: flex;
    justify-content: center;
  }
  .roles-group {
    margin: 14px 0;
  }
  .slots-group {
    margin: 14px 0;
  }
  .slots-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
</style>
