<script lang="ts">
  import { copyText } from "./copy";

  let { id }: { id: string } = $props();

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function copy(e: MouseEvent): Promise<void> {
    e.stopPropagation();
    if (await copyText(id)) {
      copied = true;
      clearTimeout(timer);
      timer = setTimeout(() => (copied = false), 1200);
    }
  }
</script>

<button
  class="id id-copy"
  class:copied
  title="copy id"
  draggable="false"
  onclick={copy}
  onkeydown={(e) => e.stopPropagation()}
>
  {#if copied}✓ copied{:else}{id}{/if}
</button>
