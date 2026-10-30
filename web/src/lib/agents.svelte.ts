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

export const DEBOUNCE_MS = 800;
export type AgentSaveState = "idle" | "saving" | "saved" | "failed";

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
  saveState = $state<AgentSaveState>("idle");

  private inFlight: Promise<boolean> | null = null;
  private inFlightVersion = 0;
  private pending: { role: AgentRole; get: () => AgentConfig } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wasFailed = false;
  private editVersion = 0;

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
    this.saveState = "idle";
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
    this.inFlight = null;
    this.wasFailed = false;
    this.editVersion = 0;
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
    this.saveState = "saving";
    const { error } = await api.agents({ role }).put(config);
    if (error) {
      this.fail(error);
      this.saveState = "failed";
      return false;
    }
    this.configs[role] = config;
    this.saveState = "saved";
    return true;
  }

  /** Register a dirty edit for `role`; re-arms the DEBOUNCE_MS timer. */
  schedule(role: AgentRole, config: () => AgentConfig): void {
    if (this.saveState === "failed") {
      this.wasFailed = true;
    }
    this.editVersion++;
    this.pending = { role, get: config };
    this.saveState = "saving";
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      void this.flush();
    }, DEBOUNCE_MS);
  }

  /** Save the pending config now (clears the timer). True = saved or nothing pending; false = save failed (pending re-armed). Awaits any in-flight save first. */
  async flush(): Promise<boolean> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.inFlight) {
      const flightVer = this.inFlightVersion;
      const ok = await this.inFlight;
      if (this.editVersion === flightVer) {
        return ok;
      }
    }

    if (!this.pending) {
      return true;
    }

    const { role, get } = this.pending;
    this.pending = null;
    const attemptedConfig = get();
    const versionAtStart = this.editVersion;
    const recovering = this.wasFailed || this.saveState === "failed";

    this.saveState = "saving";
    this.inFlightVersion = versionAtStart;

    let savePromise: Promise<boolean> | null = null;
    savePromise = (async () => {
      try {
        const ok = await this.save(role, attemptedConfig);
        if (ok) {
          this.saveState = "saved";
          if (recovering) {
            board.error = "";
            this.wasFailed = false;
          }
          return true;
        } else {
          this.saveState = "failed";
          this.wasFailed = true;
          if (!this.pending || this.editVersion === versionAtStart) {
            this.pending = { role, get: () => attemptedConfig };
          }
          return false;
        }
      } finally {
        if (this.inFlight === savePromise) {
          this.inFlight = null;
        }
      }
    })();

    this.inFlight = savePromise;
    return savePromise;
  }

  /** Modal close path: flush → on success open=false and saveState="idle"; on failure modal stays open. */
  async close(): Promise<void> {
    const ok = await this.flush();
    if (!ok) return;
    this.saveState = "idle";
    this.open = false;
  }
}

export const agents = new AgentsStore();
