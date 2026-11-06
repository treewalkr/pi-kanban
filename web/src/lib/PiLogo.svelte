<script lang="ts">
  // pi's blocky π mark — paths from t3code's provider-pi client
  // (packages/provider-pi/src/client.ts); fill light #0F0F0F / dark #F5F5F5 → currentColor
  let { size = 15 }: { size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="165.29 165.29 469.43 469.43" fill="currentColor" aria-hidden="true">
  <path d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" fill-rule="evenodd" />
  <path d="M517.36 400H634.72V634.72H517.36Z" />
</svg>
