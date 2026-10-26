<script lang="ts">
  import type { AgentConfig, AgentRole, AgentThinking } from "../../../src/db";
  import { agents } from "./agents.svelte";

  interface AgentForm {
    provider: string;
    model: string;
    thinking: string;
    skills: string;
    context: string;
    tools: string;
    extraArgs: string;
    timeoutMin: string;
  }

  const toForm = (cfg: AgentConfig): AgentForm => ({
    provider: cfg.provider ?? "",
    model: cfg.model ?? "",
    thinking: cfg.thinking ?? "",
    skills: (cfg.skills ?? []).join("\n"),
    context: cfg.context ?? "",
    tools: cfg.tools ?? "",
    extraArgs: (cfg.extraArgs ?? []).join("\n"),
    timeoutMin: cfg.timeoutMs ? String(Math.round(cfg.timeoutMs / 60_000)) : "",
  });

  const toConfig = (f: AgentForm): AgentConfig => ({
    provider: f.provider,
    model: f.model,
    thinking: f.thinking as AgentThinking, // the select only offers valid levels
    skills: f.skills.split("\n").map((s) => s.trim()).filter(Boolean),
    context: f.context,
    tools: f.tools,
    extraArgs: f.extraArgs.split("\n").map((s) => s.trim()).filter(Boolean),
    timeoutMs: f.timeoutMin ? Number(f.timeoutMin) * 60_000 : undefined,
  });

  let role = $state<AgentRole>("reviewer");
  let form = $state<AgentForm>(toForm(agents.configs.reviewer));
  let saving = $state(false);

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

  // role switch stashes edits in the store so the other role's form can load
  function switchRole(next: AgentRole): void {
    if (next === role) return;
    agents.configs[role] = toConfig(form);
    role = next;
    form = toForm(agents.configs[next]);
  }

  async function save(): Promise<void> {
    if (saving) return;
    saving = true;
    const ok = await agents.save(role, toConfig(form));
    saving = false;
    if (ok) agents.open = false;
  }
</script>

<div class="settings-general">
  <section class="settings-general-section">
    <h3 class="settings-general-heading">Role</h3>
    <p class="settings-general-description">Used by serve --auto-review: the planner writes plans for cards in Plan, the plan reviewer checks them against the template checklist before the human gate, the reviewer checks cards in Review, the builder works blocked findings or builds approved plans. Switching stashes unsaved edits.</p>
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
            <select bind:value={form.provider}>
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
            <input bind:value={form.provider} placeholder="pi default (e.g. anthropic)" />
          </label>
          <label>
            model
            <input bind:value={form.model} placeholder="pi default" />
          </label>
        </div>
      {/if}
    </div>
  </section>

  <section class="settings-general-section">
    <h3 class="settings-general-heading">Thinking &amp; timeout</h3>
    <p class="settings-general-description">Reasoning effort and the hard per-run time limit.</p>
    <div class="settings-form">
      <div class="row">
        <label>
          thinking
          <select bind:value={form.thinking}>
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
          <input inputmode="numeric" bind:value={form.timeoutMin} placeholder="20" />
        </label>
      </div>
    </div>
  </section>

  <section class="settings-general-section">
    <h3 class="settings-general-heading">Skills</h3>
    <p class="settings-general-description">One path per line, passed to pi as --skill.</p>
    <div class="settings-form">
      <label>
        skills
        <textarea bind:value={form.skills} rows="2" placeholder={"~/.pi/agent/skills/scrutinize"}></textarea>
      </label>
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
          rows="3"
          placeholder={"standing instructions the agent always gets — review lens, conventions, hard rules…"}
        ></textarea>
      </label>
      <label>
        tools
        <input bind:value={form.tools} placeholder="pi default (e.g. -edit,+bash)" />
      </label>
    </div>
  </section>

  <section class="settings-general-section">
    <h3 class="settings-general-heading">Extra pi flags</h3>
    <p class="settings-general-description">One flag per line, appended verbatim to the pi invocation.</p>
    <div class="settings-form">
      <label>
        flags
        <textarea bind:value={form.extraArgs} rows="2" placeholder="--no-mcp"></textarea>
      </label>
    </div>
  </section>

  <div class="editor-actions">
    <span class="spacer"></span>
    <button class="ghost" onclick={() => (agents.open = false)}>cancel</button>
    <button class="primary" onclick={save} disabled={saving}>save</button>
  </div>
</div>
