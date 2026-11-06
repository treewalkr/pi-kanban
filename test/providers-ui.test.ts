import { describe, expect, it } from "bun:test";
import {
  backendHint,
  causeLabel,
  checkedAgo,
  deriveHarnesses,
  deriveProviders,
  filterModels,
  type HarnessProbeRef,
  type ProviderEngineRef,
  type ProviderHealthRef,
  versionLabel,
} from "../web/src/lib/harnesses.svelte";
import type { CatalogModel } from "../src/models";

const NOW = 1_700_000_000_000;

function model(provider: string, id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { provider, id, context: "128K", maxOut: "32K", thinking: false, images: false, ...extra };
}

const CHAT = [model("zai", "glm-5.3"), model("zai", "glm-5.3-air"), model("deepseek", "deepseek-v4-pro")];
const PI = [model("zai", "glm-5.3"), model("zai", "glm-5.3-air", { context: "200K" }), model("antigravity", "gemini-3-pro")];

function engine(name: string, harness: string, provider?: string): ProviderEngineRef {
  return { name, harness, provider, enabled: true };
}

function health(account: string, coolingUntil?: number, lastCause?: string): ProviderHealthRef {
  return { account, ...(coolingUntil !== undefined ? { coolingUntil } : {}), ...(lastCause ? { lastCause } : {}) };
}

const PROBES: HarnessProbeRef[] = [
  { id: "pi", label: "pi agent", status: "ready", detail: "the board's own agent runtime — spawned by serve", models: [] },
  { id: "claude", label: "Claude Code", status: "ready", detail: "2.1.105 (Claude Code)", models: [{ id: "sonnet", label: "sonnet", note: "balanced" }] },
];

describe("deriveProviders (pi backends)", () => {
  it("orders chat-catalog providers first, pi-only after, and merges models chat-first", () => {
    const views = deriveProviders(PI, CHAT, [], [], NOW);
    expect(views.map((v) => v.id)).toEqual(["zai", "deepseek", "antigravity"]);
    const zai = views[0];
    expect(zai.models.map((m) => m.id)).toEqual(["glm-5.3", "glm-5.3-air"]);
    // the chat row wins for a shared id — the CLI's divergent context is dropped
    expect(zai.models[0].context).toBe("128K");
  });

  it("derives status: ok when chat-authed, unsigned when pi-only, cooling wins over both", () => {
    const act = [health("pi:zai", NOW + 60_000, "provider-quota")];
    const views = deriveProviders(PI, CHAT, [], act, NOW);
    expect(views.find((v) => v.id === "zai")?.status).toBe("cooling");
    expect(views.find((v) => v.id === "zai")?.coolingCause).toBe("provider-quota");
    expect(views.find((v) => v.id === "deepseek")?.status).toBe("ok");
    expect(views.find((v) => v.id === "antigravity")?.status).toBe("unsigned");
  });

  it("an expired cooldown is not cooling", () => {
    const views = deriveProviders(PI, CHAT, [], [health("pi:zai", NOW - 1)], NOW);
    expect(views.find((v) => v.id === "zai")?.status).toBe("ok");
  });

  it("lists the enabled pi engines whose provider matches; others never leak in", () => {
    const engines = [engine("zai main", "pi", "zai"), engine("zai off", "pi", "zai"), engine("claude sonnet", "claude"), engine("default", "pi")];
    const off = [...engines];
    off[1] = { ...off[1], enabled: false };
    const views = deriveProviders(PI, CHAT, off, [], NOW);
    expect(views.find((v) => v.id === "zai")?.engines).toEqual(["zai main"]);
  });

  it("dedupes models by id — first row wins", () => {
    const dup = [model("zai", "glm-5.3", { context: "1M" }), model("zai", "glm-5.3", { context: "128K" })];
    expect(deriveProviders([], dup, [], [], NOW)[0].models.map((m) => m.context)).toEqual(["1M"]);
  });
});

