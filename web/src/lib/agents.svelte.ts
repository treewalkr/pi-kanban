import { api } from "../api";
import type { AgentConfig, AgentRole, LaneContext, LaneWorkerRun } from "../../../src/db";
import type { CatalogModel } from "../../../src/models";
import type { CatalogSkill } from "../../../src/skills";
import { board } from "./board.svelte";

type EdenError = { value?: unknown };

const emptyConfigs = (): Record<SettingsRole, AgentConfig> => ({
  planner: {},
  reviewer: {},
  builder: {},
  "plan-reviewer": {},
  elaborator: {},
  manager: {},
  worker: {},
});

/** A config-assignable role: the loop's AgentRole union plus the manager/worker keys (card d26pe). */
export type SettingsRole = AgentRole | "manager" | "worker";

export type SettingsSection = "general" | "agents" | "providers" | "engines" | "projects" | "lanes";

export const DEBOUNCE_MS = 800;
export type AgentSaveState = "idle" | "saving" | "saved" | "failed";

/** Per-role agent settings for the auto-agent loop; failures surface via the board toast. */
class AgentsStore {
  open = $state(false);
  /** Section the dialog should open on — the sidebar's bottom bar sets it, the ⚙ keeps the last one. */
  section = $state<SettingsSection>("general");
  loaded = $state(false);
  /** True when the last GET /agents failed — the panel distinguishes this from loading. */
  loadFailed = $state(false);
  /** One config per role ("plan-reviewer" needs a key, not a class field — $state rejects computed names). */
  configs = $state<Record<SettingsRole, AgentConfig>>(emptyConfigs());
  /** Lane worker runs for the settings panel's "lane workers" section; null = not loaded. */
  workerRuns = $state<LaneWorkerRun[] | null>(null);
  /** True when GET /workers failed — the panel shows a retry instead of "loading…" forever. */
  workerRunsFailed = $state(false);
  /** pi's catalog for the provider/model selects; empty → the panel falls back to text inputs. */
  models = $state<CatalogModel[]>([]);
  /** pi's skill catalog for the Skills picker; empty → picker falls back to custom-path entry. */
  skills = $state<CatalogSkill[]>([]);
  /** Board-level agent-loop pause: no process spawns (or re-spawns) sessions while set. */
  paused = $state(false);
  saveState = $state<AgentSaveState>("idle");
  /** The lane whose workflow the agents panel edits; "board" selects the utility roles (card 3n96c). */
  selectedLane = $state<string>("plan");
  /** Saved lane workflow contexts as the panel sees them; null = a cleared lane. */
  laneContexts = $state<Record<string, LaneContext | null>>({});

  private inFlight: Promise<boolean> | null = null;
  private inFlightVersion = 0;
  private pending: { role: SettingsRole; get: () => AgentConfig } | null = null;
  private pendingContext: { laneId: string; get: () => LaneContext | null } | null = null;
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
    this.loadFailed = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
    this.pendingContext = null;
    this.inFlight = null;
    this.wasFailed = false;
    this.editVersion = 0;
    const [agents, models, pause, catalog] = await Promise.all([
      api.agents.get(),
      api["pi-models"].get(),
      api.agents.pause.get(),
      api["pi-skills"].get(),
    ]);
    if (agents.error) {
      this.fail(agents.error);
      this.loadFailed = true;
    } else {
      this.configs = {
        planner: agents.data.planner ?? {},
        reviewer: agents.data.reviewer ?? {},
        builder: agents.data.builder ?? {},
        "plan-reviewer": agents.data["plan-reviewer"] ?? {},
        elaborator: agents.data.elaborator ?? {},
        manager: agents.data.manager ?? {},
        worker: agents.data.worker ?? {},
      };
      this.loaded = true;
    }
    if (!models.error) this.models = models.data.models;
    if (!pause.error) this.paused = pause.data.paused;
    if (!catalog.error) this.skills = catalog.data.skills;
    this.laneContexts = { ...board.laneContexts };
  }

  async setPaused(paused: boolean): Promise<void> {
    const { error } = await api.agents.pause.put({ paused });
    if (error) this.fail(error);
    else this.paused = paused;
  }

  /** Open the agents settings on a lane's workflow (the lane ⚙ button). */
  openLane(laneId: string): void {
    this.section = "agents";
    this.selectedLane = laneId;
    this.open = true;
  }

  /** PUT /lanes/:id/context (DELETE when null); the saved context mirrors locally. */
  async saveContext(laneId: string, context: LaneContext | null): Promise<boolean> {
    this.saveState = "saving";
    if (context === null) {
      const { error } = await api.lanes({ id: laneId }).context.delete();
      if (error) {
        this.fail(error);
        this.saveState = "failed";
        return false;
      }
      this.laneContexts[laneId] = null;
      this.saveState = "saved";
      return true;
    }
    const { data, error } = await api.lanes({ id: laneId }).context.put(context);
    if (error) {
      this.fail(error);
      this.saveState = "failed";
      return false;
    }
    this.laneContexts[laneId] = (data as { context: LaneContext }).context;
    this.saveState = "saved";
    return true;
  }

  /** Register a dirty lane-context edit; re-arms the DEBOUNCE_MS timer. */
  scheduleContext(laneId: string, get: () => LaneContext | null): void {
    if (this.saveState === "failed") {
      this.wasFailed = true;
    }
    this.editVersion++;
    this.pendingContext = { laneId, get };
    this.saveState = "saving";
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      void this.flush();
    }, DEBOUNCE_MS);
  }

  async save(role: SettingsRole, config: AgentConfig): Promise<boolean> {
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
  schedule(role: SettingsRole, config: () => AgentConfig): void {
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

  /** Save pending edits now (clears the timer): the role config, then the lane
   *  context. True = saved or nothing pending; false = a save failed (the failed
   *  edit re-arms). Awaits any in-flight save first. */
  async flush(): Promise<boolean> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const okConfig = await this.#flushConfig();
    const okContext = await this.#flushContext();
    return okConfig && okContext;
  }

  /** The role-config half (the pre-lane-context flush body). */
  async #flushConfig(): Promise<boolean> {
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

  /** The lane-context half (card 3n96c). */
  async #flushContext(): Promise<boolean> {
    const ctxPending = this.pendingContext;
    if (!ctxPending) return true;
    this.pendingContext = null;
    const attemptedContext = ctxPending.get();
    const recovering = this.wasFailed || this.saveState === "failed";
    const ok = await this.saveContext(ctxPending.laneId, attemptedContext);
    if (ok) {
      if (recovering) {
        board.error = "";
        this.wasFailed = false;
      }
    } else if (!this.pendingContext) {
      this.pendingContext = { laneId: ctxPending.laneId, get: () => attemptedContext };
    }
    return ok;
  }

  /** GET /workers for the settings panel; a failed load flips workerRunsFailed for the retry line. */
  async loadWorkers(): Promise<void> {
    this.workerRunsFailed = false;
    const res = await api.workers.get();
    if (!res.error) this.workerRuns = res.data.workers;
    else this.workerRunsFailed = true;
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
