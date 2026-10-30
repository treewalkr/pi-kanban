import { describe, expect, test } from "bun:test";
import { initialProject, parseProjectHash, projectHash } from "../web/src/lib/viewhash";

describe("viewhash helpers", () => {
  test("parses #project= with encoding and rejects foreign/empty hashes", () => {
    expect(parseProjectHash("#project=web%20ui")).toBe("web ui");
    expect(parseProjectHash("#project=")).toBe("");
    expect(parseProjectHash("#foo")).toBe("");
    expect(parseProjectHash("#")).toBe("");
    expect(parseProjectHash("")).toBe("");
    expect(parseProjectHash("#project=%E0%A4%A")).toBe(""); // malformed percent-encoding
  });

  test("projectHash formats and round-trips any tag", () => {
    expect(projectHash("web ui")).toBe("#project=web%20ui");
    expect(projectHash("")).toBe("");

    const tags = ["a b", "x&y", "p#q", "café"];
    for (const tag of tags) {
      expect(parseProjectHash(projectHash(tag))).toBe(tag);
    }
  });

  test("boot priority: hash wins over storage", () => {
    expect(initialProject("old", "#project=new")).toBe("new");
    expect(initialProject("old", "")).toBe("old");
    expect(initialProject("old", "#foo")).toBe("old");
    expect(initialProject("old", "#project=")).toBe("old");
  });
});
