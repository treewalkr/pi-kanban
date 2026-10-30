import { api } from "../api";
import type { AgentConfig, AgentRole } from "../../../src/db";
import type { CatalogModel } from "../../../src/models";
import type { CatalogSkill } from "../../../src/skills";
import { board } from "./board.svelte";

type EdenError = { value?: unknown };

const emptyConfigs = (): Record<AgentRole, AgentConfig> => ({
  planner: {},
  reviewer: {},
  builder: {},
  "plan-reviewer": {},
  elaborator: {},
});

export type SettingsSection = "general" | "agents" | "pools";

/** Per-role agent settings for the auto-agent loop; failures surface via the board toast. */
class AgentsStore {
  open = $state(false);
  /** Section the dialog should open on — the sidebar's bottom bar sets it, the ⚙ keeps the last one. */
  section = $state<SettingsSection>("general");
  loaded = $state(false);
  /** One config per role, keyed by AgentRole ("plan-reviewer" needs a key, not a class field — $state rejects computed names). */
  configs = $state<Record<AgentRole, AgentConfig>>(emptyConfigs());
  /** pi's catalog for the provider/model selects; empty → the panel falls back to text inputs. */
  models = $state<CatalogModel[]>([]);
  /** pi's skill catalog for the Skills picker; empty → picker falls back to custom-path entry. */
  skills = $state<CatalogSkill[]>([]);
  /** Board-level agent-loop pause: no process spawns (or re-spawns) sessions while set. */
  paused = $state(false);

  private fail(error: EdenError): void {
    const value = error.value as { error?: string } | undefined;
    board.error = value?.error ?? "request failed";
  }

  /** Open the settings dialog on a specific section (sidebar bottom bar). */
  openWith(section: SettingsSection): void {
    this.section = section;
    this.open = true;
  }

  async load(): Promise<void> {
    const [agents, models, pause, catalog] = await Promise.all([
      api.agents.get(),
      api["pi-models"].get(),
      api.agents.pause.get(),
      api["pi-skills"].get(),
    ]);
    if (agents.error) this.fail(agents.error);
    else {
      this.configs = {
        planner: agents.data.planner ?? {},
        reviewer: agents.data.reviewer ?? {},
        builder: agents.data.builder ?? {},
        "plan-reviewer": agents.data["plan-reviewer"] ?? {},
        elaborator: agents.data.elaborator ?? {},
      };
      this.loaded = true;
    }
    if (!models.error) this.models = models.data.models;
    if (!pause.error) this.paused = pause.data.paused;
    if (!catalog.error) this.skills = catalog.data.skills;
  }

  async setPaused(paused: boolean): Promise<void> {
    const { error } = await api.agents.pause.put({ paused });
    if (error) this.fail(error);
    else this.paused = paused;
  }

  async save(role: AgentRole, config: AgentConfig): Promise<boolean> {
    const { error } = await api.agents({ role }).put(config);
    if (error) {
      this.fail(error);
      return false;
    }
    this.configs[role] = config;
    return true;
  }
}

export const agents = new AgentsStore();
