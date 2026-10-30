<script lang="ts">
  import { scrambleFrame, scrambleFrameCount, VERSION_SHOWN_MS } from "./scramble";
  import Mark from "./Mark.svelte";

  const BRAND = "kanban";
  // __APP_VERSION__ is vite's define of the root package.json version.
  const VERSION = `v${__APP_VERSION__}`;

  let versionShown = $state(false);
  let text = $state(BRAND);
  let shown = BRAND; // the target `text` currently reflects (plain, untracked)
  let revertTimer: ReturnType<typeof setTimeout> | undefined;

  // `target`, scrambled into place whenever it changes (never on mount):
  // one frame at a time until every character has settled. Under
  // prefers-reduced-motion the text is swapped at once.
  $effect(() => {
    const target = versionShown ? VERSION : BRAND;
    if (shown === target) return;
    shown = target;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      text = target;
      return;
    }
    const total = scrambleFrameCount(target);
    let frame = 0;
    let request = 0;
    const step = () => {
      frame += 1;
      text = scrambleFrame(target, frame);
      if (frame < total) request = requestAnimationFrame(step);
    };
    // The new text at once, so the row is fitted to it before it paints.
    text = scrambleFrame(target, 0);
    request = requestAnimationFrame(step);
    return () => cancelAnimationFrame(request);
  });

  $effect(() => () => {
    if (revertTimer !== undefined) clearTimeout(revertTimer);
  });

  function click(): void {
    if (revertTimer !== undefined) {
      clearTimeout(revertTimer);
      revertTimer = undefined;
    }
    if (versionShown) {
      versionShown = false;
      return;
    }
    versionShown = true;
    revertTimer = setTimeout(() => {
      revertTimer = undefined;
      versionShown = false;
    }, VERSION_SHOWN_MS);
  }
</script>

<!-- The name says what the click shows, so the versions need no click (and
     no scrambled text is ever read out: the label stays the same). -->
<button
  type="button"
  class="sidebar-brand"
  class:is-version={versionShown}
  aria-label={`kanban, version ${__APP_VERSION__}`}
  onclick={click}
>
  <Mark />
  <span class="brand-text">{text}</span>
</button>
