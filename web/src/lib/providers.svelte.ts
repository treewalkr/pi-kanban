import { api } from "../api";
import type { CatalogModel } from "../../../src/models";

/**
 * Read-only providers browser (Settings → Providers). A provider's status is
 * derived from three live feeds: pi's CLI catalog (`/pi-models`), the chat
 * runtime's authed catalog (`/chat-models`), and per-account engine health
 * (`/activity`). Nothing here writes: auth belongs to pi, model config to engines.
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
 * One row per provider the board can see. Chat-catalog providers come first (in
 * catalog order), then pi-only providers by name. Models merge chat-first, so a
 * model the chat runtime serves replaces the CLI's row for the same id. Status:
 * `ok` = the chat runtime has it authed, `unsigned` = only the pi CLI knows it,
 * `cooling` = a `pi:<provider>` account is cooling right now (wins over both).
 * Pure — the store and the unit suite share it.
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

class ProvidersStore {
  loaded = $state(false);
  /** The last fetch failed: pre-load the panel shows a retry, post-load a banner. */
  loadFailed = $state(false);
  loading = $state(false);
  list = $state<ProviderView[]>([]);
  checkedAt = $state<number | null>(null);
  selected = $state<string | null>(null);
  filter = $state("");

  private inFlight: Promise<void> | null = null;

  load(): Promise<void> {
    return this.refresh();
  }

  /** Re-read all four feeds at once; concurrent calls share one request round. */
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
      const [pi, chat, eng, act] = await Promise.all([
        api["pi-models"].get(),
        api["chat-models"].get(),
        api.engines.get(),
        api.activity.get(),
      ]);
      // the two catalogs are the rail itself: without them there is nothing to show
      if (pi.error || chat.error) {
        this.loadFailed = true;
        return;
      }
      const list = deriveProviders(
        pi.data.models,
        chat.data.models,
        eng.error ? [] : eng.data.engines,
        act.error ? [] : act.data.engines,
        Date.now(),
      );
      this.list = list;
      this.checkedAt = Date.now();
      this.loadFailed = false;
      this.loaded = true;
      const kept = this.selected !== null && list.some((p) => p.id === this.selected);
      this.selected = kept ? this.selected : (list[0]?.id ?? null);
    } finally {
      this.loading = false;
    }
  }

  select(id: string | null): void {
    if (id === this.selected) return;
    this.selected = id;
    this.filter = ""; // another provider's filter must not hide this catalog
  }
}

export const providers = new ProvidersStore();
