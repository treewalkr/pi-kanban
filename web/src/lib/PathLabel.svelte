<script lang="ts">
  let { text }: { text: string } = $props();
</script>

<!-- pi-web's PathLabel: the rtl container moves the ellipsis to the left edge so
     the trailing (most relevant) segment stays visible; the inner plaintext bidi
     isolation keeps the text itself left-to-right. -->
<span class="path-label"><span>{text}</span></span>
