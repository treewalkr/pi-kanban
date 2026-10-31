<script lang="ts">
  import { theme, setTheme } from "./theme.svelte";
  import { notify } from "./notify.svelte";
  import { api } from "../api";

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
      let res = await api.restart.post();
      // in-flight agent sessions: the server refuses unless forced — ask once
      const conflict = res.error?.value as { code?: string; sessions?: number } | undefined;
      if (res.error && conflict?.code === "sessions-in-flight") {
        const n = conflict.sessions ?? 0;
        if (!confirm(`${n} agent session${n === 1 ? "" : "s"} running — restarting kills ${n === 1 ? "it" : "them"}. Restart anyway?`)) {
          note = "restart cancelled — agent sessions left running";
          return;
        }
        res = await api.restart.post(null, { query: { force: "true" } });
      }
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
      note = "server didn't come back — check the serve log (build errors?).";
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

  <section class="settings-general-section">
    <h3 class="settings-general-heading">Notifications</h3>
    <p class="settings-general-description">Desktop notification when a card enters Review. Fires only while this tab is in the background — a visible board is its own signal.</p>
    <div class="settings-dev-restart">
      {#if notify.permission() === "unsupported"}
        <span class="settings-dev-note">not supported in this browser</span>
      {:else if notify.permission() === "denied"}
        <span class="settings-dev-note">blocked — allow notifications for this site in your browser settings</span>
      {:else if notify.enabled}
        <span class="settings-dev-note">on — you'll be notified while this tab is in the background</span>
        <button type="button" class="ghost" onclick={() => notify.disable()}>disable</button>
      {:else}
        <button type="button" class="ghost" onclick={() => notify.enable()}>enable notifications</button>
      {/if}
    </div>
  </section>

  <section class="settings-general-section">
    <h3 class="settings-general-heading">Service</h3>
    <p class="settings-general-description">
      Rebuild the web bundle (<code>bun run build</code>) and restart the server — handy after
      code changes land, e.g. when tasks go done. The board reconnects automatically once the
      server is back. Local pages only; remote sites cannot trigger it.
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
</div>
