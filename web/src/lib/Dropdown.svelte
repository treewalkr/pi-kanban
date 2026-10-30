<script lang="ts">
  import type { Snippet } from "svelte";

  let { open = false, onclose, children }: { open?: boolean; onclose?: () => void; children: Snippet } = $props();

  // pi-web's AnimatedDropdown, ported: stay mounted while the close transition
  // plays, then unmount; open mounts, waits two frames, then flips to visible
  const MS = 140;
  let mounted = $state(false);
  let visible = $state(false);

  $effect(() => {
    if (open) {
      mounted = true;
      visible = false;
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => (visible = true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    visible = false;
    const timer = setTimeout(() => (mounted = false), MS);
    return () => clearTimeout(timer);
  });
</script>

<svelte:window
  onmousedown={(e) => {
    if (open && !(e.target as HTMLElement).closest?.(".picker-wrap")) onclose?.();
  }}
  onkeydown={(e) => {
    if (open && e.key === "Escape") onclose?.();
  }}
/>

{#if mounted}
  <div class="dropdown" class:visible style={`transition-duration: ${MS}ms`} role="menu">
    {@render children()}
  </div>
{/if}
