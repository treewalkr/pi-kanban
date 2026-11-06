/** pi's model catalog, surfaced for the agents panel's provider/model selects. */

export interface CatalogModel {
  provider: string;
  id: string;
  context: string;
  maxOut: string;
  thinking: boolean;
  images: boolean;
  /** Set on rows a non-pi harness runs (the chat menu's Claude Code group); absent = pi. */
  harness?: "claude";
}

/**
 * Parse the six-column table `pi --list-models` prints. The provider column and
 * the last four columns (context, max-out, thinking, images) are single tokens,
 * but model ids may contain spaces (e.g. zcode's "Start Plan/GLM-5.2") — so
 * rows are parsed right-anchored and the middle tokens join back into the id.
 * Rows whose thinking/images cells aren't yes/no are malformed (pi changed its
 * column layout?) and are skipped rather than parsed into garbage fields.
 * Rows repeating a provider/id pair keep the first — pickers key options by
 * id, and duplicate ids crash their keyed {#each} blocks (Svelte
 * `each_key_duplicate`).
 */
export function parseModelsTable(text: string): CatalogModel[] {
  const out: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6 || cols[0] === "provider") continue;
    const [context, maxOut, thinking, images] = cols.slice(-4);
    if (!isYesNo(thinking) || !isYesNo(images)) continue;
    const id = cols.slice(1, -4).join(" ");
    const key = `${cols[0]}/${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      provider: cols[0],
      id,
      context,
      maxOut,
      thinking: thinking === "yes",
      images: images === "yes",
    });
  }
  return out;
}

function isYesNo(cell: string): boolean {
  return cell === "yes" || cell === "no";
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
export async function listChatModels(disabled: ReadonlySet<string> = new Set()): Promise<CatalogModel[]> {
  if (chatCache && Date.now() - chatCache.at < TTL_MS) return chatCache.models.filter((m) => !disabled.has(`${m.provider}:${m.id}`));
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
  return models.filter((m) => !disabled.has(`${m.provider}:${m.id}`));
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
