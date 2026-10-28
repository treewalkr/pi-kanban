import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distResponse } from "../src/index";

/** A dist dir stand-in: index.html + hashed assets, like `bun run build` emits. */
function fakeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanban-dist-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), '<script src="/assets/index-old.js"></script>');
  writeFileSync(join(dir, "assets", "index-old.js"), "console.log('old')");
  writeFileSync(join(dir, "favicon.svg"), "<svg/>");
  return dir;
}

describe("distResponse (per-request static serving)", () => {
  test("serves index.html, hashed assets, and favicon with content types", async () => {
    const dist = fakeDist();
    try {
      const html = distResponse(dist, "/");
      expect(html).not.toBeNull();
      expect(html!.headers.get("content-type")).toBe("text/html; charset=utf-8");

      const js = distResponse(dist, "/assets/index-old.js");
      expect(js).not.toBeNull();
      expect(js!.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(await js!.text()).toBe("console.log('old')");

      const svg = distResponse(dist, "/favicon.svg");
      expect(svg!.headers.get("content-type")).toBe("image/svg+xml");
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  test("a dist rebuilt mid-flight serves new asset hashes without a restart (10/29 incident)", async () => {
    const dist = fakeDist();
    try {
      writeFileSync(join(dist, "index.html"), '<script src="/assets/index-new.js"></script>');
      writeFileSync(join(dist, "assets", "index-new.js"), "console.log('new')");
      const fresh = distResponse(dist, "/assets/index-new.js");
      expect(fresh).not.toBeNull();
      expect(await fresh!.text()).toBe("console.log('new')");
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  test("rejects traversal, directories, and missing files", () => {
    const dist = fakeDist();
    try {
      expect(distResponse(dist, "/../secret.txt")).toBeNull();
      expect(distResponse(dist, "/assets/../../secret.txt")).toBeNull();
      expect(distResponse(dist, "/assets/")).toBeNull();
      expect(distResponse(dist, "/assets")).toBeNull(); // bare dir, no trailing slash — EISDIR guard
      expect(distResponse(dist, "/assets/never-built.js")).toBeNull();
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
