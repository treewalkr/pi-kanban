<script lang="ts">
  /**
   * The rail's "+ Add provider" popup (t3code's add-provider dialog, kanban
   * scale): LLM vendors run as pi backends and auth belongs to pi, so the
   * dialog is an onboarding surface — every not-yet-signed-in catalog provider
   * with its exact login command, plus the already-added ones with a check.
   */
  import { Check, Copy, Plus } from "@lucide/svelte";
  import PiLogo from "./PiLogo.svelte";
  import { backendHint, type HarnessView } from "./harnesses.svelte";

  let {
    view,
    onclose,
  }: {
    /** The pi harness view — its backends are the vendor list. */
    view: HarnessView;
    onclose: () => void;
  } = $props();

  const available = $derived(view.backends.filter((b) => b.status === "unsigned"));
  const added = $derived(view.backends.filter((b) => b.status !== "unsigned"));

  let copied = $state<string | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  function copyCommand(id: string): void {
    void navigator.clipboard?.writeText(`/login ${id}`).then(() => {
      copied = id;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = null), 1500);
    });
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") onclose();
  }

  function autofocus(node: HTMLElement) {
    node.focus();
  }

  $effect(() => {
    document.addEventListener("keydown", onKeydown);
    return () => {
      document.removeEventListener("keydown", onKeydown);
      clearTimeout(copyTimer);
    };
  });
</script>

<div
  class="overlay add-provider"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div class="add-provider-panel" role="dialog" aria-modal="true" aria-label="Add a provider" use:autofocus tabindex="-1">
    <header class="add-provider-head">
      <span class="provider-logo" aria-hidden="true"><PiLogo size={16} /></span>
      <div class="add-provider-head-text">
        <h3>Add a provider</h3>
        <p>LLM vendors run as pi backends — sign in with pi and they appear here on the next refresh.</p>
      </div>
    </header>

    {#if available.length > 0}
      <div class="add-provider-label">available</div>
      <ul class="add-provider-list">
        {#each available as b (b.id)}
          <li class="add-provider-row">
            <span class="add-provider-id" title={b.id}>{b.id}</span>
            <span class="add-provider-count">{b.models.length} model{b.models.length === 1 ? "" : "s"}</span>
            <span class="add-provider-hint">
              {#each backendHint(b) ?? [] as seg, i (i)}{#if seg.code}<code>{seg.text}</code>{:else}{seg.text}{/if}{/each}
            </span>
            <button
              type="button"
              class="ghost add-provider-copy"
              aria-label={copied === b.id ? "command copied" : `copy the login command for ${b.id}`}
              title={copied === b.id ? "copied" : "copy the login command"}
              onclick={() => copyCommand(b.id)}
            >
              {#if copied === b.id}<Check size={12} strokeWidth={2.4} />{:else}<Copy size={12} strokeWidth={2} />{/if}
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="add-provider-empty">Every catalog provider is already signed in.</p>
    {/if}

    {#if added.length > 0}
      <div class="add-provider-label">already added</div>
      <ul class="add-provider-list">
        {#each added as b (b.id)}
          <li class="add-provider-row added" aria-label={`${b.id} signed in`}>
            <span class="add-provider-id" title={b.id}>{b.id}</span>
            <span class="add-provider-count">{b.models.length} model{b.models.length === 1 ? "" : "s"}</span>
            <span class="add-provider-check"><Check size={13} strokeWidth={2.2} /></span>
          </li>
        {/each}
      </ul>
    {/if}

    <footer class="add-provider-foot">
      <span class="spacer"></span>
      <button class="ghost" onclick={onclose}>
        <Plus size={12} strokeWidth={2} aria-hidden="true" style="transform: rotate(45deg)" />
        close
      </button>
    </footer>
  </div>
</div>

<style>
  .add-provider-panel {
    display: flex;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-panel);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
    flex-direction: column;
    gap: 10px;
    width: min(480px, calc(100vw - 48px));
    max-height: min(520px, calc(100vh - 96px));
    padding: 16px;
    overflow-y: auto;
  }

  .add-provider-head {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .add-provider-head-text {
    min-width: 0;
  }

  .add-provider-head h3 {
    margin: 0 0 2px;
    color: var(--text);
    font-size: 13px;
    font-weight: 600;
  }

  .add-provider-head p {
    margin: 0;
    color: var(--text-dim);
    font-size: 11.5px;
    line-height: 1.5;
  }

  .add-provider-label {
    margin-top: 2px;
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .add-provider-list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .add-provider-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 2px;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
  }

  .add-provider-row:last-child {
    border-bottom: 0;
  }

  .add-provider-id {
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
  }

  .add-provider-count {
    flex: none;
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 10px;
  }

  .add-provider-hint {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--text-dim);
    font-size: 11px;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .add-provider-hint code {
    color: var(--text-muted);
  }

  .add-provider-copy {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
  }

  .add-provider-row.added .add-provider-id {
    color: var(--text-muted);
  }

  .add-provider-check {
    display: flex;
    flex: none;
    align-items: center;
    margin-left: auto;
    color: var(--ok);
  }

  .add-provider-empty {
    margin: 0;
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.5;
  }

  .add-provider-foot {
    display: flex;
    align-items: center;
    margin-top: 2px;
  }

</style>
