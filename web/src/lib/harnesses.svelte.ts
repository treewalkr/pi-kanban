import { api } from "../api";
import { engines } from "./engines.svelte";
import type { CatalogModel } from "../../../src/models";

/**
 * Read-only harness browser (Settings → Providers). A provider is a harness
 * runtime the board spawns agents on — pi, Claude Code, more later — never an
 * LLM vendor. The rail lists harnesses from `/harnesses`; engine usage comes
 * from `/engines`, per-account cooldowns from `/activity`, and the LLM vendors
 * that back pi engines collapse into the pi harness's backends section (fed by
 * `/pi-models` + `/chat-models`). Nothing here writes: auth belongs to each
 * harness, model config to Engines.
 */

export type ProviderStatusKey = "ok" | "unsigned" | "cooling";

export interface ProviderView {
  id: string;
  status: ProviderStatusKey;
  models: CatalogModel[];
  /** Names of the enabled pi engines whose provider is this one. */
  engines: string[];
  coolingUntil?: number;
  coolingCause?: string;
}

export type HarnessStatusKey = "ready" | "cooling" | "missing";

export interface HarnessModel {
  id: string;
  label: string;
  note: string;
}

export interface HarnessView {
  id: string;
  label: string;
  status: HarnessStatusKey;
  /** Version or install hint from the probe. */
  detail: string;
  /** Short chip form of the probe's version ("v2.1.318"), when it has one. */
  version: string | null;
  /** Enabled engines that run on this harness. */
  engines: string[];
  /** Every engine on this harness, enabled or not — the toggle flips them all. */
  allEngines: { name: string; enabled: boolean }[];
  /** Master switch from board_state — gates spawning for every engine on the harness. */
  enabled: boolean;
  /** Live cooldowns on this harness's accounts (`<harness>:<account>`). */
  cooling: Array<{ account: string; until: number; cause?: string }>;
  /** pi only: the LLM vendors its engines may run on, nested per backend. */
  backends: ProviderView[];
  /** claude only: the model aliases the engine editor may reference. */
  models: HarnessModel[];
}

/** The engine fields the derivation reads (a saved engine satisfies this). */
export interface ProviderEngineRef {
  name: string;
  provider?: string;
  harness: string;
  enabled: boolean;
}

/** The engine-health fields the derivation reads (`EngineHealthSummary`). */
export interface ProviderHealthRef {
  account: string;
  coolingUntil?: number;
  lastCause?: string;
}

/** The probe fields the derivation reads (`HarnessProbe` from `/harnesses`). */
export interface HarnessProbeRef {
  id: string;
  label: string;
  status: "ready" | "missing";
  detail: string;
  models: HarnessModel[];
  /** Master switch from board_state (absent = on). */
  enabled?: boolean;
}

/** t3code's FILTER_THRESHOLD: a catalog longer than this gets the filter box. */
export const FILTER_THRESHOLD = 8;

/** First row per model id wins — catalog order is the display order. */
function dedupeById(models: CatalogModel[]): CatalogModel[] {
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const m of models) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

function providerIds(models: CatalogModel[]): string[] {
  const out: string[] = [];
  for (const m of models) if (!out.includes(m.provider)) out.push(m.provider);
  return out;
}

/**
 * One row per LLM vendor the pi harness can see (pi's backends section). Chat-
 * catalog providers come first (in catalog order), then pi-only providers by
 * name. Models merge chat-first. Status: `ok` = the chat runtime has it authed,
 * `unsigned` = only the pi CLI knows it, `cooling` = a `pi:<provider>` account
 * is cooling right now (wins over both). Pure — the store and suite share it.
 */
export function deriveProviders(
  piModels: CatalogModel[],
  chatModels: CatalogModel[],
  engines: ProviderEngineRef[],
  activity: ProviderHealthRef[],
  now: number,
): ProviderView[] {
  const chatProviders = providerIds(chatModels);
  const piOnly = providerIds(piModels)
    .filter((p) => !chatProviders.includes(p))
    .sort((a, b) => a.localeCompare(b));

  return [...chatProviders, ...piOnly].map((id) => {
    const chat = dedupeById(chatModels.filter((m) => m.provider === id));
    const inChat = new Set(chat.map((m) => m.id));
    const cli = dedupeById(piModels.filter((m) => m.provider === id && !inChat.has(m.id)));
    const health = activity.find((a) => a.account === `pi:${id}` && a.coolingUntil !== undefined && now < a.coolingUntil);
    const view: ProviderView = {
      id,
      status: health ? "cooling" : chat.length > 0 ? "ok" : "unsigned",
      models: [...chat, ...cli],
      // claude engines have no pi provider, and the built-in default engine has none at all
      engines: engines.filter((e) => e.enabled && e.harness === "pi" && e.provider === id).map((e) => e.name),
    };
    if (health) {
      view.coolingUntil = health.coolingUntil;
      if (health.lastCause) view.coolingCause = health.lastCause;
    }
    return view;
  });
}

/**
 * The rail: one view per harness probe. Engine usage joins by `harness`; pi's
 * backends nest the vendor derivation; a harness cools when an account on it
 * cools and it has no fallback (claude has exactly one account — pi stays
 * ready, its cooling shows per backend). Pure — the store and suite share it.
 */
