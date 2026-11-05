import type { AgentRole, AgentThinking, Engine, KanbanDb } from "./db";

/**
 * Engines + lineups (the one rule for "what runs this actor"). An actor's
 * lineup is chosen atomically — the first layer that sets one wins, whole:
 *
 *   KANBAN_ENGINE env pin → project override (runsOn) → actor config (runsOn) → board default engine
 *
 * Nothing merges field by field: provider/model/thinking come from exactly one
 * engine. At spawn the allocator walks the lineup and takes the first enabled,
 * non-cooling engine with a free seat; later entries are fallbacks.
 */

/** The built-in default when no board default engine is set: pi's own settings, one seat (the old serial default slot). */
export const DEFAULT_ENGINE_ID = "default";

export function builtinDefaultEngine(): Engine {
  return { id: DEFAULT_ENGINE_ID, name: "pi default", harness: "pi", flags: [], seats: 1, enabled: true, updatedAt: 0 };
}

export type LineupSource = "env" | "project" | "actor" | "default";

export interface Lineup {
  engines: Engine[];
  source: LineupSource;
  /** Engine refs the winning layer named that no longer resolve (an env pin to an unknown engine). */
  missing: string[];
}

/** The board default engine: the configured one, or the built-in pi default. */
export function defaultEngine(db: KanbanDb): Engine {
  const id = db.defaultEngineId();
  return (id && db.engine(id)) || builtinDefaultEngine();
}

/** Look an engine up by id or (case-insensitive) name — the CLI and env pin accept either. */
export function findEngine(db: KanbanDb, ref: string): Engine | null {
  const r = ref.trim();
  if (!r) return null;
  if (r === DEFAULT_ENGINE_ID) return defaultEngine(db);
  return db.engine(r) ?? db.engines().find((e) => e.name.toLowerCase() === r.toLowerCase()) ?? null;
}

export function resolveLineup(db: KanbanDb, actor: AgentRole, project?: string, env: NodeJS.ProcessEnv = process.env): Lineup {
  const pin = env.KANBAN_ENGINE?.trim();
  if (pin) {
    const e = findEngine(db, pin);
    return e ? { engines: [e], source: "env", missing: [] } : { engines: [], source: "env", missing: [pin] };
  }
  const fromIds = (ids: string[]): Engine[] => ids.map((id) => db.engine(id)).filter((e): e is Engine => e !== null);
  if (project) {
    const ov = db.projectAgentConfig(project, actor)?.runsOn;
    if (ov && ov.length > 0) {
      const engines = fromIds(ov);
      if (engines.length > 0) return { engines, source: "project", missing: [] };
    }
  }
  const own = db.agentConfig(actor)?.runsOn;
  if (own && own.length > 0) {
    const engines = fromIds(own);
    if (engines.length > 0) return { engines, source: "actor", missing: [] };
  }
  return { engines: [defaultEngine(db)], source: "default", missing: [] };
}

/** Roles that think at max when their (pi) engine leaves thinking unset — the pre-engines role default. */
const DEEP_ROLES: ReadonlySet<string> = new Set(["reviewer", "planner", "plan-reviewer"]);

/** The thinking level a pi spawn passes, or the claude engine's `--effort` (no role default: unset = claude's own). */
export function effectiveThinking(role: AgentRole, engine: Engine): AgentThinking | undefined {
  if (engine.harness !== "pi") return engine.thinking || undefined;
  return engine.thinking || (DEEP_ROLES.has(role) ? "max" : undefined);
}

/** "zai · glm-5.3 · max" / "pi default" / "claude · sonnet" */
export function engineLabel(engine: Engine, role?: AgentRole): string {
  if (engine.harness === "claude") return ["claude", engine.model || "default", engine.thinking].filter(Boolean).join(" · ");
  const thinking = role ? effectiveThinking(role, engine) : engine.thinking;
  return [engine.provider, engine.model || "pi default", thinking].filter(Boolean).join(" · ");
}

/** The account a provider-level incident (quota, auth) exhausts: every engine on it cools together. */
export function accountKey(engine: Engine): string {
  return `${engine.harness}:${engine.provider ?? ""}`;
}

