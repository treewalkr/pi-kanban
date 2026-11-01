/** pi's model catalog, surfaced for the agents panel's provider/model selects. */

export interface CatalogModel {
  provider: string;
  id: string;
  context: string;
  maxOut: string;
  thinking: boolean;
  images: boolean;
}

/** Parse the fixed six-column table `pi --list-models` prints (every cell is one token). */
export function parseModelsTable(text: string): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6 || cols[0] === "provider") continue;
    out.push({
      provider: cols[0],
      id: cols[1],
      context: cols[2],
      maxOut: cols[3],
      thinking: cols[4] === "yes",
      images: cols[5] === "yes",
    });
  }
  return out;
}

const TTL_MS = 10 * 60_000;
let cache: { at: number; models: CatalogModel[] } | null = null;
let chatCache: { at: number; models: CatalogModel[] } | null = null;

/** Runs `pi --list-models` (cached); resolves to [] when pi is missing or fails. */
export async function listPiModels(): Promise<CatalogModel[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.models;
  try {
    const proc = Bun.spawn(["pi", "--list-models"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    cache = { at: Date.now(), models: code === 0 ? parseModelsTable(text) : [] };
  } catch {
    cache = { at: Date.now(), models: [] };
  }
  return cache.models;
}

/**
 * The chat-runtime catalog: models a chat session can actually run. `pi
 * --list-models` shows the CLI world, which includes extension-registered
 * providers (e.g. npm:pi-antigravity) that a chat session — deliberately
 * `noExtensions` — can never resolve, so the picker must not offer them.
 * Filters the runtime catalog to providers with configured auth.
 */
export async function listChatModels(): Promise<CatalogModel[]> {
  if (chatCache && Date.now() - chatCache.at < TTL_MS) return chatCache.models;
  let models: CatalogModel[] = [];
  try {
    // same runtime construction chat sessions use (sdk.js: authPath + modelsPath
    // under the pi agent dir, no extension providers)
    const { ModelRuntime, getAgentDir } = await import("@earendil-works/pi-coding-agent");
    const agentDir = getAgentDir();
    const runtime = await ModelRuntime.create({
      authPath: `${agentDir}/auth.json`,
      modelsPath: `${agentDir}/models.json`,
    });
    models = runtimeModelsToCatalog(runtime.getModels() as unknown as RuntimeModelLike[], (p) => runtime.hasConfiguredAuth(p));
  } catch {
    models = []; // a failed runtime must not break the picker (chip still shows the live model)
  }
  chatCache = { at: Date.now(), models };
  return models;
}

type RuntimeModelLike = {
  provider: string;
  id: string;
  contextWindow?: unknown;
  maxTokens?: unknown;
  reasoning?: unknown;
  input?: unknown;
};

/** Map runtime models to the catalog shape: authed providers only, stable
 *  provider order (first appearance), runtime order within a provider,
 *  deduped by id. Pure — unit-testable without a real runtime. */
export function runtimeModelsToCatalog(
  models: RuntimeModelLike[],
  isAuthed: (provider: string) => boolean,
): CatalogModel[] {
  const byProvider = new Map<string, CatalogModel[]>();
  for (const m of models) {
    if (!isAuthed(m.provider)) continue;
    const list = byProvider.get(m.provider) ?? [];
    if (!list.some((entry) => entry.id === m.id)) {
      list.push({
        provider: m.provider,
        id: m.id,
        context: formatTokens(m.contextWindow),
        maxOut: formatTokens(m.maxTokens),
        thinking: Boolean(m.reasoning),
        images: Array.isArray(m.input) && (m.input as string[]).includes("image"),
      });
    }
    byProvider.set(m.provider, list);
  }
  return [...byProvider.values()].flat();
}

function formatTokens(n: unknown): string {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}K`;
  return String(v);
}
