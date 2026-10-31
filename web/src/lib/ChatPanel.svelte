<script lang="ts">
  import { chat } from "./chat.svelte";
  import { renderMarkdown } from "./markdown";

  let draft = $state("");
  let logEl: HTMLElement | null = $state(null);

  // follow the tail as history, streamed text, and tool rows grow
  $effect(() => {
    void chat.messages.length;
    void chat.streaming.streamingMessage;
    void chat.tools.size;
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  });

  // the card modal remounts per card ({#key board.editing.id} in App.svelte) —
  // unmounting closes the EventSource and resets the store
  $effect(() => () => chat.close());

  // compact mono args for activity rows: `→ bash npm test` not a JSON dump
  function compactArgs(input: Record<string, unknown> | undefined): string {
    if (!input || Object.keys(input).length === 0) return "";
    const text = JSON.stringify(input);
    return text.length > 80 ? text.slice(0, 80) + "…" : text;
  }

  async function submit(): Promise<void> {
    const text = draft;
    if (!text.trim()) return;
    await chat.send(text);
    if (!chat.error) draft = ""; // a refusal keeps the draft (chat.error is set)
  }
</script>

<div class="chat-panel">
  <div class="chat-log" bind:this={logEl}>
    {#if chat.messages.length === 0 && !chat.streaming.isStreaming && chat.tools.size === 0}
      <p class="chat-empty">no messages yet — say hi or ask about this card</p>
    {/if}
    {#each chat.messages as message (message.entryId)}
      {#if message.role === "user"}
        <div class="chat-msg user">{message.content}</div>
      {:else if message.role === "assistant"}
        <div class="chat-msg assistant">
          {#each message.blocks as block, i (i)}
            {#if block.type === "text"}
              <div class="md">{@html renderMarkdown(block.text)}</div>
            {:else if block.type === "thinking"}
              <details class="chat-thinking">
                <summary>◉ thinking{block.truncated ? " (truncated)" : ""}</summary>
                <div class="chat-thinking-body">{block.thinking}</div>
              </details>
            {:else}
              <div class="chat-tool">→ {block.toolName} <span class="args">{compactArgs(block.input)}</span></div>
            {/if}
          {/each}
          {#if message.errorMessage}<div class="chat-tool err">✗ {message.errorMessage}</div>{/if}
        </div>
      {:else}
        <div class="chat-tool" class:err={message.isError}>{message.isError ? "✗" : "✓"} {message.toolName ?? "tool"}</div>
      {/if}
    {/each}
    {#if chat.streaming.streamingMessage}
      <div class="chat-msg assistant streaming">
        {#each chat.streaming.streamingMessage.content as block, i (i)}
          {#if block.type === "text"}
            <div class="md">{@html renderMarkdown(block.text)}</div>
          {:else if block.type === "thinking"}
            <details class="chat-thinking">
              <summary>◉ thinking</summary>
              <div class="chat-thinking-body">{block.thinking}</div>
            </details>
          {:else}
            <div class="chat-tool">→ {block.toolName} <span class="args">{block.rawInput ?? compactArgs(block.input)}</span></div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
  <div class="chat-status">
    <span class="chat-model">{chat.modelLabel || "idle"}</span>
    {#if chat.streaming.isStreaming}<span class="chat-flag live">streaming…</span>{/if}
    {#if chat.tools.size > 0}<span class="chat-flag">tools: {chat.tools.size}</span>{/if}
    {#if chat.queued.steering.length + chat.queued.followUp.length > 0}
      <span class="chat-flag">queued {chat.queued.steering.length + chat.queued.followUp.length}</span>
    {/if}
    {#if chat.note}<span class="chat-flag">{chat.note}</span>{/if}
    {#if chat.error}<span class="chat-flag err">{chat.error}</span>{/if}
    <span class="spacer"></span>
    {#if chat.streaming.isStreaming || chat.tools.size > 0}
      <button class="ghost chat-stop" onclick={() => chat.stop()}>stop</button>
    {/if}
  </div>
  <form
    class="chat-composer"
    onsubmit={(e) => {
      e.preventDefault();
      void submit();
    }}
  >
    <textarea
      aria-label="chat message"
      placeholder="chat with this card's agent… (enter sends, shift+enter newline)"
      rows="2"
      bind:value={draft}
      onkeydown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          void submit();
        }
      }}
    ></textarea>
  </form>
</div>
