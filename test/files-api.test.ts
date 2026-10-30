import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { KanbanDb } from "../src/db";
import { PREVIEW_MAX_BYTES } from "../src/files";

let dir = "";
let repoDir = "";
let db: KanbanDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-api-"));
  repoDir = mkdtempSync(join(tmpdir(), "kanban-files-repo-"));
  db = new KanbanDb(join(dir, "t.db"));

  // Set up repo fixture
  const exec = (...cmd: string[]) =>
    Bun.spawnSync({ cmd, cwd: repoDir, stdout: "ignore", stderr: "ignore" });
  exec("git", "init", "-b", "main");
  exec("git", "config", "user.email", "test@local");
  exec("git", "config", "user.name", "test");

  // Dirs & files
  mkdirSync(join(repoDir, "docs"));
  writeFileSync(join(repoDir, "docs", "intro.md"), "# Intro\n");
  writeFileSync(join(repoDir, "m.txt"), "original\n");
  writeFileSync(join(repoDir, "hello.ts"), "console.log('hi');\n");

  // Binary file
  const bin = Buffer.alloc(50);
  bin[5] = 0;
  writeFileSync(join(repoDir, "bin.dat"), bin);

  // Big file (>512 KB)
  const big = Buffer.alloc(PREVIEW_MAX_BYTES + 2048, "x");
  writeFileSync(join(repoDir, "big.txt"), big);

  exec("git", "add", "m.txt", "hello.ts");
  exec("git", "commit", "-m", "init");

  // Modify m.txt so git status shows M
  writeFileSync(join(repoDir, "m.txt"), "modified\n");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

describe("Files & Git Status API routes", () => {
  test("GET /git/status maps the fixture repo's dirty files", async () => {
    const app = createApp(db, { filesRoot: repoDir });
    const res = await app.handle(new Request("http://localhost/git/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: Record<string, string> };
    expect(body.files["m.txt"]).toBe("M");
  });

  test("GET /files lists the fixture root; ?path= lists a subdirectory", async () => {
    const app = createApp(db, { filesRoot: repoDir });

    // Root listing
    const rootRes = await app.handle(new Request("http://localhost/files"));
    expect(rootRes.status).toBe(200);
    const rootBody = (await rootRes.json()) as {
      path: string;
      entries: Array<{ name: string; isDir: boolean }>;
    };
    expect(rootBody.path).toBe("");
    expect(rootBody.entries.some((e) => e.name === ".git")).toBe(false);
    expect(rootBody.entries.find((e) => e.name === "docs")?.isDir).toBe(true);

    // Subdirectory listing
    const subRes = await app.handle(new Request("http://localhost/files?path=docs"));
    expect(subRes.status).toBe(200);
    const subBody = (await subRes.json()) as {
      path: string;
      entries: Array<{ name: string; isDir: boolean }>;
    };
    expect(subBody.path).toBe("docs");
    expect(subBody.entries).toEqual([{ name: "intro.md", isDir: false }]);
  });

  test("GET /files/content returns content and language; rejects escapes, misses, binaries, oversized", async () => {
    const app = createApp(db, { filesRoot: repoDir });

    // Normal text read
    const tsRes = await app.handle(new Request("http://localhost/files/content?path=hello.ts"));
    expect(tsRes.status).toBe(200);
    const tsBody = (await tsRes.json()) as { path: string; content: string; language: string };
    expect(tsBody).toEqual({
      path: "hello.ts",
      content: "console.log('hi');\n",
      language: "typescript",
    });

    // Escapes root -> 400
    const escapeRes = await app.handle(new Request("http://localhost/files/content?path=../out"));
    expect(escapeRes.status).toBe(400);
    const escapeBody = (await escapeRes.json()) as { error: string };
    expect(escapeBody.error).toContain("path escapes repo root");

    // Missing file -> 404
    const missRes = await app.handle(new Request("http://localhost/files/content?path=nope.txt"));
    expect(missRes.status).toBe(404);
    const missBody = (await missRes.json()) as { error: string };
    expect(missBody.error).toContain("no such file: 'nope.txt'");

    // Binary file -> 400
    const binRes = await app.handle(new Request("http://localhost/files/content?path=bin.dat"));
    expect(binRes.status).toBe(400);
    const binBody = (await binRes.json()) as { error: string };
    expect(binBody.error).toBe("binary file — no preview");

    // Oversized -> 400
    const bigRes = await app.handle(new Request("http://localhost/files/content?path=big.txt"));
    expect(bigRes.status).toBe(400);
    const bigBody = (await bigRes.json()) as { error: string };
    expect(bigBody.error).toBe("file exceeds the 512 KB preview limit");
  });

  test("no file mutation routes exist", async () => {
    const app = createApp(db, { filesRoot: repoDir });

    const postFiles = await app.handle(
      new Request("http://localhost/files", { method: "POST", body: "{}" })
    );
    expect([404, 405]).toContain(postFiles.status);

    const putContent = await app.handle(
      new Request("http://localhost/files/content", { method: "PUT", body: "{}" })
    );
    expect([404, 405]).toContain(putContent.status);

    const deleteContent = await app.handle(
      new Request("http://localhost/files/content", { method: "DELETE" })
    );
    expect([404, 405]).toContain(deleteContent.status);

    // GET /files/content never sets content-disposition
    const normalGet = await app.handle(new Request("http://localhost/files/content?path=hello.ts"));
    expect(normalGet.headers.get("content-disposition")).toBeNull();
  });
});
