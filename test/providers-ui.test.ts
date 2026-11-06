import { describe, expect, test } from "bun:test";
import type { CatalogModel } from "../src/models";
import {
  causeLabel,
  checkedAgo,
  deriveProviders,
  FILTER_THRESHOLD,
  filterModels,
  statusDetail,
  type ProviderEngineRef,
  type ProviderHealthRef,
  type ProviderView,
} from "../web/src/lib/providers.svelte";

const model = (provider: string, id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  provider,
  id,
  context: "128k",
  maxOut: "8k",
  thinking: false,
  images: false,
  ...extra,
});

const engine = (name: string, provider: string | undefined, over: Partial<ProviderEngineRef> = {}): ProviderEngineRef => ({
  name,
  provider,
  harness: "pi",
  enabled: true,
  ...over,
});

const NOW = 1_800_000_000_000;

describe("deriveProviders", () => {
  test("chat providers come first in catalog order, pi-only providers after, name-sorted", () => {
    const pi = [model("zai", "glm-5"), model("antigravity", "gemini-3"), model("deepseek", "deepseek-v4")];
    const chat = [model("deepseek", "deepseek-v4"), model("zai", "glm-5")];

    const out = deriveProviders(pi, chat, [], [], NOW);

    // deepseek/zai are authed (chat order), antigravity is CLI-only
    expect(out.map((p) => p.id)).toEqual(["deepseek", "zai", "antigravity"]);
    expect(out.map((p) => p.status)).toEqual(["ok", "ok", "unsigned"]);
  });

  test("models dedupe by id per provider, the chat catalog's row winning", () => {
    const pi = [
      model("zai", "glm-5", { context: "64k", thinking: true }),
      model("zai", "glm-5-air", { context: "32k" }),
    ];
    const chat = [model("zai", "glm-5", { context: "200k", images: true })];

    const [zai] = deriveProviders(pi, chat, [], [], NOW);

    expect(zai.models.map((m) => m.id)).toEqual(["glm-5", "glm-5-air"]);
    expect(zai.models[0].context).toBe("200k"); // chat entry, not the CLI's 64k
    expect(zai.models[0].images).toBe(true);
    expect(zai.models[1].context).toBe("32k"); // pi-only row survives
  });

  test("engines list enabled pi engines on the provider; claude, disabled and providerless engines never match", () => {
    const pi = [model("zai", "glm-5")];
    const engines = [
      engine("GLM flash", "zai"),
      engine("GLM deep", "zai"),
      engine("disabled", "zai", { enabled: false }),
      engine("claude sonnet", undefined, { harness: "claude" }),
      engine("claude with provider", "zai", { harness: "claude" }),
      engine("pi default", undefined),
    ];

    const [zai] = deriveProviders(pi, [], engines, [], NOW);

    expect(zai.status).toBe("unsigned");
    expect(zai.engines).toEqual(["GLM flash", "GLM deep"]);
  });

  test("cooling wins over authed status while the cooldown is live, and carries its cause", () => {
    const pi = [model("zai", "glm-5")];
    const chat = [model("zai", "glm-5")];
    const activity: ProviderHealthRef[] = [{ account: "pi:zai", coolingUntil: NOW + 60_000, lastCause: "provider-quota" }];

    const [zai] = deriveProviders(pi, chat, [], activity, NOW);

    expect(zai.status).toBe("cooling");
    expect(zai.coolingUntil).toBe(NOW + 60_000);
    expect(zai.coolingCause).toBe("provider-quota");
  });

  test("an expired cooldown and another harness's account leave the status alone", () => {
    const pi = [model("zai", "glm-5")];
    const chat = [model("zai", "glm-5")];
    const activity: ProviderHealthRef[] = [
      { account: "pi:zai", coolingUntil: NOW - 1, lastCause: "provider-quota" }, // expired at NOW
      { account: "claude:zai", coolingUntil: NOW + 60_000, lastCause: "auth" }, // not pi's account
    ];

    const [zai] = deriveProviders(pi, chat, [], activity, NOW);

    expect(zai.status).toBe("ok");
    expect(zai.coolingUntil).toBeUndefined();
    expect(zai.coolingCause).toBeUndefined();
  });

  test("empty catalogs yield an empty rail", () => {
    expect(deriveProviders([], [], [], [], NOW)).toEqual([]);
  });
});

