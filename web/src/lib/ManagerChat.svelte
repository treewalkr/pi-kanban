<script lang="ts">
  import { X } from "@lucide/svelte";
  import { chat } from "./chat.svelte";
  import { manager } from "./manager.svelte";
  import ChatPanel from "./ChatPanel.svelte";
</script>

<div class="manager-backdrop" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) manager.close(); }}>
  <div class="manager-drawer" class:expanded={chat.expanded} role="dialog" aria-label="board chat" tabindex="-1">
    <header class="manager-head">
      <strong class="manager-title">board chat · the manager</strong>
      <span class="manager-sub">dispatches lane workers</span>
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
