<script lang="ts">
  import type { AgentConfig, ProjectRoute } from "../../../src/db";
  import type { DirListing } from "../../../src/files";
  import { projectNameFromPath } from "./projectPicker";
  import { normCmd, projects } from "./projects.svelte";
  import { board } from "./board.svelte";
  import { agents } from "./agents.svelte";
  import { engines, engineSummary } from "./engines.svelte";
  import SkillPicker from "./SkillPicker.svelte";

  const BOARD_ACTORS = ["elaborator", "manager", "worker"] as const;

  let saving = $state<Record<string, boolean>>({});
  let pickerOpen = $state(false);
  let listing = $state<DirListing | null>(null);
  let loadingDirs = $state(false);
  let creating = $state(false);
  let pickerName = $state("");

  async function save(route: ProjectRoute): Promise<void> {
    if (saving[route.name]) return;
    saving[route.name] = true;
    try {
      const repoPath = route.repoPath && route.repoPath.trim() !== "" ? route.repoPath.trim() : null;
      const testCmd = normCmd(route.testCmd);
      if (await projects.save({ name: route.name, repoPath, testGate: route.testGate, testCmd })) {
        route.repoPath = repoPath; // the server normalized the draft — reflect it
        route.testCmd = testCmd;
      }
    } finally {
      saving[route.name] = false;
    }
  }

  async function browse(dirPath = ""): Promise<void> {
    loadingDirs = true;
    try {
      const nextListing = await projects.listDirs(dirPath);
      if (nextListing) {
        listing = nextListing;
        pickerName = projectNameFromPath(nextListing.path);
      }
    } finally {
      loadingDirs = false;
    }
  }

  async function openPicker(): Promise<void> {
    pickerOpen = true;
    await browse("");
  }

  function closePicker(): void {
    pickerOpen = false;
    listing = null;
    pickerName = "";
  }

  async function createFromPicker(): Promise<void> {
    if (!listing || !pickerName.trim() || creating) return;
    creating = true;
    try {
      const ok = await projects.save({
        name: pickerName.trim(),
        repoPath: listing.path,
        testGate: true,
      });
      if (ok) {
        closePicker();
      }
    } finally {
      creating = false;
    }
  }

  // ---- per-project override editor (one open at a time; unsaved edits discard on toggle/actor switch) ----

  interface OverrideForm {
    /** The engine lineup replacing the actor's own, in preference order (empty = inherit). */
    runsOn: string[];
    skills: string[];
    timeoutMin: string;
  }

  let openName = $state<string | null>(null);
  let actor = $state("");
  let form = $state<OverrideForm>({ runsOn: [], skills: [], timeoutMin: "" });
  /** The picker's load value: a save sends `skills` iff the stored override has a key or the picker moved off this. */
  let initialSkills = $state<string[]>([]);
  let savingActor = $state(false);

  let workflowLanes = $derived(board.lanes.filter((l) => l.id !== "waiting" && l.id !== "done" && l.id !== "archive"));

  /** One group per workflow lane whose context has actors (first lane wins duplicates), then the board roles. */
  let actorGroups = $derived.by(() => {
    const seen = new Set<string>();
    const groups: Array<{ lane: string; actors: string[] }> = [];
    for (const lane of workflowLanes) {
      const actors: string[] = [];
      for (const a of board.laneContexts[lane.id]?.actors ?? []) {
        if (!seen.has(a.id)) {
          seen.add(a.id);
          actors.push(a.id);
        }
      }
      if (actors.length > 0) groups.push({ lane: lane.name, actors });
    }
    return groups;
  });
  let firstActor = $derived(actorGroups[0]?.actors[0] ?? BOARD_ACTORS[0]);
  let savedEngines = $derived(engines.engines.filter((e) => !engines.isDraft(e.id)));
  let addableEngines = $derived(savedEngines.filter((e) => !form.runsOn.includes(e.id)));
  const engineName = (id: string) => engines.engines.find((e) => e.id === id)?.name ?? id;

  function loadForm(): void {
    const stored = projects.overrides[openName ?? ""]?.[actor] ?? {};
    form = {
      runsOn: (stored.runsOn ?? []).slice(),
      skills: (stored.skills ?? []).slice(),
      timeoutMin: stored.timeoutMs ? String(Math.round(stored.timeoutMs / 60_000)) : "",
    };
    initialSkills = (stored.skills ?? []).slice();
  }

  async function toggleOverrides(name: string): Promise<void> {
    if (openName === name) {
      openName = null;
      return;
    }
    openName = name;
    actor = "";
    form = { runsOn: [], skills: [], timeoutMin: "" };
    initialSkills = [];
    // lineup choices and the skill catalog, only when not already loaded (read-only use of those stores)
    if (!engines.loaded) void engines.load();
    if (!agents.loaded) void agents.load();
    await projects.loadAgents(name);
    if (openName !== name) return; // closed (or switched to another row) while loading
    if (actor === "") actor = firstActor; // a selection made while loading stands
    loadForm();
  }

  function moveEngine(i: number, delta: -1 | 1): void {
    const j = i + delta;
    if (j < 0 || j >= form.runsOn.length) return;
    const next = form.runsOn.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    form.runsOn = next;
  }

  function removeEngine(i: number): void {
    form.runsOn = form.runsOn.filter((_, k) => k !== i);
  }

  function addEngine(id: string): void {
    if (!id || form.runsOn.includes(id)) return;
    form.runsOn = [...form.runsOn, id];
  }

  /** The server full-replaces the override, so behavior fields without editor fields are carried from the stored config. */
  async function saveOverride(name: string): Promise<void> {
    if (savingActor) return;
    const stored = projects.overrides[name]?.[actor] ?? {};
    const cfg: AgentConfig = {};
    if (stored.context !== undefined) cfg.context = stored.context;
    if (stored.tools !== undefined) cfg.tools = stored.tools;
    if (stored.extraArgs !== undefined) cfg.extraArgs = stored.extraArgs.slice();
    cfg.runsOn = form.runsOn.slice();
    const t = form.timeoutMin.trim();
    if (t !== "") {
      const min = Number(t);
      if (!Number.isInteger(min) || min < 1 || min > 1440) {
        board.error = "timeout must be 1 to 1440 minutes";
        return;
      }
      cfg.timeoutMs = min * 60_000;
    }
    const skillsChanged = form.skills.length !== initialSkills.length || form.skills.some((s, i) => s !== initialSkills[i]);
    if (stored.skills !== undefined || skillsChanged) cfg.skills = form.skills.slice();
    savingActor = true;
    try {
      if (await projects.saveActor(name, actor, cfg)) loadForm();
    } finally {
      savingActor = false;
    }
  }

  async function clearOverride(name: string): Promise<void> {
    if (savingActor) return;
    savingActor = true;
    try {
      if (await projects.clearActor(name, actor)) loadForm();
    } finally {
      savingActor = false;
    }
  }
