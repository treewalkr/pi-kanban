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
