<script lang="ts">
  import { untrack } from "svelte";
  import type { AgentConfig, AgentThinking, LaneActor, LaneContext, LaneTriggerRule } from "../../../src/db";
  import { agents, type SettingsRole } from "./agents.svelte";
  import { board } from "./board.svelte";
  import SkillPicker from "./SkillPicker.svelte";

  interface AgentForm {
    provider: string;
    model: string;
    thinking: string;
    skills: string[];
    context: string;
    tools: string;
    extraArgs: string;
    timeoutMin: string;
  }

  const toForm = (cfg: AgentConfig): AgentForm => ({
    provider: cfg.provider ?? "",
    model: cfg.model ?? "",
    thinking: cfg.thinking ?? "",
    skills: (cfg.skills ?? []).slice(),
    context: cfg.context ?? "",
    tools: cfg.tools ?? "",
    extraArgs: (cfg.extraArgs ?? []).join("\n"),
    timeoutMin: cfg.timeoutMs ? String(Math.round(cfg.timeoutMs / 60_000)) : "",
  });

  const toConfig = (f: AgentForm): AgentConfig => ({
    provider: f.provider,
    model: f.model,
    thinking: f.thinking as AgentThinking, // the select only offers valid levels
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

  function loadLaneForms(): void {
    if (boardScope) return;
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

  let providers = $derived([...new Set(agents.models.map((m) => m.provider))].sort());
  let modelGroups = $derived.by(() => {
    const forProvider = form.provider ? agents.models.filter((m) => m.provider === form.provider) : agents.models;
    const groups = new Map<string, Array<{ id: string; label: string }>>();
    for (const m of forProvider) {
      const list = groups.get(m.provider) ?? [];
      // some catalogs ship the same provider+id twice (zcode "Start") — one option each
      if (list.some((e) => e.id === m.id)) continue;
      list.push({ id: m.id, label: `${m.id} · ${m.context}${m.thinking ? " · thinks" : ""}` });
      groups.set(m.provider, list);
    }
    return [...groups.entries()];
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
      <button type="button" class="seg-option" class:on={!agents.paused} aria-pressed={!agents.paused} disabled={!agents.paused} onclick={() => agents.setPaused(false)}>
        <span class="seg-label">running</span>
      </button>
      <button type="button" class="seg-option" class:on={agents.paused} aria-pressed={agents.paused} disabled={agents.paused} onclick={() => agents.setPaused(true)}>
        <span class="seg-label">paused</span>
      </button>
    </div>
  </section>

  <section class="settings-general-section">
    <h3 class="settings-general-heading">Lane</h3>
    <p class="settings-general-description">Agent settings are organized by workflow lane: each lane hosts an actor chain with its own prompts, artifact template, and trigger/exit/gate/cap rules. Board holds the board-level agents. Switching stashes unsaved edits.</p>
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

  {#if boardScope}
    <section class="settings-general-section">
      <h3 class="settings-general-heading">Board agents</h3>
      <p class="settings-general-description">The elaborator expands newly captured cards on request, the manager chats from the board view and dispatches lane workers, and workers run per-lane charters. Lane agents are configured on their lanes above. Switching stashes unsaved edits.</p>
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
    <h3 class="settings-general-heading">Model</h3>
    <p class="settings-general-description">Provider and model from pi's catalog; "pi default" defers to whatever pi itself is configured with.</p>
    <div class="settings-form">
      {#if agents.models.length > 0}
        <div class="row">
          <label>
            provider
            <select bind:value={form.provider} onchange={touch}>
              <option value="">pi default</option>
              {#each providers as p (p)}
                <option value={p}>{p}</option>
              {/each}
              {#if form.provider && !providers.includes(form.provider)}
                <option value={form.provider}>{form.provider} · custom</option>
              {/if}
            </select>
          </label>
          <label>
            model
            <select
              bind:value={form.model}
              onchange={(e) => {
                const id = (e.currentTarget as HTMLSelectElement).value;
                const hit = agents.models.find((m) => m.id === id && (!form.provider || m.provider === form.provider));
                if (hit) form.provider = hit.provider;
                touch();
              }}
            >
              <option value="">pi default</option>
              {#each modelGroups as [provider, ms] (provider)}
                <optgroup label={provider}>
                  {#each ms as m (m.id)}
                    <option value={m.id}>{m.label}</option>
                  {/each}
                </optgroup>
              {/each}
              {#if form.model && !agents.models.some((m) => m.id === form.model)}
                <option value={form.model}>{form.model} · custom</option>
              {/if}
            </select>
          </label>
        </div>
      {:else}
        <div class="row">
          <label>
            provider
            <input bind:value={form.provider} oninput={touch} placeholder="pi default (e.g. anthropic)" />
          </label>
          <label>
            model
            <input bind:value={form.model} oninput={touch} placeholder="pi default" />
          </label>
        </div>
      {/if}
    </div>
  </section>

  <section class="settings-general-section">
    <h3 class="settings-general-heading">Thinking &amp; timeout</h3>
    <p class="settings-general-description">Reasoning effort and the total run cap. A session is killed when its output is silent for 10 min (stall) or at the cap — whichever comes first.</p>
    <div class="settings-form">
      <div class="row">
        <label>
          thinking
          <select bind:value={form.thinking} onchange={touch}>
            <option value="">default{role === "reviewer" || role === "planner" || role === "plan-reviewer" ? " (max)" : ""}</option>
            <option value="off">off</option>
            <option value="minimal">minimal</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
            <option value="max">max</option>
          </select>
        </label>
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
    <h3 class="settings-general-heading">lane workers</h3>
    <p class="settings-general-description">Short-lived per-lane agents dispatched from board chat or `kanban worker run` — backlog grooms (writable), the rest report. Summaries are what the manager relays.</p>
    {#if workerRuns === null}
      <p class="workers-empty">loading…</p>
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

  <div class="editor-actions">
    <span class="spacer"></span>
    <span class="save-status" data-state={agents.saveState}>
      {agents.saveState === "saving" ? "saving…" : agents.saveState === "saved" ? "saved" : agents.saveState === "failed" ? "save failed" : ""}
    </span>
    {#if agents.saveState === "failed"}
      <button class="ghost" onclick={() => void agents.flush()}>retry</button>
    {/if}
    <button class="ghost" onclick={() => void agents.close()}>close</button>
  </div>
</div>