describe("deriveHarnesses", () => {
  it("one view per probe, engines joined by harness", () => {
    const engines = [engine("default", "pi"), engine("zai main", "pi", "zai"), engine("claude sonnet", "claude")];
    const views = deriveHarnesses(PROBES, PI, CHAT, engines, [], NOW);
    expect(views.map((v) => v.id)).toEqual(["pi", "claude"]);
    expect(views[0].engines).toEqual(["default", "zai main"]);
    expect(views[1].engines).toEqual(["claude sonnet"]);
  });

  it("a disabled model row is marked but stays listed; filter keeps the flag", () => {
    const views = deriveProviders(PI, CHAT, [], [], NOW, new Set(["zai:glm-5.3"]));
    const zai = views.find((v) => v.id === "zai")!;
    expect(zai.models.find((m) => m.id === "glm-5.3")?.disabled).toBe(true);
    expect(zai.models.find((m) => m.id === "glm-5.3-air")?.disabled).toBeUndefined();
    const shown = filterModels(zai.models, "glm");
    expect(shown.find((m) => m.id === "glm-5.3")?.disabled).toBe(true);
  });

  it("the master switch rides the probe and defaults to on; engines keep their own flags", () => {
    const engines = [engine("default", "pi"), engine("claude sonnet", "claude")];
    const views = deriveHarnesses(
      PROBES.map((p) => ({ ...p, ...(p.id === "claude" ? { enabled: false } : {}) })),
      PI,
      CHAT,
      engines,
      [],
      NOW,
    );
    expect(views[0].enabled).toBe(true);
    expect(views[1].enabled).toBe(false);
    expect(views[1].allEngines[0].enabled).toBe(true); // engine rows untouched by the switch
  });

  it("allEngines keeps disabled ones out of the chips but in the toggle's reach", () => {
    const engines = [engine("default", "pi"), engine("zai main", "pi", "zai"), engine("claude sonnet", "claude")];
    engines[1] = { ...engines[1], enabled: false };
    const views = deriveHarnesses(PROBES, PI, CHAT, engines, [], NOW);
    expect(views[0].engines).toEqual(["default"]);
    expect(views[0].allEngines).toEqual([
      { name: "default", enabled: true },
      { name: "zai main", enabled: false },
    ]);
  });

  it("pi nests the LLM vendors as backends; claude carries aliases instead", () => {
    const views = deriveHarnesses(PROBES, PI, CHAT, [], [], NOW);
    expect(views[0].backends.map((b) => b.id)).toEqual(["zai", "deepseek", "antigravity"]);
    expect(views[0].models).toEqual([]);
    expect(views[1].backends).toEqual([]);
    expect(views[1].models).toEqual([{ id: "sonnet", label: "sonnet", note: "balanced" }]);
  });

  it("claude cools as a harness; pi stays ready and reports the cooling account", () => {
    const act = [health("claude:", NOW + 60_000, "claude-quota"), health("pi:zai", NOW + 60_000, "provider-quota")];
    const views = deriveHarnesses(PROBES, PI, CHAT, [], act, NOW);
    expect(views[1].status).toBe("cooling");
    expect(views[1].cooling[0].account).toBe("claude:");
    expect(views[0].status).toBe("ready");
    expect(views[0].cooling.map((c) => c.account)).toEqual(["pi:zai"]);
    // and the pi backend itself flips to cooling
    expect(views[0].backends.find((b) => b.id === "zai")?.status).toBe("cooling");
  });

  it("a missing probe stays missing and an expired cooldown never cools", () => {
    const probes = [PROBES[0], { ...PROBES[1], status: "missing" as const, detail: "claude binary not on PATH" }];
    const views = deriveHarnesses(probes, PI, CHAT, [], [health("claude:", NOW - 1)], NOW);
    expect(views[1].status).toBe("missing");
    expect(views[1].cooling).toEqual([]);
  });

  it("cooldowns only match the harness's own accounts", () => {
    const views = deriveHarnesses(PROBES, PI, CHAT, [], [health("codex:x", NOW + 60_000)], NOW);
    expect(views.every((v) => v.cooling.length === 0)).toBe(true);
  });
});

describe("filterModels", () => {
  const models = [model("zai", "glm-5.3"), model("zai", "glm-5.3-air"), model("zai", "glm-4.7-flash")];
  it("matches case-insensitively on the id", () => {
    expect(filterModels(models, "AIR").map((m) => m.id)).toEqual(["glm-5.3-air"]);
  });
  it("an empty or blank query shows everything", () => {
    expect(filterModels(models, "  ")).toHaveLength(3);
  });
});

describe("checkedAgo", () => {
  it("never checked, just now, minutes, hours", () => {
    expect(checkedAgo(null, NOW)).toBe("not checked yet");
    expect(checkedAgo(NOW - 30_000, NOW)).toBe("just now");
    expect(checkedAgo(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(checkedAgo(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
  });
});

describe("causeLabel", () => {
  it("humanizes dashed causes", () => {
    expect(causeLabel("provider-quota")).toBe("provider quota");
    expect(causeLabel(undefined)).toBe("provider incident");
  });
});

describe("backendHint", () => {
  it("an authed backend stays quiet", () => {
    expect(backendHint({ id: "zai", status: "ok", models: [], engines: [] })).toBeNull();
  });

  it("unsigned points at pi's /login slash command — the CLI has no auth login verb", () => {
    const segs = backendHint({ id: "zai", status: "unsigned", models: [], engines: [] })!;
    expect(segs.some((s) => s.code && s.text === "/login zai")).toBe(true);
    expect(segs.map((s) => s.text).join("")).not.toContain("pi auth login");
  });

  it("cooling names the cause and the wait", () => {
    const segs = backendHint({ id: "zai", status: "cooling", models: [], engines: [], coolingUntil: NOW + 60_000, coolingCause: "provider-quota" })!;
    const line = segs.map((s) => s.text).join("");
    expect(line).toContain("provider quota");
    expect(line).toContain("engines on it wait");
  });
});

describe("versionLabel", () => {
  it("v-prefixes a version-leading detail, first word only", () => {
    expect(versionLabel("2.1.318 (Claude Code)")).toBe("v2.1.318");
  });
  it("prose details carry no version chip", () => {
    expect(versionLabel("the board's own agent runtime")).toBeNull();
    expect(versionLabel("claude binary not on PATH — install with npm i -g @anthropic-ai/claude-code")).toBeNull();
  });
  it("views carry the chip: claude yes, pi no", () => {
    const views = deriveHarnesses(PROBES, PI, CHAT, [], [], NOW);
    expect(views[0].version).toBeNull();
    expect(views[1].version).toBe("v2.1.105");
    const versioned = deriveHarnesses([{ ...PROBES[1], detail: "2.1.105 (Claude Code)" }], [], [], [], [], NOW);
    expect(versioned[0].version).toBe("v2.1.105");
  });
});