export function deriveHarnesses(
  probes: HarnessProbeRef[],
  piModels: CatalogModel[],
  chatModels: CatalogModel[],
  engines: ProviderEngineRef[],
  activity: ProviderHealthRef[],
  now: number,
): HarnessView[] {
  return probes.map((probe) => {
    const own = engines.filter((e) => e.enabled && e.harness === probe.id);
    const all = engines.filter((e) => e.harness === probe.id);
    const prefix = `${probe.id}:`;
    const cooling = activity
      .filter((a) => a.account.startsWith(prefix) && a.coolingUntil !== undefined && now < a.coolingUntil)
      .map((a) => ({ account: a.account, until: a.coolingUntil as number, ...(a.lastCause ? { cause: a.lastCause } : {}) }));
    return {
      id: probe.id,
      label: probe.label,
      // claude has one ambient account: a cooldown on it throttles the whole harness
      status: probe.status === "missing" ? "missing" : probe.id !== "pi" && cooling.length > 0 ? "cooling" : "ready",
      detail: probe.detail,
      version: versionLabel(probe.detail),
      engines: own.map((e) => e.name),
      allEngines: all.map((e) => ({ name: e.name, enabled: e.enabled })),
      enabled: probe.enabled !== false,
      cooling,
      backends: probe.id === "pi" ? deriveProviders(piModels, chatModels, engines, activity, now) : [],
      models: probe.models,
    };
  });
}

/** Filter box predicate: case-insensitive substring on the model id. */
export function filterModels(models: CatalogModel[], query: string): CatalogModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter((m) => m.id.toLowerCase().includes(q));
}

/** "just now" / "N min ago" / "Nh ago" — recomputed on a tick, never by refetching. */
export function checkedAgo(checkedAt: number | null, now: number): string {
  if (checkedAt === null) return "not checked yet";
  const ms = Math.max(0, now - checkedAt);
  if (ms < 45_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${Math.max(1, mins)} min ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

/** Short human form of an incident cause for the cooling line ("provider-quota" → "provider quota"). */
export function causeLabel(cause: string | undefined): string {
  return cause ? cause.replace(/-/g, " ") : "provider incident";
}

/** One span of a hint line; `code` renders as an inline command. */
export interface DetailSegment {
  text: string;
  code?: boolean;
}

function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** t3code's version chip: `v`-prefixed when the detail leads with a digit, first word only. */
export function versionLabel(detail: string): string | null {
  if (!/^\d/.test(detail)) return null;
  return `v${detail.split(/\s/)[0]}`;
}

/**
 * The short line under a pi backend's header. The copy lives here rather than
 * in the component so the suite can pin the command it tells users to run:
 * signing in is pi's `/login <provider>` slash command — the pi CLI has no
 * `auth login` verb (only `print-api-key`, `print-bearer-token`, `check`).
 * Authed backends stay quiet; there is nothing to do.
 */
export function backendHint(view: ProviderView): DetailSegment[] | null {
  if (view.status === "ok") return null;
  if (view.status === "unsigned") {
    return [{ text: "not signed in — run " }, { text: `/login ${view.id}`, code: true }, { text: " in a pi session, then refresh" }];
  }
  const cause = causeLabel(view.coolingCause);
  return [{ text: `cooling · ${cause} until ${timeOf(view.coolingUntil ?? 0)} — engines on it wait` }];
}

class HarnessStore {
  loaded = $state(false);
  /** The last fetch failed: pre-load the panel shows a retry, post-load a banner. */
  loadFailed = $state(false);
  loading = $state(false);
  list = $state<HarnessView[]>([]);
  checkedAt = $state<number | null>(null);
  selected = $state<string | null>(null);
  filter = $state("");
  /** Harness id with a switch write in flight (the rail shows it, double-clicks are ignored). */
  toggling = $state<string | null>(null);
  /** Harness id whose last toggle failed, cleared by the next success or refresh. */
  toggleFailed = $state<string | null>(null);

  private inFlight: Promise<void> | null = null;

  load(): Promise<void> {
    return this.refresh();
  }

  /** Re-read every feed at once; concurrent calls share one request round. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchAll().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchAll(): Promise<void> {
    this.loading = true;
    try {
      const [h, pi, chat, eng, act] = await Promise.all([
        api.harnesses.get(),
        api["pi-models"].get(),
        api["chat-models"].get(),
        api.engines.get(),
        api.activity.get(),
      ]);
      // the harness probes are the rail itself: without them there is nothing to show
      if (h.error) {
        this.loadFailed = true;
        return;
      }
      const list = deriveHarnesses(
        h.data.harnesses,
        pi.error ? [] : pi.data.models,
        chat.error ? [] : chat.data.models,
        eng.error ? [] : eng.data.engines,
        act.error ? [] : act.data.engines,
        Date.now(),
      );
      this.list = list;
      this.checkedAt = Date.now();
      this.loadFailed = false;
      this.loaded = true;
      const kept = this.selected !== null && list.some((x) => x.id === this.selected);
      this.selected = kept ? this.selected : (list[0]?.id ?? null);
      if (this.selected !== null) this.filter = ""; // a stale filter must not hide the next harness's catalog
    } finally {
      this.loading = false;
    }
  }

  select(id: string | null): void {
    if (id === this.selected) return;
    this.selected = id;
    this.filter = ""; // another harness's filter must not hide this catalog
  }

  /** Truth changed elsewhere; the next tab visit refetches instead of trusting this cache. */
  invalidate(): void {
    this.loaded = false;
  }

  /**
   * The harness master switch — one board_state flag, not a bulk engine flip:
   * engine rows keep their own `enabled` untouched and re-appear exactly as
   * they were when the harness comes back on.
   */
  async toggle(id: string, enabled: boolean): Promise<void> {
    if (this.toggling !== null) return;
    this.toggling = id;
    try {
      const { error } = await api.harnesses({ id }).enabled.put({ enabled });
      this.toggleFailed = error ? id : null;
      await this.refresh();
      if (!error) engines.invalidate(); // the Engines tab gates its harness selector on the flag
    } finally {
      this.toggling = null;
    }
  }
}

export const harnesses = new HarnessStore();
