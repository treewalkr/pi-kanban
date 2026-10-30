<script lang="ts">
  import { files } from "./files.svelte";
  import { copyText } from "./copy";
  import { hljs, renderMarkdown } from "./markdown";
  import {
    collapseDiff,
    escapeHtml,
    formatSize,
    isImagePath,
    parseUnifiedDiff,
    splitHighlightedLines,
  } from "./fileview";
  import { Check, Copy, Download, WrapText, X } from "@lucide/svelte";

  const preview = $derived(files.preview);

  type Mode = "source" | "preview" | "diff";
  let userMode = $state<Mode | null>(null);
  let wrapLines = $state(false);
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  // Reset user mode when path changes
  let currentPath = $state<string | null>(null);
  $effect(() => {
    if (preview?.path !== currentPath) {
      currentPath = preview?.path ?? null;
      userMode = null;
    }
  });

  const availableModes = $derived.by<Mode[]>(() => {
    if (!preview || preview.error || preview.binary || isImagePath(preview.path)) return [];
    const modes: Mode[] = ["source"];
    if (preview.language === "markdown") modes.push("preview");
    if (files.diff?.supported) modes.push("diff");
    return modes;
  });

  const defaultMode = $derived.by<Mode>(() => {
    if (files.previewModeHint === "diff" && files.diff?.supported) return "diff";
    if (preview?.language === "markdown" && !preview.error) return "preview";
    return "source";
  });

  const effectiveMode = $derived.by<Mode>(() => {
    const chosen = userMode ?? defaultMode;
    if (chosen === "diff" && !files.diff?.supported) return "source";
    if (chosen === "preview" && preview?.language !== "markdown") return "source";
    return chosen;
  });

  const isImg = $derived(preview ? isImagePath(preview.path) : false);
  const ext = $derived(preview ? (preview.path.split(".").pop()?.toLowerCase() ?? "") : "");
  const lineCount = $derived(preview ? preview.content.split("\n").length : 0);

  const metaText = $derived.by(() => {
    if (!preview) return "";
    if (isImg || preview.binary) {
      return `${ext || "binary"} · ${formatSize(preview.size)}`;
    }
    return `${preview.language} · ${lineCount} lines · ${formatSize(preview.size)}`;
  });

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
      <div class="viewer-toolbar">
        <span class="viewer-path" title={preview.path}>{preview.path}</span>
        {#if !preview.error}
          <span class="viewer-meta" title={metaText}>{metaText}</span>
        {/if}

        <div class="viewer-controls">
          {#if availableModes.length > 1}
            <div class="viewer-mode-switch" role="group" aria-label="file view mode">
              {#if availableModes.includes("source")}
                <button
                  type="button"
                  class="viewer-mode-btn"
                  aria-pressed={effectiveMode === "source"}
                  onclick={() => (userMode = "source")}
                >Source</button>
              {/if}
              {#if availableModes.includes("preview")}
                <button
                  type="button"
                  class="viewer-mode-btn"
                  aria-pressed={effectiveMode === "preview"}
                  onclick={() => (userMode = "preview")}
                >Preview</button>
              {/if}
              {#if availableModes.includes("diff")}
                <button
                  type="button"
                  class="viewer-mode-btn"
                  aria-pressed={effectiveMode === "diff"}
                  onclick={() => (userMode = "diff")}
                >Diff</button>
              {/if}
            </div>
          {/if}

          {#if effectiveMode === "source" && !preview.error && !preview.binary && !isImg}
            <button
              type="button"
              class="viewer-icon-btn"
              aria-label="toggle line wrap"
              aria-pressed={wrapLines}
              title={wrapLines ? "disable line wrap" : "enable line wrap"}
              onclick={() => (wrapLines = !wrapLines)}
            >
              <WrapText size={13} strokeWidth={2} />
            </button>
          {/if}

          <button
            type="button"
            class="viewer-icon-btn"
            aria-label="copy path"
            title={copied ? "copied" : "copy path"}
            onclick={handleCopy}
          >
            {#if copied}
              <Check size={13} strokeWidth={2.2} />
            {:else}
              <Copy size={13} strokeWidth={2} />
            {/if}
          </button>

          <a
            class="viewer-icon-btn"
            aria-label="download file"
            title="download file"
            href="/files/raw?path={encodeURIComponent(preview.path)}&download=1"
            download
          >
            <Download size={13} strokeWidth={2} />
          </a>

          <button
            type="button"
            class="viewer-icon-btn"
            aria-label="close preview"
            title="close preview (Esc)"
            onclick={() => files.closePreview()}
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div class="viewer-body">
        {#if preview.error}
          <div class="viewer-error" role="alert">{preview.error}</div>
        {:else if isImg}
          <div class="viewer-image-container">
            <img
              class="viewer-image"
              src="/files/raw?path={encodeURIComponent(preview.path)}"
              alt={preview.path}
            />
          </div>
        {:else if preview.binary}
          <div class="viewer-binary-fallback">
            <p>binary file — no preview</p>
            <a href="/files/raw?path={encodeURIComponent(preview.path)}&download=1" download>download</a>
          </div>
        {:else if effectiveMode === "preview"}
          <div class="viewer-markdown md">
            {@html renderMarkdown(preview.content)}
          </div>
        {:else if effectiveMode === "diff" && files.diff?.supported && files.diff.patch}
          {@const diffLines = parseUnifiedDiff(files.diff.patch)}
          {@const segments = collapseDiff(diffLines, 3)}
          <div class="viewer-diff-lines">
            {#each segments as seg}
              {#if seg.kind === "gap"}
                <div class="viewer-diff-gap">⋯ {seg.count} unchanged lines</div>
              {:else}
                {#each seg.lines as dLine}
                  <div class="viewer-diff-line {dLine.kind}">
                    <span class="viewer-line-num">
                      {dLine.kind === "del" ? (dLine.oldNo ?? "") : (dLine.newNo ?? "")}
                    </span>
                    <span class="viewer-diff-prefix">
                      {dLine.kind === "add" ? "+" : dLine.kind === "del" ? "−" : " "}
                    </span>
                    <span class="viewer-line-code">{dLine.text}</span>
                  </div>
                {/each}
              {/if}
            {/each}
          </div>
        {:else}
          {@const guarded = hljs.getLanguage(preview.language) ? preview.language : "plaintext"}
          {@const lines = lineCount > 1000
            ? preview.content.split("\n").map(escapeHtml)
            : splitHighlightedLines(hljs.highlight(preview.content, { language: guarded }).value)}
          <div class="viewer-source-lines" class:wrap={wrapLines}>
            {#each lines as line, idx}
              <div class="viewer-line">
                <span class="viewer-line-num">{idx + 1}</span>
                <span class="viewer-line-code">{@html line}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
