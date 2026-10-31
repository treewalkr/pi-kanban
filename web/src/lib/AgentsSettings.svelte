<script lang="ts">
  import type { AgentConfig, AgentRole, AgentThinking } from "../../../src/db";
  import { agents } from "./agents.svelte";
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

  let role = $state<AgentRole>("reviewer");
  let form = $state<AgentForm>(toForm(agents.configs.reviewer));

  let providers = $derived([...new Set(agents.models.map((m) => m.provider))].sort());
  let modelGroups = $derived.by(() => {
    const forProvider = form.provider ? agents.models.filter((m) => m.provider === form.provider) : agents.models;
    const groups = new Map<string, Array<{ id: string; label: string }>>();
    for (const m of forProvider) {
      const list = groups.get(m.provider) ?? [];
      list.push({ id: m.id, label: `${m.id} · ${m.context}${m.thinking ? " · thinks" : ""}` });
      groups.set(m.provider, list);
    }
    return [...groups.entries()];
  });

  function touch(): void {
    agents.schedule(role, () => toConfig(form));
  }

  // role switch stashes edits in the store so the other role's form can load
  async function switchRole(next: AgentRole): Promise<void> {
    if (next === role) return;
    const ok = await agents.flush();
    if (!ok) return;
    agents.configs[role] = toConfig(form);
    role = next;
    form = toForm(agents.configs[next]);
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
    <h3 class="settings-general-heading">Role</h3>
    <p class="settings-general-description">Used by serve --agents: the planner writes plans for cards in Plan, the plan reviewer checks them against the template checklist before the human gate, the reviewer checks cards in Review, the builder works blocked findings or builds approved plans. Switching stashes unsaved edits.</p>
    <div class="seg">
      <button type="button" class="seg-option" class:on={role === "planner"} aria-pressed={role === "planner"} onclick={() => switchRole("planner")}>
        <span class="seg-label">planner</span>
      </button>
      <button type="button" class="seg-option" class:on={role === "reviewer"} aria-pressed={role === "reviewer"} onclick={() => switchRole("reviewer")}>
        <span class="seg-label">reviewer</span>
      </button>
      <button type="button" class="seg-option" class:on={role === "builder"} aria-pressed={role === "builder"} onclick={() => switchRole("builder")}>
        <span class="seg-label">builder</span>
      </button>
      <button
        type="button"
        class="seg-option"
        class:on={role === "plan-reviewer"}
        aria-pressed={role === "plan-reviewer"}
        onclick={() => switchRole("plan-reviewer")}
      >
        <span class="seg-label">plan reviewer</span>
      </button>
      <button
        type="button"
        class="seg-option"
        class:on={role === "elaborator"}
        aria-pressed={role === "elaborator"}
        onclick={() => switchRole("elaborator")}
      >
        <span class="seg-label">elaborator</span>
      </button>
    </div>
  </section>

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
