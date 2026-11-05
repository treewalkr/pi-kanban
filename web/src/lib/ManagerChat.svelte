<script lang="ts">
  import { Check, X } from "@lucide/svelte";
  import { chat } from "./chat.svelte";
  import { manager } from "./manager.svelte";
  import { projects } from "./projects.svelte";
  import ChatPanel from "./ChatPanel.svelte";
  import Dropdown from "./Dropdown.svelte";

  let menu = $state(false);

  function pick(scope: string | null): void {
    menu = false;
    void manager.switchTo(scope);
  }
</script>

<div class="manager-backdrop" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) manager.close(); }}>
  <div class="manager-drawer" class:expanded={chat.expanded} role="dialog" aria-label="board chat" tabindex="-1">
    <header class="manager-head">
      <strong class="manager-title">board chat · the manager</strong>
      {#if manager.project}
        <span class="manager-project">{manager.project}</span>
      {/if}
      <span class="manager-sub">dispatches lane workers</span>
      <div class="picker-wrap manager-new-wrap">
        <button
          type="button"
          class="manager-new"
          aria-label="new board chat session"
          aria-haspopup="menu"
          aria-expanded={menu}
          onclick={() => (menu = !menu)}
        >
          + new session
        </button>
        <Dropdown open={menu} onclose={() => (menu = false)}>
          <div class="picker-list">
            <button
              type="button"
              class="picker-row"
              role="menuitemradio"
              aria-checked={manager.project === null}
              onclick={() => pick(null)}
            >
              {#if manager.project === null}
                <span class="check"><Check size={10} strokeWidth={2.4} /></span>
              {:else}
                <span class="check-spacer"></span>
              {/if}
              none (whole board)
            </button>
            {#each projects.projects as p (p.name)}
              <button
                type="button"
                class="picker-row"
                role="menuitemradio"
                aria-checked={manager.project === p.name}
                onclick={() => pick(p.name)}
              >
                {#if manager.project === p.name}
                  <span class="check"><Check size={10} strokeWidth={2.4} /></span>
                {:else}
                  <span class="check-spacer"></span>
                {/if}
                {p.name}
              </button>
            {/each}
          </div>
        </Dropdown>
      </div>
      <button type="button" class="manager-x" aria-label="close board chat" onclick={() => manager.close()}>
        <X size={16} strokeWidth={1.8} />
      </button>
    </header>
    <div class="manager-body">
      <ChatPanel />
    </div>
  </div>
</div>

<svelte:window onkeydown={(e) => { if (e.key === "Escape") { if (chat.expanded) chat.expanded = false; else manager.close(); } }} />
