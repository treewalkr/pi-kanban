import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanError } from "../src/db";
import {
  EXT_TO_HLJS,
  PREVIEW_MAX_BYTES,
  languageForPath,
  listFiles,
  readFile,
} from "../src/files";

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-files-"));

  // Create dirs
  mkdirSync(join(dir, "b-dir"));
  mkdirSync(join(dir, "a-dir"));
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, "sub"));

  // Create files
  writeFileSync(join(dir, "z.txt"), "z content\n");
  writeFileSync(join(dir, "a.txt"), "a content\n");
  writeFileSync(join(dir, ".DS_Store"), "ds store\n");
  writeFileSync(join(dir, "README.md"), "# Hello\n");
  writeFileSync(join(dir, "code.ts"), "const x = 1;\n");
  writeFileSync(join(dir, "unknown.xyz"), "plain\n");

  // Subdir contents
  writeFileSync(join(dir, "sub", "child.txt"), "child content\n");

  // Binary file
  const binBuf = Buffer.alloc(100);
  binBuf[10] = 0;
  writeFileSync(join(dir, "binary.bin"), binBuf);

  // Large file (>512KB)
  const bigBuf = Buffer.alloc(PREVIEW_MAX_BYTES + 1024, "a");
  writeFileSync(join(dir, "large.txt"), bigBuf);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("src/files.ts", () => {
  test("listFiles: dirs first, alphabetical, skips .git and .DS_Store", async () => {
    const entries = await listFiles(dir, "");
    // Check that .git and .DS_Store are absent
    expect(entries.some((e) => e.name === ".git")).toBe(false);
    expect(entries.some((e) => e.name === ".DS_Store")).toBe(false);

    // Filter to the fixture items to verify dirs first, alphabetical
    const names = entries.map((e) => e.name);
    const dirs = entries.filter((e) => e.isDir).map((e) => e.name);
    const files = entries.filter((e) => !e.isDir).map((e) => e.name);

    expect(dirs).toEqual(["a-dir", "b-dir", "sub"]);
    // Dirs come before files
    const lastDirIndex = Math.max(...dirs.map((d) => names.indexOf(d)));
    const firstFileIndex = Math.min(...files.map((f) => names.indexOf(f)));
    expect(lastDirIndex).toBeLessThan(firstFileIndex);
  });

  test("listFiles: nested path lists that dir; escapes and misses throw", async () => {
    const subEntries = await listFiles(dir, "sub");
    expect(subEntries).toEqual([{ name: "child.txt", isDir: false }]);

    expect(listFiles(dir, "../out")).rejects.toThrow(
      new KanbanError("path escapes repo root: '../out'", "invalid")
    );

    expect(listFiles(dir, "nope")).rejects.toThrow(
      new KanbanError("no such directory: 'nope'", "not-found")
    );
  });

  test("readFile maps extensions to hljs languages; unknown → plaintext", () => {
    expect(languageForPath("a.ts")).toBe("typescript");
    expect(languageForPath("README.md")).toBe("markdown");
    expect(languageForPath("x.unknown")).toBe("plaintext");
    expect(languageForPath("no-ext")).toBe("plaintext");
    expect(languageForPath("nested/dir/app.tsx")).toBe("typescript");
    expect(languageForPath("styles.css")).toBe("css");
    expect(languageForPath("query.sql")).toBe("sql");
  });

  test("readFile: reads content and language; rejects escapes, misses, binaries, oversized", async () => {
    const res = await readFile(dir, "code.ts");
    expect(res).toEqual({
      content: "const x = 1;\n",
      language: "typescript",
      size: 13,
      binary: false,
    });

    const mdRes = await readFile(dir, "README.md");
    expect(mdRes.language).toBe("markdown");
    expect(mdRes.size).toBe(8);
    expect(mdRes.binary).toBe(false);

    // Escapes
    expect(readFile(dir, "../secret.txt")).rejects.toThrow(
      new KanbanError("path escapes repo root: '../secret.txt'", "invalid")
    );

    // Missing
    expect(readFile(dir, "nope.txt")).rejects.toThrow(
      new KanbanError("no such file: 'nope.txt'", "not-found")
    );

    // Directory is not a file
    expect(readFile(dir, "sub")).rejects.toThrow(
      new KanbanError("no such file: 'sub'", "not-found")
    );

    // Binary file
    const binRes = await readFile(dir, "binary.bin");
    expect(binRes).toEqual({
      content: "",
      language: "plaintext",
      size: 100,
      binary: true,
    });

    // Oversized (>512KB)
    expect(readFile(dir, "large.txt")).rejects.toThrow(
      new KanbanError("file exceeds the 512 KB preview limit", "invalid")
    );
  });
});
