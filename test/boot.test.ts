import { describe, expect, test } from "bun:test";
import { shareDecision } from "../src/index";

const base = { occupied: false, requested: false, force: false, health: null, token: undefined };

describe("shareDecision (occupied-port guard)", () => {
  test("free port always binds", () => {
    expect(shareDecision(base)).toEqual({ allow: true });
    expect(shareDecision({ ...base, requested: true })).toEqual({ allow: true });
  });

  test("occupied port without the share flag refuses (original guard)", () => {
    const d = shareDecision({ ...base, occupied: true, health: { ok: true } });
    expect(d.allow).toBe(false);
    expect(d.error).toContain("stop it first");
  });

  test("self-respawn child: matching share token is allowed through", () => {
    expect(
      shareDecision({ ...base, occupied: true, requested: true, health: { ok: true, shareToken: "t" }, token: "t" }),
    ).toEqual({ allow: true });
  });

  test("cargo-culted KANBAN_SHARE_PORT against a foreign kanban board refuses (10/29 incident)", () => {
    const d = shareDecision({ ...base, occupied: true, requested: true, health: { ok: true, shareToken: "theirs" }, token: undefined });
    expect(d.allow).toBe(false);
    expect(d.error).toContain("another kanban board");
    expect(d.error).toContain("repro.sh");
  });

  test("share flag against a non-kanban listener refuses too", () => {
    const d = shareDecision({ ...base, occupied: true, requested: true, health: null });
    expect(d.allow).toBe(false);
    expect(d.error).toContain("unknown listener");
  });

  test("KANBAN_SHARE_FORCE overrides everything (explicit human escape hatch)", () => {
    expect(
      shareDecision({ ...base, occupied: true, requested: true, force: true, health: { ok: true, shareToken: "x" }, token: "y" }),
    ).toEqual({ allow: true });
  });
});
