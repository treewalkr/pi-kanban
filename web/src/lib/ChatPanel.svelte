<script lang="ts">
  import { ArrowRight, Check, ChevronDown, Lightbulb, Maximize2, Minimize2, Square, X } from "@lucide/svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { chat } from "./chat.svelte";
  import { stampTime } from "../../../src/thread";
  import ChatSelectors from "./ChatSelectors.svelte";
  import { renderMarkdown } from "./markdown";
  import type { ChatBlock } from "../../../src/chat";

  let draft = $state("");
  let logEl: HTMLElement | null = $state(null);
  let textareaEl: HTMLTextAreaElement | null = $state(null);
  /** Expanded tool cards / thinking strips, keyed `<entryId>:<blockIndex>`. */
  let expanded = new SvelteSet<string>();

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

  // full mono args for expanded cards: pretty JSON, scrolled not wrapped
  function prettyArgs(input: Record<string, unknown> | undefined): string {
    if (!input || Object.keys(input).length === 0) return "";
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  }

  // compact mono args for collapsed rows: `bash npm test` not a JSON dump
  function compactArgs(input: Record<string, unknown> | undefined): string {
    if (!input || Object.keys(input).length === 0) return "";
    const text = JSON.stringify(input);
    return text.length > 80 ? text.slice(0, 80) + "…" : text;
  }

  function toggleExpanded(key: string): void {
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
  }

  function grow(): void {
    const el = textareaEl;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  async function submit(): Promise<void> {
    const text = draft;
    if (!text.trim()) return;
    await chat.send(text);
    if (!chat.error) {
      // a refusal keeps the draft (chat.error is set)
      draft = "";
      requestAnimationFrame(grow); // let the DOM clear before re-measuring
    }
  }
</script>

<div class="chat-panel" class:expanded={chat.expanded}>
  <div class="chat-log" bind:this={logEl}>
    {#if chat.messages.length === 0 && !chat.streaming.isStreaming && chat.tools.size === 0}
      <p class="chat-empty">no messages yet — say hi or ask about this card</p>
    {/if}
    {#each chat.messages as message (message.entryId)}
      {#if message.role === "user"}
        {#if message.at !== undefined}<time class="chat-msg-time user" datetime={new Date(message.at).toISOString()} title={new Date(message.at).toLocaleString()}>{stampTime(message.at, Date.now())}</time>{/if}
        <div class="chat-msg user">{message.content}</div>
      {:else if message.role === "assistant"}
        <div class="chat-msg assistant">
          {#if message.model || message.at !== undefined}
            <div class="chat-msg-head">
              {#if message.at !== undefined}<time class="chat-msg-time" datetime={new Date(message.at).toISOString()} title={new Date(message.at).toLocaleString()}>{stampTime(message.at, Date.now())}</time>{/if}
              {#if message.model}<span class="chat-msg-model">{message.provider ? `${message.provider}/` : ""}{message.model}</span>{/if}
            </div>
          {/if}
          {#each message.blocks as block, i (i)}
            {@const key = `${message.entryId}:${i}`}
            {#if block.type === "text"}
              <div class="md">{@html renderMarkdown(block.text)}</div>
            {:else if block.type === "thinking"}
              <div class="chat-thinking" class:open={expanded.has(key)}>
                <button type="button" class="chat-thinking-head" onclick={() => toggleExpanded(key)}>
                  <Lightbulb size={12} strokeWidth={2} class="chat-thinking-icon" />
                  {#if expanded.has(key)}
                    <span class="chat-thinking-preview">thinking{block.truncated ? " (truncated)" : ""}</span>
                  {:else}
                    <span class="chat-thinking-preview">{block.thinking.slice(0, 120).replaceAll("\n", " ")}{block.truncated ? " (truncated)" : ""}</span>
                  {/if}
                </button>
                {#if expanded.has(key)}
                  <div class="chat-thinking-body">{block.thinking}</div>
                {/if}
              </div>
            {:else}
              {@const toolBlock = block as Extract<ChatBlock, { type: "toolCall" }>}
              <div class="chat-tool" class:err={message.errorMessage !== undefined} class:open={expanded.has(key)}>
                <button type="button" class="chat-tool-head" onclick={() => toggleExpanded(key)}>
                  <ChevronDown size={10} strokeWidth={2} class="chat-tool-chevron" />
                  <span class="chat-tool-name">{toolBlock.toolName}</span>
                  <span class="chat-tool-args">{compactArgs(toolBlock.input)}</span>
                </button>
                {#if expanded.has(key)}
                  <div class="chat-tool-body"><pre>{prettyArgs(toolBlock.input)}</pre></div>
                {/if}
              </div>
            {/if}
          {/each}
          {#if message.errorMessage}<div class="chat-error">{message.errorMessage}</div>{/if}
        </div>
      {:else}
        <div class="chat-tool-result" class:err={message.isError}>
          {#if message.isError}
            <X size={10} strokeWidth={2.5} />
          {:else}
            <Check size={10} strokeWidth={2.5} />
          {/if}
          {message.toolName ?? "tool"}
        </div>
      {/if}
    {/each}
    {#if chat.streaming.streamingMessage}
      <div class="chat-msg assistant streaming">
        {#each chat.streaming.streamingMessage.content as block, i (i)}
          {@const key = `streaming:${i}`}
          {#if block.type === "text"}
            <div class="md">{@html renderMarkdown(block.text)}</div>
          {:else if block.type === "thinking"}
            <div class="chat-thinking" class:open={expanded.has(key)}>
              <button type="button" class="chat-thinking-head" onclick={() => toggleExpanded(key)}>
                <Lightbulb size={12} strokeWidth={2} class="chat-thinking-icon active" />
                <span class="chat-thinking-preview">{block.thinking.slice(0, 120).replaceAll("\n", " ")}</span>
              </button>
              {#if expanded.has(key)}
                <div class="chat-thinking-body">{block.thinking}</div>
              {/if}
            </div>
          {:else}
            {@const toolBlock = block as Extract<ChatBlock, { type: "toolCall" }>}
            <div class="chat-tool" class:open={expanded.has(key)}>
              <button type="button" class="chat-tool-head" onclick={() => toggleExpanded(key)}>
                <ChevronDown size={10} strokeWidth={2} class="chat-tool-chevron" />
                <span class="chat-tool-name">{toolBlock.toolName}</span>
                <span class="chat-tool-args">{block.rawInput ?? compactArgs(toolBlock.input)}</span>
              </button>
              {#if expanded.has(key)}
                <div class="chat-tool-body"><pre>{prettyArgs(toolBlock.input)}</pre></div>
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    {/if}
    {#if chat.streaming.isStreaming && !chat.streaming.streamingMessage}
      <div class="chat-phase">thinking…</div>
    {/if}
  </div>

  <div class="chat-banners">
    {#if chat.note}<span class="chat-flag">{chat.note}</span>{/if}
    {#if chat.streaming.isStreaming}<span class="chat-flag live">streaming…</span>{/if}
    {#if chat.tools.size > 0}<span class="chat-flag">tools: {chat.tools.size}</span>{/if}
    {#if chat.queued.steering.length + chat.queued.followUp.length > 0}
      <span class="chat-flag">queued {chat.queued.steering.length + chat.queued.followUp.length}</span>
    {/if}
    {#if chat.error}<span class="chat-flag err">{chat.error}</span>{/if}
  </div>

  <div class="chat-input-zone">
    <form
      class="chat-input-box"
      onsubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        aria-label="chat message"
        placeholder={chat.streaming.isStreaming ? "steer the run… (enter sends)" : "chat with this card's agent… (enter sends, shift+enter newline)"}
        rows="1"
        bind:value={draft}
        bind:this={textareaEl}
        oninput={grow}
        onkeydown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
      ></textarea>
      {#if chat.streaming.isStreaming}
        <button type="submit" class="chat-send steer" title="interrupt and steer the run">
          steer <ArrowRight size={12} strokeWidth={2.2} />
        </button>
      {:else}
        <button type="submit" class="chat-send" class:idle={!draft.trim()} title="send">
          send <ArrowRight size={12} strokeWidth={2.2} />
        </button>
      {/if}
    </form>
    <div class="chat-input-controls">
      <ChatSelectors />
      <span class="spacer"></span>
      {#if chat.streaming.isStreaming || chat.tools.size > 0}
        <button type="button" class="chat-stop" onclick={() => chat.stop()}>
          <Square size={10} strokeWidth={2} fill="currentColor" /> stop
        </button>
      {/if}
      <button
        type="button"
        class="chat-expand"
        title={chat.expanded ? "collapse chat (esc)" : "expand chat"}
        aria-pressed={chat.expanded}
        onclick={() => chat.toggleExpanded()}
      >
        {#if chat.expanded}
          <Minimize2 size={12} strokeWidth={2} />
        {:else}
          <Maximize2 size={12} strokeWidth={2} />
        {/if}
      </button>
    </div>
  </div>
</div>

<svelte:window
  onkeydown={(e) => {
    // the first Escape leaves full view; the drawer/modal handlers check the flag
    if (e.key === "Escape" && chat.expanded) chat.expanded = false;
  }}
/>
