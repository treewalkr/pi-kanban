import { api } from "../api";
import type { Engine } from "../../../src/db";
import type { CatalogModel } from "../../../src/models";
import type { ClaudeModel } from "../../../src/claude";
import { board } from "./board.svelte";

type EdenError = { value?: unknown };

/** Editable engine shape: optional strings bound as "" so selects/inputs have a value. */
export interface EngineDraft {
  id: string;
  name: string;
  harness: "pi" | "claude";
  provider: string;
  model: string;
  thinking: string;
  flags: string[];
  seats: number;
  enabled: boolean;
}

const toDraft = (e: Engine): EngineDraft => ({
  id: e.id,
  name: e.name,
  harness: e.harness,
  provider: e.provider ?? "",
  model: e.model ?? "",
  thinking: e.thinking ?? "",
  flags: [...e.flags],
  seats: e.seats,
  enabled: e.enabled,
});

/** Slug id from a name (the CLI's rule), suffixed until free. */
function slugFor(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "engine";
  let id = base;
  for (let n = 2; taken.has(id) || id === "default"; n++) id = `${base}-${n}`;
  return id;
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const key = (e: EngineDraft): string => JSON.stringify(e);

/** "zai · glm-5.3 · max" / "pi default" / "claude · sonnet" — the web twin of engineLabel. */
export function engineSummary(e: Pick<EngineDraft, "harness" | "provider" | "model" | "thinking">): string {
  if (e.harness === "claude") return `claude · ${e.model || "default"}`;
  return [e.provider, e.model || "pi default", e.thinking].filter(Boolean).join(" · ");
}

class EnginesStore {
  loaded = $state(false);
  loadFailed = $state(false);
  engines = $state<EngineDraft[]>([]);
  models = $state<CatalogModel[]>([]);
  claudeModels = $state<ClaudeModel[]>([]);
  settings = $state<{ maxWorkers: number; defaultEngine: string | null }>({ maxWorkers: 12, defaultEngine: null });
  private saved = $state<EngineDraft[]>([]);
  private savedSettings = $state<{ maxWorkers: number; defaultEngine: string | null }>({ maxWorkers: 12, defaultEngine: null });
  /** Ids created locally and not yet PUT. */
  private drafts = new Set<string>();

  get dirty(): boolean {
    if (this.settingsDirty) return true;
    if (this.engines.length !== this.saved.length) return true;
    return this.engines.some((e) => this.isDirty(e));
  }

  isDirty(e: EngineDraft): boolean {
    const s = this.saved.find((x) => x.id === e.id);
    return !s || key(s) !== key(e);
  }

  isDraft(id: string): boolean {
    return this.drafts.has(id);
  }

  get settingsDirty(): boolean {
    return (
      this.settings.maxWorkers !== this.savedSettings.maxWorkers || this.settings.defaultEngine !== this.savedSettings.defaultEngine
    );
  }

  /** Enabled seats across the registry — the honest ceiling under the board cap (the built-in default adds one when nothing else exists). */
  get totalSeats(): number {
    const seats = this.saved.filter((e) => e.enabled).reduce((n, e) => n + e.seats, 0);
    return this.settings.defaultEngine === null ? seats + 1 : seats;
  }

  revert(): void {
    this.engines = clone(this.saved);
    this.settings = { ...this.savedSettings };
    this.drafts.clear();
  }

  private fail(error: EdenError): void {
    const value = error.value as { error?: string } | undefined;
    board.error = value?.error ?? "request failed";
  }

  addDraft(name = "New engine"): EngineDraft {
    const taken = new Set(this.engines.map((e) => e.id));
    let n = name;
    for (let i = 2; this.engines.some((e) => e.name.toLowerCase() === n.toLowerCase()); i++) n = `${name} ${i}`;
    const draft: EngineDraft = { id: slugFor(n, taken), name: n, harness: "pi", provider: "", model: "", thinking: "", flags: [], seats: 1, enabled: true };
    this.drafts.add(draft.id);
    this.engines = [...this.engines, draft];
    return draft;
  }

  async load(): Promise<void> {
    this.loadFailed = false;
    const [res, models, claude] = await Promise.all([api.engines.get(), api["pi-models"].get(), api["claude-models"].get()]);
    if (res.error) {
      this.fail(res.error);
      this.loadFailed = true;
    } else {
      this.engines = res.data.engines.map(toDraft);
      this.settings = { ...res.data.settings };
      this.saved = clone(this.engines);
      this.savedSettings = { ...res.data.settings };
      this.drafts.clear();
      this.loaded = true;
    }
    if (!models.error) this.models = models.data.models;
    if (!claude.error) this.claudeModels = claude.data.models;
  }

  /** One engine's saved copy replaces its draft; other rows keep their unsaved edits. */
  private settle(e: EngineDraft): void {
    const idx = this.saved.findIndex((x) => x.id === e.id);
    const next = clone(e);
    if (idx === -1) this.saved = [...this.saved, next];
    else this.saved[idx] = next;
  }

  async save(e: EngineDraft): Promise<boolean> {
    const claude = e.harness === "claude";
    const { data, error } = await api.engines({ id: e.id }).put({
      name: e.name,
      harness: e.harness,
      provider: claude ? undefined : e.provider || undefined,
      model: e.model || undefined,
      thinking: claude ? undefined : ((e.thinking || undefined) as Engine["thinking"]),
      flags: e.flags.map((f) => f.trim()).filter(Boolean),
      seats: e.seats,
      enabled: e.enabled,
    });
    if (error) {
      this.fail(error);
      return false;
    }
    const saved = toDraft(data as Engine);
    const idx = this.engines.findIndex((x) => x.id === e.id);
    if (idx !== -1) this.engines[idx] = saved;
    this.drafts.delete(e.id);
    this.settle(saved);
    return true;
  }

  async remove(id: string): Promise<boolean> {
    if (!this.drafts.has(id)) {
      const { error } = await api.engines({ id }).delete();
      if (error) {
        this.fail(error);
        return false;
      }
    }
    this.drafts.delete(id);
    this.engines = this.engines.filter((e) => e.id !== id);
    this.saved = this.saved.filter((e) => e.id !== id);
    if (this.settings.defaultEngine === id) this.settings.defaultEngine = null;
    if (this.savedSettings.defaultEngine === id) this.savedSettings = { ...this.savedSettings, defaultEngine: null };
    return true;
  }

  /** Move one saved engine up/down the registry; persists immediately (order is display order). */
  async move(id: string, delta: -1 | 1): Promise<void> {
    const i = this.engines.findIndex((e) => e.id === id);
    const j = i + delta;
    if (i === -1 || j < 0 || j >= this.engines.length) return;
    const next = [...this.engines];
    [next[i], next[j]] = [next[j]!, next[i]!];
    this.engines = next;
    const ids = next.filter((e) => !this.drafts.has(e.id)).map((e) => e.id);
    const { error } = await api.engines.order.put({ ids });
    if (error) this.fail(error);
    else this.saved = ids.map((sid) => this.saved.find((s) => s.id === sid)!).filter(Boolean);
  }

  async saveSettings(): Promise<boolean> {
    const { data, error } = await api.engines.settings.put({ maxWorkers: this.settings.maxWorkers, defaultEngine: this.settings.defaultEngine });
    if (error) {
      this.fail(error);
      return false;
    }
    const res = data as { maxWorkers: number; defaultEngine: string | null };
    this.settings = { ...res };
    this.savedSettings = { ...res };
    return true;
  }
}

export const engines = new EnginesStore();
