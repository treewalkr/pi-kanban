<script lang="ts">
  import { drag, dragGhost } from "./drag.svelte";
</script>

{#if drag.lifted}
  <div class="drag-layer" use:dragGhost></div>
{/if}
