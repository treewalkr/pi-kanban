<script lang="ts">
  let {
    title,
    message,
    confirmLabel = "delete",
    onconfirm,
    oncancel,
  }: {
    title: string;
    message: string;
    confirmLabel?: string;
    onconfirm: () => void;
    oncancel: () => void;
  } = $props();

  function autofocus(node: HTMLElement) {
    node.focus();
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      oncancel();
    }
  }}
/>

<div
  class="overlay confirm"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) oncancel();
  }}
>
  <div class="confirm-panel" role="alertdialog" aria-modal="true" aria-label={title}>
    <h3>{title}</h3>
    <p>{message}</p>
    <div class="editor-actions">
      <span class="spacer"></span>
      <button class="ghost" onclick={oncancel} use:autofocus>cancel</button>
      <button class="danger" onclick={onconfirm}>{confirmLabel}</button>
    </div>
  </div>
</div>