/** Chat sessions run in-process on pi's SDK without extensions — only pi engines on an authed chat provider qualify. */
export function chatCapable(engine: Engine, chatProviders: ReadonlySet<string>): boolean {
  return engine.harness === "pi" && engine.enabled && (!engine.provider || chatProviders.has(engine.provider));
}

/** Live seat/health view the explain output can consult (the loop supplies it; static callers omit it). */
export interface SeatView {
  busy(engine: Engine): number;
  coolingUntil(engine: Engine): number | null;
}

export interface ExplainStep {
  engine: Engine;
  status: "ready" | "full" | "cooling" | "disabled";
  detail: string;
}

export interface Explanation {
  actor: string;
  project?: string;
  source: LineupSource;
  /** Every layer, in precedence order, with what it holds ("—" when unset). */
  layers: Array<{ layer: LineupSource; value: string; wins: boolean }>;
  steps: ExplainStep[];
  /** The engine the next spawn takes, or null when the whole lineup is unavailable. */
  next: Engine | null;
  missing: string[];
}

const SOURCE_LABEL: Record<LineupSource, string> = {
  env: "env pin KANBAN_ENGINE",
  project: "project override",
  actor: "actor lineup",
  default: "board default engine",
};

export function explain(db: KanbanDb, actor: AgentRole, project?: string, view?: SeatView, now: number = Date.now()): Explanation {
  const lineup = resolveLineup(db, actor, project);
  const names = (ids: string[] | undefined) =>
    ids && ids.length > 0 ? ids.map((id) => db.engine(id)?.name ?? `${id}?`).join(" → ") : "—";
  const pin = process.env.KANBAN_ENGINE?.trim();
  const layers: Explanation["layers"] = [
    { layer: "env", value: pin || "—", wins: lineup.source === "env" },
    { layer: "project", value: project ? names(db.projectAgentConfig(project, actor)?.runsOn) : "—", wins: lineup.source === "project" },
    { layer: "actor", value: names(db.agentConfig(actor)?.runsOn), wins: lineup.source === "actor" },
    { layer: "default", value: defaultEngine(db).name, wins: lineup.source === "default" },
  ];
  const steps: ExplainStep[] = [];
  let next: Engine | null = null;
  for (const engine of lineup.engines) {
    let step: ExplainStep;
    const until = view?.coolingUntil(engine) ?? null;
    const busy = view?.busy(engine) ?? 0;
    if (!engine.enabled) step = { engine, status: "disabled", detail: "disabled" };
    else if (until !== null && until > now) {
      step = { engine, status: "cooling", detail: `cooling ${Math.max(1, Math.round((until - now) / 60_000))} min (${accountKey(engine)})` };
    } else if (busy >= engine.seats) step = { engine, status: "full", detail: `${busy}/${engine.seats} seats busy` };
    else step = { engine, status: "ready", detail: `${busy}/${engine.seats} seats busy` };
    if (!next && step.status === "ready") next = engine;
    steps.push(step);
  }
  return { actor, ...(project ? { project } : {}), source: lineup.source, layers, steps, next, missing: lineup.missing };
}

/** The `kanban explain` text: winning layer, every layer, the walk, and the next spawn. */
export function formatExplanation(x: Explanation, role: AgentRole = x.actor): string {
  const lines = [`${x.actor}${x.project ? ` @ ${x.project}` : ""} — lineup from ${SOURCE_LABEL[x.source]}`];
  for (const l of x.layers) lines.push(`  ${l.wins ? "▸" : " "} ${SOURCE_LABEL[l.layer].padEnd(22)} ${l.value}`);
  if (x.missing.length > 0) lines.push(`  ✗ unknown engine ${x.missing.join(", ")} — nothing can spawn until the pin names an engine`);
  x.steps.forEach((s, i) => {
    lines.push(`  ${i + 1}. ${s.engine.name.padEnd(24)} ${engineLabel(s.engine, role).padEnd(40)} ${s.status}${s.detail && s.detail !== s.status ? ` · ${s.detail}` : ""}`);
  });
  lines.push(x.next ? `  next spawn → ${x.next.name} (${engineLabel(x.next, role)})` : "  next spawn → waits (every engine in the lineup is full, cooling, or disabled)");
  return lines.join("\n");
}
