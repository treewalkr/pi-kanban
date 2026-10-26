<script lang="ts">
  import { theme, setTheme } from "./theme.svelte";
  import { api } from "../api";

  const devMode = import.meta.env.DEV;

  let restarting = $state(false);
  let note = $state("");
  let failed = $state(false);

  // null while the server is down (restarting) — callers treat that as "keep waiting"
  async function healthBooted(): Promise<number | null> {
    try {
      const res = await api.health.get();
      return typeof res.data?.booted === "number" ? res.data.booted : null;
    } catch {
      return null;
    }
  }

  async function restartService(): Promise<void> {
    if (restarting) return;
    restarting = true;
    failed = false;
    note = "restarting — waiting for the server…";
    try {
      const before = (await healthBooted()) ?? 0;
      const res = await api.dev.restart.post();
      if (res.error) {
        failed = true;
        const value = res.error.value;
        note =
          typeof value === "object" && value !== null && "error" in value && typeof value.error === "string"
            ? value.error
            : "restart unavailable";
        return;
      }
      // vite build can take a while; poll until a server with a newer boot stamp answers
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const booted = await healthBooted();
        if (booted !== null && booted > before) {
          location.reload(); // fresh bundle, fresh SSE wiring
          return;
        }
      }
      failed = true;
      note = "server didn't come back — check the dev terminal (build errors?).";
    } catch {
      failed = true;
      note = "cannot reach the API — is it running?";
    } finally {
      restarting = false;
    }
  }
</script>

<div class="settings-general">
  <section class="settings-general-section">
    <h3 class="settings-general-heading">Appearance</h3>
    <p class="settings-general-description">Color scheme for the board. Applies immediately and is remembered by the browser.</p>
    <div class="seg" role="radiogroup" aria-label="theme">
      <label class="seg-option">
        <input class="sr-only" type="radio" name="theme" value="dark" bind:group={theme.name} onchange={() => setTheme("dark")} />
        <span class="seg-label">dark</span>
      </label>
      <label class="seg-option">
        <input class="sr-only" type="radio" name="theme" value="light" bind:group={theme.name} onchange={() => setTheme("light")} />
        <span class="seg-label">light</span>
      </label>
    </div>
  </section>

  {#if devMode}
    <section class="settings-general-section">
      <h3 class="settings-general-heading">Development</h3>
      <p class="settings-general-description">
        Rebuild the web bundle (<code>bun run build</code>) and reload the dev API — handy after
        code changes land, e.g. when tasks go done. The board reconnects automatically once the
        server is back. Needs the API started via <code>bun run dev:api</code>.
      </p>
      <div class="settings-dev-restart">
        <button type="button" class="ghost" onclick={restartService} disabled={restarting}>
          {restarting ? "restarting…" : "restart service"}
        </button>
        {#if note}
          <span class="settings-dev-note" class:err={failed}>{note}</span>
        {/if}
      </div>
    </section>
  {/if}
</div>
