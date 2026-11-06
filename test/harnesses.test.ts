import { describe, expect, it } from "bun:test";
import { CLAUDE_MODELS, CLAUDE_DEFAULT_MODEL } from "../src/claude";
import { PI_HARNESS, probeClaude } from "../src/harnesses";

describe("probeClaude", () => {
  it("missing when the binary is not on PATH, with the install hint", async () => {
    const probe = await probeClaude(() => null, async () => "should not run");
    expect(probe.status).toBe("missing");
    expect(probe.id).toBe("claude");
    expect(probe.detail).toContain("not on PATH");
    expect(probe.models).toEqual(CLAUDE_MODELS);
  });

  it("ready with the version line when the binary answers", async () => {
    const probe = await probeClaude(() => "/usr/local/bin/claude", async (cmd, args) => `${cmd} ${args.join(" ")} → 2.1.105 (Claude Code)`);
    expect(probe.status).toBe("ready");
    expect(probe.detail).toContain("2.1.105");
  });

  it("a failing or silent --version still reports ready, with the path as detail", async () => {
    const probe = await probeClaude(() => "/opt/claude", async () => null);
    expect(probe.status).toBe("ready");
    expect(probe.detail).toContain("/opt/claude");
  });
});

describe("the harness registry", () => {
  it("pi is always ready — the board's own runtime", () => {
    expect(PI_HARNESS.id).toBe("pi");
    expect(PI_HARNESS.status).toBe("ready");
  });

  it("claude's model aliases are the engine editor's ids, sonnet defaulting", () => {
    const ids = CLAUDE_MODELS.map((m) => m.id);
    expect(ids).toContain("sonnet");
    expect(ids).toContain(CLAUDE_DEFAULT_MODEL);
  });
});
