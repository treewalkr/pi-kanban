<script lang="ts">
  import { copyText } from "./copy";

  let { id }: { id: string } = $props();

  let copied = $state(false);
  let failed = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function copy(e: MouseEvent): Promise<void> {
    e.stopPropagation();
    const ok = await copyText(id);
    copied = ok;
    failed = !ok;
    clearTimeout(timer);
    timer = setTimeout(() => {
      copied = false;
      failed = false;
    }, 1200);
  }
</script>

<button
  class="id id-copy"
  class:copied
  class:failed
  title="copy id"
  draggable="false"
  onclick={copy}
  onkeydown={(e) => e.stopPropagation()}
>
  {#if copied}✓ copied{:else if failed}✗ copy failed{:else}{id}{/if}
</button>
