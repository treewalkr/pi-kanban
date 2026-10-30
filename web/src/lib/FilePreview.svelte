<script lang="ts">
  import { files } from "./files.svelte";
  import { copyText } from "./copy";
  import { hljs, renderMarkdown } from "./markdown";
  import PathLabel from "./PathLabel.svelte";
  import { Check, Copy, X } from "@lucide/svelte";

  const preview = $derived(files.preview);

  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  async function handleCopy() {
    if (!preview) return;
    const ok = await copyText(preview.path);
    if (ok) {
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copied = false;
      }, 1500);
    }
  }

  function autofocus(node: HTMLElement) {
    node.focus();
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape") files.closePreview();
  }}
/>

{#if preview}
  <div
    class="overlay"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) files.closePreview();
    }}
  >
    <div
      class="editor preview"
      role="dialog"
      aria-modal="true"
      aria-label="file preview"
      tabindex="-1"
      use:autofocus
    >
      <div class="preview-head">
        <div class="preview-title" title={preview.path}>
          <PathLabel text={preview.path} />
        </div>
        <div class="preview-actions">
          <button
            type="button"
            class="preview-copy-btn"
            aria-label="copy path"
            title={copied ? "copied" : "copy path"}
            onclick={handleCopy}
          >
            {#if copied}
              <Check size={13} strokeWidth={2.2} />
              <span>copied</span>
            {:else}
              <Copy size={13} strokeWidth={2} />
              <span>copy path</span>
            {/if}
          </button>
          <button
            type="button"
            class="preview-close-btn"
            aria-label="close preview"
            title="close preview (Esc)"
            onclick={() => files.closePreview()}
          >
            <X size={15} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div class="preview-body">
        {#if preview.error}
          <div class="preview-error" role="alert">{preview.error}</div>
        {:else if preview.language === "markdown"}
          <div class="preview-content md">
            {@html renderMarkdown(preview.content)}
          </div>
        {:else}
          {@const guarded = hljs.getLanguage(preview.language) ? preview.language : "plaintext"}
          <pre class="preview-code md"><code class="hljs language-{guarded}">{@html hljs.highlight(preview.content, { language: guarded }).value}</code></pre>
        {/if}
      </div>
    </div>
  </div>
{/if}
