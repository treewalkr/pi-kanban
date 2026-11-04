<script lang="ts">
  import { untrack } from "svelte";
  import { ChevronDown, ChevronUp, X } from "@lucide/svelte";
  import type { AgentConfig, LaneActor, LaneContext, LaneTriggerRule } from "../../../src/db";
  import { api } from "../api";
  import { agents, type SettingsRole } from "./agents.svelte";
  import { engines, engineSummary } from "./engines.svelte";
  import { board } from "./board.svelte";
  import SkillPicker from "./SkillPicker.svelte";

  interface AgentForm {
    /** The actor's engine lineup, in preference order (empty = board default). */
    runsOn: string[];
    skills: string[];
    context: string;
    tools: string;
    extraArgs: string;
    timeoutMin: string;
  }

  const toForm = (cfg: AgentConfig): AgentForm => ({
    runsOn: (cfg.runsOn ?? []).slice(),
    skills: (cfg.skills ?? []).slice(),
    context: cfg.context ?? "",
    tools: cfg.tools ?? "",
    extraArgs: (cfg.extraArgs ?? []).join("\n"),
    timeoutMin: cfg.timeoutMs ? String(Math.round(cfg.timeoutMs / 60_000)) : "",
  });

  const toConfig = (f: AgentForm): AgentConfig => ({
    runsOn: f.runsOn.slice(),
    skills: f.skills.slice(),
    context: f.context,
    tools: f.tools,
    extraArgs: f.extraArgs.split("\n").map((s) => s.trim()).filter(Boolean),
    timeoutMs: f.timeoutMin ? Number(f.timeoutMin) * 60_000 : undefined,
  });

  let role = $state<SettingsRole>("reviewer");
  let form = $state<AgentForm>(toForm(agents.configs.reviewer));

  // ---- lane workflow scope (card 3n96c): the agents panel is organized by lane ----
  // workflow lanes = every lane except the fixed parking lots; "board" holds the utility roles
  let workflowLanes = $derived(board.lanes.filter((l) => l.id !== "waiting" && l.id !== "done" && l.id !== "archive"));
  let selectedLane = $derived(agents.selectedLane);
  let boardScope = $derived(selectedLane === "board");
  let customLane = $derived(!boardScope && selectedLane !== "plan" && selectedLane !== "implement" && selectedLane !== "review");

  interface LaneForm {
    // the selected actor
    author: string;
    instructions: string;
    // the lane's artifact
    artifact: string;
    template: string;
    // triggers (comment-kind triggers are preserved invisibly)
    onEnter: boolean;
    humanComment: boolean;
    // gate + cap + test gate
    approveTarget: string;
    cap: string;
    testGate: boolean;
  }

  const emptyLaneForm = (): LaneForm => ({
    author: "",
    instructions: "",
    artifact: "",
    template: "",
    onEnter: false,
    humanComment: false,
    approveTarget: "",
    cap: "",
    testGate: false,
  });

  let laneForm = $state<LaneForm>(emptyLaneForm());

  let laneContext = $derived(agents.laneContexts[selectedLane] ?? board.laneContexts[selectedLane] ?? null);
  let laneActors = $derived(laneContext?.actors ?? []);
  let laneActor = $derived(laneActors.find((a) => a.id === role) ?? null);
  let laneName = $derived(board.lanes.find((l) => l.id === selectedLane)?.name ?? selectedLane);

  const BOARD_ROLES: SettingsRole[] = ["elaborator", "manager", "worker"];

  function loadLaneForms(): void {
    if (boardScope) {
      // entering Board must select a board role: leaving a lane actor in `role`
      // made the next model/thinking edit save to that lane's agent (q8x8g)
      if (!BOARD_ROLES.includes(role)) role = "elaborator";
      form = toForm(agents.configs[role]);
      return;
    }
    const ctx = laneContext;
    if (!ctx) {
      laneForm = emptyLaneForm();
      const first = board.lanes.find((l) => l.id === selectedLane);
      role = `${first?.id ?? "lane"}-worker`;
      return;
    }
    role = ctx.actors.some((a) => a.id === role) ? role : (ctx.actors[0]?.id ?? role);
    const actor = ctx.actors.find((a) => a.id === role);
    laneForm = laneFormOf(ctx, actor);
    form = toForm(actorConfigOf(actor));
  }

  function actorConfigOf(actor: LaneActor | null | undefined): AgentConfig {
    return actor?.config ?? agents.configs[actor?.id as SettingsRole] ?? {};
  }

  function laneFormOf(ctx: LaneContext, actor: LaneActor | null | undefined): LaneForm {
    return {
      author: actor?.author ?? "",
      instructions: actor?.instructions ?? "",
      artifact: ctx.artifact ?? "",
      template: ctx.template ?? "",
      onEnter: (ctx.triggers ?? []).some((t) => t.kind === "on-enter"),
      humanComment: (ctx.triggers ?? []).some((t) => t.kind === "human-comment"),
      approveTarget: ctx.gate?.approveTarget ?? "",
      cap: ctx.cap ? String(ctx.cap.max) : "",
      testGate: ctx.testGate ?? false,
    };
  }

  // the editable context: the saved one with the form's actor + lane fields patched in
  function buildContext(): LaneContext | null {
    const base = laneContext;
    if (!base) return null;
    const config = toConfig(form);
    const actor: LaneActor = laneActor
      ? { ...laneActor, author: laneForm.author, instructions: laneForm.instructions, config }
      : { id: role as string, author: laneForm.author, instructions: laneForm.instructions, config };
    const actors = base.actors.some((a) => a.id === actor.id)
      ? base.actors.map((a) => (a.id === actor.id ? actor : a))
      : [...base.actors, actor];
    const commentTriggers = (base.triggers ?? []).filter((t): t is LaneTriggerRule & { kind: "comment" } => t.kind === "comment");
    const triggers: LaneTriggerRule[] = [
      ...(laneForm.onEnter ? [{ kind: "on-enter" } as const] : []),
      ...commentTriggers,
      ...(laneForm.humanComment ? [{ kind: "human-comment" } as const] : []),
    ];
    const next: LaneContext = { ...base, actors, triggers };
    if (laneForm.artifact.trim()) next.artifact = laneForm.artifact.trim();
    else delete next.artifact;
    if (laneForm.template.trim()) next.template = laneForm.template;
    else delete next.template;
    if (laneForm.approveTarget.trim()) {
      next.gate = { ...(base.gate ?? {}), approveTarget: laneForm.approveTarget.trim() };
    } else delete next.gate;
    const capMax = Number(laneForm.cap);
    if (laneForm.cap !== "" && Number.isInteger(capMax)) {
      next.cap = {
        max: capMax,
        scope: base.cap?.scope ?? "thread",
        match: base.cap?.match ?? {},
        author: base.cap?.author ?? actors[0]?.author ?? `pi-${selectedLane}`,
        message: base.cap?.message ?? "auto-cycles reached the cap of {max} — needs a human. Comment with feedback to re-run, or reject with feedback.",
      };
    } else delete next.cap;
    if (laneForm.testGate) next.testGate = true;
    else delete next.testGate;
    return next;
  }

  function touchLane(): void {
    agents.scheduleContext(selectedLane, () => buildContext());
  }

  /** Enable a starter workflow on a context-free custom lane. */
  function enableWorkflow(): void {
    const lane = board.lanes.find((l) => l.id === selectedLane);
    const id = lane ? lane.id : selectedLane;
    agents.scheduleContext(selectedLane, () => ({
      actors: [{ id, author: `pi-${id}`, instructions: `Work kanban card {id} "{title}" in this lane, then record the result on the thread.` }],
      triggers: [{ kind: "on-enter" }],
    }));
  }

  /** Clear a custom lane's workflow (the loop stops arming its actors). */
  function disableWorkflow(): void {
    agents.scheduleContext(selectedLane, () => null);
  }

  // pick the lane's first actor whenever the panel opens or the lane changes —
  // untracked: a post-save context refresh must not clobber in-progress edits
  $effect(() => {
    void agents.loaded;
    void agents.selectedLane;
    untrack(() => loadLaneForms());
  });

  // lane workers section: fetch runs when the panel mounts (AgentsSettings remounts per open)
  let workerRuns = $derived(agents.workerRuns);
  $effect(() => {
    void agents.loadWorkers();
  });

  // the lineup editor picks from the engine registry
  $effect(() => {
    if (!engines.loaded) void engines.load();
  });
  let savedEngines = $derived(engines.engines.filter((e) => !engines.isDraft(e.id)));
  let addable = $derived(savedEngines.filter((e) => !form.runsOn.includes(e.id)));
  const engineName = (id: string) => engines.engines.find((e) => e.id === id)?.name ?? id;

  function moveEngine(i: number, delta: -1 | 1): void {
    const j = i + delta;
    if (j < 0 || j >= form.runsOn.length) return;
    const next = form.runsOn.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    form.runsOn = next;
    touch();
  }

  function removeEngine(i: number): void {
    form.runsOn = form.runsOn.filter((_, k) => k !== i);
    touch();
  }

  function addEngine(id: string): void {
    if (!id || form.runsOn.includes(id)) return;
    form.runsOn = [...form.runsOn, id];
    touch();
  }

  /** The server's answer to "what does this actor's next spawn run on, and why" (GET /explain). */
  let explanation = $state<string | null>(null);
  let explainSeq = 0;
  $effect(() => {
    const actor = role;
    void JSON.stringify(form.runsOn); // re-ask when the lineup changes
    void agents.saveState; // …and once the edit lands
    const seq = ++explainSeq;
    void api.explain({ actor }).get({ query: {} }).then(({ data }) => {
      if (seq === explainSeq) explanation = data?.text ?? null;
    });
  });

  async function selectLane(id: string): Promise<void> {
    if (id === agents.selectedLane) return;
    await agents.flush();
    agents.selectedLane = id;
  }

  function touch(): void {
    if (boardScope) agents.schedule(role, () => toConfig(form));
    else touchLane();
  }

  // role switch stashes edits in the store so the other role's form can load
  async function switchRole(next: SettingsRole): Promise<void> {
    if (next === role) return;
    const ok = await agents.flush();
    if (!ok) return;
    if (boardScope) {
      agents.configs[role] = toConfig(form);
      role = next;
      form = toForm(agents.configs[next]);
    } else {
      role = next;
      const ctx = agents.laneContexts[selectedLane] ?? board.laneContexts[selectedLane] ?? null;
      const actor = ctx?.actors.find((a) => a.id === next);
      form = toForm(actorConfigOf(actor));
      laneForm = laneFormOf(ctx ?? { actors: [], triggers: [] }, actor);
    }
  }

  function ageOf(run: { createdAt: number; endedAt?: number }): string {
    const end = run.endedAt ?? Date.now();
    const s = Math.max(0, Math.round((end - run.createdAt) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${Math.round(s / 3600)}h`;
  }

  function firstLine(text: string | undefined): string | undefined {
    const line = text?.split("\n")[0];
    return line && line.length > 0 ? line : undefined;
  }
</script>

<div class="settings-general">
  <section class="settings-general-section">
    <h3 class="settings-general-heading">Agent loop</h3>
    <p class="settings-general-description">Paused stops every loop process from spawning agent sessions and kills in-flight ones; unpausing resumes on the next board write. Survives restarts — no new session is created for a card while paused.</p>
    <div class="seg">
      <button type="button" class="seg-option" class:on={!agents.paused} aria-pressed={!agents.paused} onclick={() => agents.setPaused(false)}>
        <span class="seg-label">running</span>
      </button>
      <button type="button" class="seg-option" class:on={agents.paused} aria-pressed={agents.paused} onclick={() => agents.setPaused(true)}>
        <span class="seg-label">paused</span>
      </button>
    </div>
  </section>

  <section class="settings-general-section">
    <h3 class="settings-general-heading">Lane</h3>
    <p class="settings-general-description">Agent settings are organized by workflow lane: each lane hosts an actor chain with its own prompts, artifact template, and trigger/exit/gate/cap rules. Board holds the board-level agents. Switching saves pending edits.</p>
    <div class="seg">
      {#each workflowLanes as l (l.id)}
        <button type="button" class="seg-option" class:on={selectedLane === l.id} aria-pressed={selectedLane === l.id} onclick={() => void selectLane(l.id)}>
          <span class="seg-label">{l.name}</span>
        </button>
      {/each}
      <button type="button" class="seg-option" class:on={boardScope} aria-pressed={boardScope} onclick={() => void selectLane("board")}>
        <span class="seg-label">Board</span>
      </button>
    </div>
  </section>

  <div class="settings-scope" aria-live="polite">
    <span class="settings-scope-lane">{boardScope ? "board" : laneName}</span>
    <span class="settings-scope-role">{role}</span>
    <span class="settings-scope-hint">{boardScope ? "board role" : "lane actor"}</span>
  </div>

  {#if boardScope}
    <section class="settings-general-section">
      <h3 class="settings-general-heading">Board agents</h3>
      <p class="settings-general-description">The elaborator expands newly captured cards on request, the manager chats from the board view and dispatches lane workers, and workers run per-lane charters. Lane agents are configured on their lanes above. Switching saves pending edits.</p>
      <div class="seg">
        <button
          type="button"
          class="seg-option"
          class:on={role === "elaborator"}
          aria-pressed={role === "elaborator"}
          onclick={() => switchRole("elaborator")}
        >
          <span class="seg-label">elaborator</span>
        </button>
        <button
          type="button"
          class="seg-option"
          class:on={role === "manager"}
          aria-pressed={role === "manager"}
          onclick={() => switchRole("manager")}
        >
          <span class="seg-label">manager</span>
        </button>
        <button
          type="button"
          class="seg-option"
          class:on={role === "worker"}
          aria-pressed={role === "worker"}
          onclick={() => switchRole("worker")}
        >
          <span class="seg-label">worker</span>
        </button>
      </div>
    </section>
  {:else if laneContext}
    <section class="settings-general-section">
      <h3 class="settings-general-heading">Actors on {laneName}</h3>
      <p class="settings-general-description">The lane arms its actor chain per its rules — each actor's instructions support the {"{id}"} / {"{title}"} / {"{tmpFile}"} placeholders, and the template below is appended unless the instructions embed it via {"{template}"}.</p>
      <div class="seg">
        {#each laneActors as a (a.id)}
          <button type="button" class="seg-option" class:on={role === a.id} aria-pressed={role === a.id} onclick={() => switchRole(a.id)}>
            <span class="seg-label">{a.id}</span>
          </button>
        {/each}
      </div>
      <div class="settings-form">
        <label>
          actor author
          <input bind:value={laneForm.author} oninput={touchLane} placeholder="pi-{role}" />
        </label>
        <label>
          instructions
          <textarea
            bind:value={laneForm.instructions}
            oninput={touchLane}
            rows="6"
            placeholder={"the prompt this actor is spawned with — kanban card {id} \"{title}\" …"}
          ></textarea>
        </label>
      </div>
      {#if customLane}
        <div class="settings-form">
          <button class="ghost danger" onclick={disableWorkflow}>disable this lane's workflow</button>
        </div>
      {/if}
    </section>

    <section class="settings-general-section">
      <h3 class="settings-general-heading">Workflow rules</h3>
      <p class="settings-general-description">Triggers arm the actor chain (on entry, or when the last thread comment is a human's); the gate is the human-only approve/reject; the cap parks the card for a human after that many agent cycles; the test gate runs `bun test` before a spawn.</p>
      <div class="settings-form">
        <div class="row">
          <label>
            artifact
            <input bind:value={laneForm.artifact} oninput={touchLane} placeholder="plan" />
          </label>
          <label>
            gate: approve to
            <select bind:value={laneForm.approveTarget} onchange={touchLane}>
              <option value="">no gate</option>
              {#each board.lanes as l (l.id)}
                <option value={l.id}>{l.name}</option>
              {/each}
            </select>
          </label>
        </div>
        <label>
          template
          <textarea
            bind:value={laneForm.template}
            oninput={touchLane}
            rows="6"
            placeholder={"the artifact this lane's actors write against — embedded in every prompt"}
          ></textarea>
        </label>
        <div class="row">
          <span class="lane-triggers">
            <label class="trigger-toggle">
              <input type="checkbox" bind:checked={laneForm.onEnter} onchange={touchLane} />
              arm on enter
            </label>
            <label class="trigger-toggle">
              <input type="checkbox" bind:checked={laneForm.humanComment} onchange={touchLane} />
              arm on human comment
            </label>
            <label class="trigger-toggle">
              <input type="checkbox" bind:checked={laneForm.testGate} onchange={touchLane} />
              pre-spawn test gate
            </label>
          </span>
          <label>
            cap · cycles
            <input inputmode="numeric" bind:value={laneForm.cap} oninput={touchLane} placeholder="none" />
          </label>
        </div>
      </div>
    </section>
  {:else}
    <section class="settings-general-section">
      <h3 class="settings-general-heading">{laneName}</h3>
      <p class="settings-general-description">This lane has no workflow — cards pass through untouched. Enable one to give it an actor chain, a template, and rules, with zero code changes.</p>
      <div class="settings-form">
        <button class="ghost" onclick={enableWorkflow}>add a workflow to this lane</button>
      </div>
    </section>
  {/if}

  <section class="settings-general-section">
    <h3 class="settings-general-heading">Runs on</h3>
    <p class="settings-general-description">
      The engines this actor runs on, in order: each spawn takes the first enabled engine with a free seat that isn't cooling down; the rest are fallbacks.
      Empty runs on the board default. Models, thinking and seats live on the engines (Settings → Engines); a project can replace this lineup.
    </p>
    <div class="settings-form lineup" data-testid="lineup">
      {#each form.runsOn as id, i (id)}
        {@const e = engines.engines.find((x) => x.id === id)}
        <div class="lineup-row">
          <span class="lineup-rank">{i === 0 ? "first" : `fallback ${i}`}</span>
          <span class="lineup-name">{engineName(id)}</span>
          <span class="lineup-spec mono">{e ? `${engineSummary(e)} · ${e.seats} seat${e.seats === 1 ? "" : "s"}${e.enabled ? "" : " · disabled"}` : "unknown engine"}</span>
          {#if i > 0 && e && engines.engines.find((x) => x.id === form.runsOn[0])?.harness !== e.harness}
            <span class="lineup-warn" title="a transcript can't move between harnesses">fresh session on failover</span>
          {/if}
          <button type="button" class="ghost" aria-label={`move ${engineName(id)} up`} disabled={i === 0} onclick={() => moveEngine(i, -1)}>
            <ChevronUp size={14} strokeWidth={1.75} />
          </button>
          <button type="button" class="ghost" aria-label={`move ${engineName(id)} down`} disabled={i === form.runsOn.length - 1} onclick={() => moveEngine(i, 1)}>
            <ChevronDown size={14} strokeWidth={1.75} />
          </button>
          <button type="button" class="ghost" aria-label={`remove ${engineName(id)}`} onclick={() => removeEngine(i)}>
            <X size={14} strokeWidth={1.75} />
          </button>
        </div>
      {:else}
        <p class="lineup-empty">board default — {engines.settings.defaultEngine ? engineName(engines.settings.defaultEngine) : "pi default"}</p>
      {/each}
      <div class="row">
        <label>
          add engine
          <select
            aria-label="add engine"
            value=""
            onchange={(ev) => {
              addEngine((ev.currentTarget as HTMLSelectElement).value);
              (ev.currentTarget as HTMLSelectElement).value = "";
            }}
            disabled={addable.length === 0}
          >
            <option value="">{savedEngines.length === 0 ? "no engines yet — create one in Engines" : addable.length === 0 ? "every engine is in the lineup" : "choose…"}</option>
            {#each addable as e (e.id)}
              <option value={e.id}>{e.name} · {engineSummary(e)}</option>
            {/each}
          </select>
        </label>
      </div>
      {#if explanation}
        <pre class="explain mono" data-testid="explain">{explanation}</pre>
      {/if}
    </div>
  </section>

  <section class="settings-general-section">
    <h3 class="settings-general-heading">Timeout</h3>
    <p class="settings-general-description">The total run cap. A session is killed when its output is silent for 10 min (stall) or at the cap — whichever comes first.</p>
    <div class="settings-form">
      <div class="row">
        <label>
          timeout · min
          <input inputmode="numeric" bind:value={form.timeoutMin} oninput={touch} placeholder="120" />
        </label>
      </div>
    </div>
  </section>

  <section class="settings-general-section">
    <h3 class="settings-general-heading">Skills</h3>
    <p class="settings-general-description">Search pi's skill catalog (~/.pi/agent/skills) and toggle skills on — each skill's SKILL.md is injected into the session's system prompt at spawn (and still passed as --skill). Type any path to add one outside the catalog.</p>
    <div class="settings-form">
      <SkillPicker selected={form.skills} onchange={(paths) => { form.skills = paths; touch(); }} />
    </div>
  </section>

  <section class="settings-general-section">
    <h3 class="settings-general-heading">Context &amp; tools</h3>
    <p class="settings-general-description">Standing instructions appended to the system prompt, and pi tool allow/deny flags.</p>
    <div class="settings-form">
      <label>
        context
        <textarea
          bind:value={form.context}
          oninput={touch}
          rows="3"
          placeholder={"standing instructions the agent always gets — review lens, conventions, hard rules…"}
        ></textarea>
      </label>
      <label>
        tools
        <input bind:value={form.tools} oninput={touch} placeholder="pi default (e.g. -edit,+bash)" />
      </label>
    </div>
  </section>

  <section class="settings-general-section">
    <h3 class="settings-general-heading">Extra pi flags</h3>
    <p class="settings-general-description">One flag per line, appended verbatim to the pi invocation.</p>
    <div class="settings-form">
      <label>
        flags
        <textarea bind:value={form.extraArgs} oninput={touch} rows="2" placeholder="--no-mcp"></textarea>
      </label>
    </div>
  </section>

  <section class="settings-general-section">
    <h3 class="settings-general-heading">Lane workers</h3>
    <p class="settings-general-description">Short-lived per-lane agents dispatched from board chat or `kanban worker run` — backlog grooms (writable), the rest report. Summaries are what the manager relays.</p>
    {#if workerRuns === null}
      <p class="workers-empty">
        {agents.workerRunsFailed ? "could not load worker runs" : "loading…"}
        {#if agents.workerRunsFailed}
          <button class="ghost" onclick={() => void agents.loadWorkers()}>retry</button>
        {/if}
      </p>
    {:else if workerRuns.length === 0}
      <p class="workers-empty">no runs — dispatch from board chat or `kanban worker run`</p>
    {:else}
      <div class="workers-list">
        {#each workerRuns as run (run.id)}
          <div class="worker-row">
            <span class="worker-status {run.status}">{run.status}</span>
            <span class="worker-lane">{run.laneId}</span>
            <span class="worker-age">{ageOf(run)}</span>
            <span class="worker-summary">{firstLine(run.summary) ?? run.focus ?? ""}</span>
          </div>
        {/each}
      </div>
    {/if}
  </section>
</div>
