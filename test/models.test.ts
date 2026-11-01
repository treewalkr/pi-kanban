import { expect, test } from "bun:test";
import { parseModelsTable, runtimeModelsToCatalog } from "../src/models";

test("parses the pi --list-models table", () => {
  const text = `provider       model                                    context  max-out  thinking  images
pi-claude-cli  claude-opus-5                            1M       128K     yes       yes
zai            glm-5.3                                  1M       131.1K   yes       no
zenmux         alibaba/wan3.0-video                     20K      32.8K    no        yes`;
  expect(parseModelsTable(text)).toEqual([
    { provider: "pi-claude-cli", id: "claude-opus-5", context: "1M", maxOut: "128K", thinking: true, images: true },
    { provider: "zai", id: "glm-5.3", context: "1M", maxOut: "131.1K", thinking: true, images: false },
    { provider: "zenmux", id: "alibaba/wan3.0-video", context: "20K", maxOut: "32.8K", thinking: false, images: true },
  ]);
});

test("skips blank, header and ragged lines", () => {
  expect(parseModelsTable("provider model context\n\n  \nshort row here\n")).toEqual([]);
  // a repeated header (as slice(1) doesn't guard re-occurrence) is dropped too
  expect(parseModelsTable("x\nprovider       model …\nzai glm-5.3 1M 131.1K yes no")).toHaveLength(1);
});

// regression (2026-11-02): zcode's plan-tier model ids contain spaces
// ("Start Plan/GLM-5.2"), so whitespace-splitting read every tier as id "Start"
// with the columns shifted into garbage, and the dedupe then kept only the
// first tier — the pickers offered a lone "Start · Plan/GLM-5-Turbo" while pi
// itself listed all three. Rows are parsed right-anchored instead.
test("parses model ids containing spaces, keeping every distinct id", () => {
  const text = `provider     model                     context  max-out  thinking  images
zcode        Start Plan/GLM-5-Turbo    200K     64K      yes       no
zcode        Start Plan/GLM-5.2        1M       128K     yes       no
zcode        Start Plan/GLM-5.3-Flash  1M       128K     yes       no`;
  expect(parseModelsTable(text)).toEqual([
    { provider: "zcode", id: "Start Plan/GLM-5-Turbo", context: "200K", maxOut: "64K", thinking: true, images: false },
    { provider: "zcode", id: "Start Plan/GLM-5.2", context: "1M", maxOut: "128K", thinking: true, images: false },
    { provider: "zcode", id: "Start Plan/GLM-5.3-Flash", context: "1M", maxOut: "128K", thinking: true, images: false },
  ]);
});

// safety net for the keyed {#each ms as m (m.id)} in the settings panels: a
// catalog genuinely repeating a provider/id pair must not reach them
test("drops rows repeating a provider/id pair, keeping the first", () => {
  const text = `provider       model                                    context  max-out  thinking  images
zai            glm-5.3                                  1M       131.1K   yes       no
zcode          Start Plan/GLM-5.2                       1M       128K     yes       no
zcode          Start Plan/GLM-5.2                       2M       128K     yes       yes
otherprov      Start Plan/GLM-5.2                       1M       128K     yes       yes`;
  expect(parseModelsTable(text)).toEqual([
    { provider: "zai", id: "glm-5.3", context: "1M", maxOut: "131.1K", thinking: true, images: false },
    { provider: "zcode", id: "Start Plan/GLM-5.2", context: "1M", maxOut: "128K", thinking: true, images: false },
    // same id under another provider is a different key and survives
    { provider: "otherprov", id: "Start Plan/GLM-5.2", context: "1M", maxOut: "128K", thinking: true, images: true },
  ]);
});

// a row whose thinking/images cells aren't yes/no means the column layout is
// not what we assume — skip it rather than emit silently-wrong fields
test("skips rows whose flag columns are not yes/no", () => {
  const text = `provider       model                                    context  max-out  thinking  images
zai            glm-5.3                                  1M       131.1K   yes       no
weird          some model                               1M       128K     maybe     sure
header-like    row                                      context  max-out  thinking  images`;
  expect(parseModelsTable(text)).toEqual([
    { provider: "zai", id: "glm-5.3", context: "1M", maxOut: "131.1K", thinking: true, images: false },
  ]);
});

test("runtimeModelsToCatalog: authed providers only, grouped, deduped, formatted", () => {
  const models = [
    { provider: "zai", id: "glm-5.3", contextWindow: 1_000_000, maxTokens: 131_072, reasoning: true, input: ["text", "image"] },
    { provider: "zai", id: "glm-5.3", contextWindow: 1_000_000, maxTokens: 131_072, reasoning: true }, // dup row
    { provider: "deepseek", id: "deepseek-v4-pro", contextWindow: 164_000, maxTokens: 65_536, reasoning: false },
    { provider: "antigravity", id: "gemini-3.8-flash", contextWindow: 1_000_000, maxTokens: 65_536, reasoning: true }, // no auth
  ];
  const catalog = runtimeModelsToCatalog(models, (p) => p !== "antigravity");
  expect(catalog).toEqual([
    { provider: "zai", id: "glm-5.3", context: "1.0M", maxOut: "131K", thinking: true, images: true },
    { provider: "deepseek", id: "deepseek-v4-pro", context: "164K", maxOut: "66K", thinking: false, images: false },
  ]);
});