describe("filterModels", () => {
  test("matches a case-insensitive substring of the model id; blank returns the catalog untouched", () => {
    const models = [model("zai", "GLM-5"), model("zai", "glm-5-air"), model("zai", "sonnet-4")];

    expect(filterModels(models, "glm").map((m) => m.id)).toEqual(["GLM-5", "glm-5-air"]);
    expect(filterModels(models, "AIR").map((m) => m.id)).toEqual(["glm-5-air"]);
    expect(filterModels(models, "  ")).toBe(models);
    expect(filterModels(models, "nothing")).toEqual([]);
    expect(FILTER_THRESHOLD).toBe(8); // t3code's threshold, pinned
  });
});

describe("checkedAgo", () => {
  test("just now under 45s, minutes under an hour, hours after", () => {
    expect(checkedAgo(NOW, NOW)).toBe("just now");
    expect(checkedAgo(NOW - 44_999, NOW)).toBe("just now");
    expect(checkedAgo(NOW - 45_000, NOW)).toBe("1 min ago");
    expect(checkedAgo(NOW - 60_000, NOW)).toBe("1 min ago");
    expect(checkedAgo(NOW - 59 * 60_000, NOW)).toBe("59 min ago");
    expect(checkedAgo(NOW - 60 * 60_000, NOW)).toBe("1h ago");
    expect(checkedAgo(NOW - 5 * 3_600_000, NOW)).toBe("5h ago");
    expect(checkedAgo(null, NOW)).toBe("not checked yet");
  });
});

describe("causeLabel", () => {
  test("humanizes an incident cause and falls back when it is missing", () => {
    expect(causeLabel("provider-quota")).toBe("provider quota");
    expect(causeLabel("auth")).toBe("auth");
    expect(causeLabel(undefined)).toBe("provider incident");
  });
});

describe("statusDetail", () => {
  const view = (status: ProviderView["status"], extra: Partial<ProviderView> = {}): ProviderView => ({
    id: "zai",
    status,
    models: [model("zai", "glm-5")],
    engines: [],
    ...extra,
  });
  const flat = (segments: ReturnType<typeof statusDetail>) => segments.map((s) => s.text).join("");

  test("unsigned providers are told to run pi's /login slash command, not a CLI auth verb", () => {
    const hint = statusDetail(view("unsigned"));

    expect(hint.find((s) => s.code)?.text).toBe("/login zai");
    expect(flat(hint)).toContain("in a pi session, then refresh.");
    // the pi CLI exposes print-api-key / print-bearer-token / check — an
    // `auth login` hint would send users to a command that does not exist
    expect(flat(hint)).not.toContain("pi auth login");
  });

  test("signed-in and cooling providers each get one plain line; the cause is humanized", () => {
    expect(statusDetail(view("ok"))).toEqual([
      { text: "Signed in — available to chat sessions and engine spawns." },
    ]);

    const cooling = statusDetail(
      view("cooling", { coolingUntil: new Date(2026, 10, 6, 14, 30).getTime(), coolingCause: "provider-quota" }),
    );
    expect(cooling).toHaveLength(1);
    // time-of-day is locale-formatted, so pin the shape around it
    expect(cooling[0].text).toMatch(/^Cooling · provider quota until .+ — every engine on this account waits\.$/);

    const noUntil = statusDetail(view("cooling"));
    expect(noUntil[0].text).toBe("Cooling · provider incident — every engine on this account waits.");
  });
});
