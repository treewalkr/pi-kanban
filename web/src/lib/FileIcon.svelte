<script lang="ts">
  import type { IconName } from "./fileIcons";

  interface Props {
    name: IconName;
    size?: number;
  }

  let { name, size = 14 }: Props = $props();
</script>

<span
  class="catppuccin-file-icon"
  style="--icon-light:url(/icons/catppuccin/latte/{name}.svg); --icon-dark:url(/icons/catppuccin/mocha/{name}.svg); width:{size}px; height:{size}px"
  aria-hidden="true"
></span>