</script>

<div class="settings-general">
  <section class="settings-general-section">
    <div class="projects-header-row">
      <h3 class="settings-general-heading">Projects</h3>
      <button type="button" class="ghost" aria-label="add project" onclick={openPicker}>Add project</button>
    </div>
    <p class="settings-general-description">
      Route each project tag to the repo its cards' agents work in. An empty repo path falls back to the directory the board is served from. The test gate runs the project's test command (default <code>bun test</code>) in the routed repo before a card is reviewed.
    </p>

    {#if pickerOpen}
      <div class="project-picker settings-form">
        <div class="picker-path-bar">
          <button
            type="button"
            class="ghost"
            aria-label="parent directory"
            disabled={!listing || listing.parent === null || loadingDirs}
            onclick={() => listing?.parent && browse(listing.parent)}
          >
            ↑ up
          </button>
          <code class="picker-current-path" aria-label="current directory">{listing?.path ?? "…"}</code>
          {#if listing?.isGitRepo}
            <span class="picker-git-badge">.git</span>
          {/if}
        </div>

        <div class="picker-dirs">
          {#if listing}
            {#if listing.dirs.length === 0}
              <div class="picker-empty">No subdirectories</div>
            {:else}
              {#each listing.dirs as dir (dir.path)}
                <button
                  type="button"
                  class="picker-dir-row"
                  aria-label={`open directory ${dir.name}`}
                  onclick={() => browse(dir.path)}
                >
                  <span class="picker-dir-name">{dir.name}</span>
                  {#if dir.isGitRepo}
                    <span class="picker-git-badge">.git</span>
                  {/if}
                </button>
              {/each}
            {/if}
          {:else if loadingDirs}
            <div class="picker-empty">Loading…</div>
          {/if}
        </div>

        <div class="picker-footer">
          <label class="picker-name-field">
            project name
            <input aria-label="new project name" bind:value={pickerName} placeholder="project name" />
          </label>
          <button type="button" class="ghost" onclick={closePicker}>cancel</button>
          <button
            type="button"
            class="primary"
            aria-label="create project"
            disabled={creating || !listing || !pickerName.trim()}
            onclick={createFromPicker}
          >
            {creating ? "adding…" : "Use this directory"}
          </button>
        </div>
      </div>
    {/if}

    {#if projects.projects.length === 0}
      <p class="settings-general-description">No projects yet — tags appear here as cards use them.</p>
    {/if}

    {#each projects.projects as route (route.name)}
      <div class="project-row">
        <span class="project-name" title={route.name}>{route.name}</span>
        <label class="project-repo">
          repo path
          <input aria-label={`repo path ${route.name}`} bind:value={route.repoPath} title={route.repoPath ?? ""} placeholder="serve directory (fallback)" />
          {#if !route.repoPath}
            <span class="fallback-hint">fallback</span>
          {/if}
        </label>
        <label class="project-cmd">
          test command
          <input
            aria-label={`test command ${route.name}`}
            bind:value={route.testCmd}
            placeholder="bun test --timeout 30000"
            maxlength={500}
            title={route.testCmd ?? ""}
          />
        </label>
        <label class="project-gate">
          <input type="checkbox" aria-label={`test gate ${route.name}`} bind:checked={route.testGate} />
          test gate
        </label>
        <button
          type="button"
          class="ghost project-overrides"
          aria-label={`agent overrides ${route.name}`}
          aria-expanded={openName === route.name}
          onclick={() => toggleOverrides(route.name)}
        >
          overrides
        </button>
        <button
          type="button"
          class="project-save"
          class:primary={projects.isDirty(route)}
          class:ghost={!projects.isDirty(route)}
          aria-label={`save project ${route.name}`}
          disabled={saving[route.name] || !projects.isDirty(route)}
          onclick={() => save(route)}
        >
          {saving[route.name] ? "saving…" : projects.isDirty(route) ? "save" : "saved"}
        </button>
      </div>
      {#if openName === route.name}
        <div class="override-editor" role="group" aria-label={`override editor ${route.name}`}>
          <p class="override-note">
            Replaces this actor's lineup and patches its skills and timeout for cards tagged <code>{route.name}</code>. An empty lineup or timeout inherits; to inherit skills again, clear the override.
          </p>
          <div class="override-fields">
            <label class="override-field">
              actor
              <select
                aria-label={`override actor ${route.name}`}
                value={actor}
                onchange={(ev) => {
                  actor = (ev.currentTarget as HTMLSelectElement).value;
                  loadForm();
                }}
              >
                {#each actorGroups as group (group.lane)}
                  <optgroup label={group.lane}>
                    {#each group.actors as id (id)}
                      <option value={id}>{id}{projects.overrides[route.name]?.[id] ? " · override" : ""}</option>
                    {/each}
                  </optgroup>
                {/each}
                <optgroup label="board">
                  {#each BOARD_ACTORS as id (id)}
                    <option value={id}>{id}{projects.overrides[route.name]?.[id] ? " · override" : ""}</option>
                  {/each}
                </optgroup>
              </select>
            </label>
            <label class="override-field">
              timeout · min
              <input inputmode="numeric" aria-label={`override timeout ${route.name}`} bind:value={form.timeoutMin} placeholder="inherit" />
            </label>
          </div>

          <div class="override-lineup">
            {#each form.runsOn as id, i (id)}
              <div class="override-lineup-row">
                <span class="override-rank">{i === 0 ? "first" : `fallback ${i}`}</span>
                <span class="override-engine">{engineName(id)}</span>
                <button type="button" class="ghost" aria-label={`override move ${engineName(id)} up in ${route.name}`} disabled={i === 0} onclick={() => moveEngine(i, -1)}>↑</button>
                <button type="button" class="ghost" aria-label={`override move ${engineName(id)} down in ${route.name}`} disabled={i === form.runsOn.length - 1} onclick={() => moveEngine(i, 1)}>↓</button>
                <button type="button" class="ghost" aria-label={`override remove ${engineName(id)} from ${route.name}`} onclick={() => removeEngine(i)}>×</button>
              </div>
            {:else}
              <p class="override-inherit">inherits the actor's lineup</p>
            {/each}
            <label class="override-field">
              add engine
              <select
                aria-label={`override add engine ${route.name}`}
                value=""
                onchange={(ev) => {
                  addEngine((ev.currentTarget as HTMLSelectElement).value);
                  (ev.currentTarget as HTMLSelectElement).value = "";
                }}
                disabled={addableEngines.length === 0}
              >
                <option value="">{savedEngines.length === 0 ? "no engines yet — create one in Engines" : addableEngines.length === 0 ? "every engine is in the lineup" : "choose…"}</option>
                {#each addableEngines as e (e.id)}
                  <option value={e.id}>{e.name} · {engineSummary(e)}</option>
                {/each}
              </select>
            </label>
          </div>

          <div class="override-skills">
            <SkillPicker selected={form.skills} onchange={(paths) => (form.skills = paths)} />
          </div>

          <div class="override-footer">
            <button type="button" class="primary" aria-label={`save override ${route.name}`} disabled={savingActor} onclick={() => saveOverride(route.name)}>
              {savingActor ? "saving…" : "save"}
            </button>
            <button
              type="button"
              class="ghost"
              aria-label={`clear override ${route.name}`}
              disabled={savingActor || !projects.overrides[route.name]?.[actor]}
              onclick={() => clearOverride(route.name)}
            >
              clear
            </button>
          </div>
          {#if actor === "manager" || actor === "worker"}
            <p class="override-inert">manager and worker overrides are stored but not applied yet — board chat and lane workers run on board-level settings.</p>
          {/if}
        </div>
      {/if}
    {/each}
  </section>
</div>

<style>
  .projects-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .projects-header-row .settings-general-heading {
    margin: 0;
  }
  .project-picker {
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    padding: 12px;
    margin-bottom: 16px;
    background: var(--bg-panel);
  }
  .picker-path-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .picker-current-path {
    flex: 1;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-small);
    padding: 4px 8px;
  }
  .picker-git-badge {
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 1px 5px;
    border-radius: var(--radius-small);
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent);
    font-weight: 600;
  }
  .picker-dirs {
    max-height: 220px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-small);
    padding: 4px;
    background: var(--bg);
  }
  .picker-dir-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    border: none;
    background: transparent;
    cursor: pointer;
    text-align: left;
    width: 100%;
    border-radius: var(--radius-small);
  }
  .picker-dir-row:hover {
    background: var(--bg-hover);
  }
  .picker-dir-name {
    font-size: 12px;
    color: var(--text);
    font-family: var(--font-mono);
  }
  .picker-empty {
    padding: 12px;
    text-align: center;
    color: var(--text-muted);
    font-size: 11px;
  }
  .picker-footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
  .picker-name-field {
    flex: 1;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }
  .picker-name-field input {
    flex: 1;
  }
  /* one row per project: name · path · gate · save. The old .settings-form
     class made this a centered column (flex-direction:column inherited). */
  .project-row {
    display: grid;
    grid-template-columns: minmax(96px, 150px) minmax(0, 1fr) minmax(0, 1fr) auto auto auto;
    align-items: end;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent);
  }
  .project-overrides {
    align-self: end;
    font-family: var(--font-mono);
    font-size: 11px;
  }
  /* the override editor: its own full-width line under the row */
  .override-editor {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
    border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
    border-radius: var(--radius-small);
    background: var(--bg-panel);
    padding: 12px;
    margin-bottom: 10px;
  }
  .override-note {
    margin: 0;
    font-size: 11px;
    color: var(--text-muted);
  }
  .override-note code {
    font-family: var(--font-mono);
  }
  .override-fields {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }
  .override-field {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 5px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
  }
  .override-field select,
  .override-field input {
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-small);
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .override-lineup {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }
  .override-lineup-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .override-rank {
    min-width: 64px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .override-engine {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .override-inherit {
    margin: 0;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .override-footer {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .override-inert {
    margin: 0;
    padding-left: 8px;
    border-left: 2px solid var(--border);
    font-size: 11px;
    color: var(--text-muted);
  }
  .project-name {
    align-self: center;
    overflow: hidden;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .project-repo {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 5px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
  }
  .project-repo input,
  .project-cmd input {
    width: 100%;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-small);
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-mono); /* paths and commands keep the mono voice (Mono-Meta) */
    font-size: 11px;
  }
  .project-repo input:focus,
  .project-cmd input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
  }
  .project-cmd {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 5px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
  }
  .fallback-hint {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .project-gate {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 6px;
    align-self: end;
    padding-bottom: 7px;
    white-space: nowrap;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .project-save {
    align-self: end;
  }
</style>
