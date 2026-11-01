<script lang="ts">
  import { theme, setTheme } from "./theme.svelte";
  import { notify } from "./notify.svelte";
  import { api } from "../api";
  import { restartService, service } from "./service.svelte";

  let restarting = $state(false);
  let note = $state("");
  let failed = $state(false);

  // auto-archive: null days while loading; off mirrors days === 0
  let days = $state<number | null>(null);
  let archiveOff = $state(false);
  let archiveNote = $state("");
  let archiveFailed = $state(false);

  $effect(() => {
    void loadAutoArchive();
  });

  async function loadAutoArchive(): Promise<void> {
    const res = await api.autoarchive.get();
    const data = res.data as { days: number } | undefined; // treaty data narrows late — cast like board.refresh()
    if (res.error || !data) {
      archiveFailed = true;
      archiveNote = "cannot reach the API — is it running?";
      return;
    }
    archiveOff = data.days === 0;
    days = archiveOff ? null : data.days;
  }

  async function setAutoArchiveDays(n: number): Promise<void> {
    archiveFailed = false;
    archiveNote = "";
    const res = await api.autoarchive.put({ days: n });
    const data = res.data as { days: number } | undefined;
    if (res.error || !data) {
      archiveFailed = true;
      const value = res.error?.value;
      archiveNote =
        typeof value === "object" && value !== null && "error" in value && typeof value.error === "string"
          ? value.error
          : "could not save the auto-archive setting";
      return;
    }
    archiveOff = data.days === 0;
    days = archiveOff ? null : data.days;
  }

  // null while the server is down (restarting) — callers treat that as "keep waiting"
  async function restart(): Promise<void> {
    if (restarting) return;
    restarting = true;
    failed = false;
    note = "restarting — waiting for the server…";
    const result = await restartService();
    if (result.ok) {
      location.reload(); // fresh bundle, fresh SSE wiring
      return;
    }
    failed = result.failed;
    note = result.note;
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
    <h3 class="settings-general-heading">Auto-archive</h3>
    <p class="settings-general-description">Done cards move to Archive automatically once they've been done this many days. 0 disables the sweep.</p>
    <div class="settings-dev-restart">
      <input
        class="archive-days"
        type="number"
        min="1"
        max="365"
        aria-label="auto-archive days"
        placeholder={archiveOff ? "off" : ""}
        value={days ?? ""}
        onchange={(e) => {
          const n = Number((e.currentTarget as HTMLInputElement).value);
          if ((e.currentTarget as HTMLInputElement).value !== "" && Number.isInteger(n) && n >= 1 && n <= 365) {
            void setAutoArchiveDays(n);
          }
        }}
      />
      <button type="button" class="ghost" aria-label="disable auto-archive" onclick={() => setAutoArchiveDays(0)} disabled={archiveOff}>disable</button>
      {#if archiveOff}
        <span class="settings-dev-note">off — done cards stay put</span>
      {/if}
      {#if archiveNote}
        <span class="settings-dev-note" class:err={archiveFailed}>{archiveNote}</span>
      {/if}
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
      <button type="button" class="ghost" onclick={restart} disabled={restarting || service.restarting}>
        {restarting || service.restarting ? "restarting…" : "restart service"}
      </button>
      {#if note}
        <span class="settings-dev-note" class:err={failed}>{note}</span>
      {/if}
    </div>
  </section>
</div>
