import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FilesStore, joinPath } from "../web/src/lib/files.svelte";

describe("FilesStore (web/src/lib/files.svelte.ts)", () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  let storage = new Map<string, string>();
  let fetchCalls: Array<{ url: string; method: string }> = [];

  beforeEach(() => {
    storage = new Map();
    fetchCalls = [];

    globalThis.localStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, String(v)),
      removeItem: (k: string) => storage.delete(k),
      clear: () => storage.clear(),
    } as any;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      fetchCalls.push({ url, method });

      const parsed = new URL(url, "http://localhost:4600");

      if (parsed.pathname === "/git/status") {
        return new Response(
          JSON.stringify({
            files: {
              "src/a.ts": "M",
              "src/sub/b.ts": "A",
              "README.md": "M",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (parsed.pathname === "/files") {
        const p = parsed.searchParams.get("path") ?? "";
        if (p === "") {
          return new Response(
            JSON.stringify({
              path: "",
              entries: [
                { name: "src", isDir: true },
                { name: "web", isDir: true },
                { name: "README.md", isDir: false },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (p === "src") {
          return new Response(
            JSON.stringify({
              path: "src",
              entries: [
                { name: "sub", isDir: true },
                { name: "a.ts", isDir: false },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ error: "no such directory" }), { status: 404 });
      }

      if (parsed.pathname === "/files/content") {
        const p = parsed.searchParams.get("path") ?? "";
        if (p === "src/a.ts") {
          return new Response(
            JSON.stringify({
              path: "src/a.ts",
              content: "export const a = 1;\n",
              language: "typescript",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (p === "README.md") {
          return new Response(
            JSON.stringify({
              path: "README.md",
              content: "# Kanban\n",
              language: "markdown",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (p === "fail.txt") {
          return new Response(JSON.stringify({ error: "file exceeds preview limit" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "no such file" }), { status: 404 });
      }

      return new Response(JSON.stringify({ error: "unhandled" }), { status: 404 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  });

  test("joinPath helper joins directory and file names", () => {
    expect(joinPath("", "src")).toBe("src");
    expect(joinPath("src", "files.ts")).toBe("src/files.ts");
    expect(joinPath("a/b", "c.txt")).toBe("a/b/c.txt");
  });

  test("setTab switches tabs and persists to localStorage; rehydrates on construction", async () => {
    const store = new FilesStore();
    expect(store.tab).toBe("queue");

    store.setTab("files");
    expect(store.tab).toBe("files");
    expect(storage.get("kanban-sidebar-tab")).toBe("files");

    // Fresh store rehydrates
    const store2 = new FilesStore();
    expect(store2.tab).toBe("files");

    store2.setTab("queue");
    expect(store2.tab).toBe("queue");
    expect(storage.get("kanban-sidebar-tab")).toBe("queue");

    const store3 = new FilesStore();
    expect(store3.tab).toBe("queue");
  });

  test("switching tabs never resets entries or open dirs", async () => {
    const store = new FilesStore();
    await store.load();
    await store.toggle("src");

    expect(store.open.has("src")).toBe(true);
    expect(store.entries.has("src")).toBe(true);

    // Switch to queue
    store.setTab("queue");
    expect(store.open.has("src")).toBe(true);
    expect(store.entries.has("src")).toBe(true);

    // Switch back to files
    store.setTab("files");
    expect(store.open.has("src")).toBe(true);
    expect(store.entries.has("src")).toBe(true);
  });

  test("toggle lazily fetches children once and caches; collapse does not refetch", async () => {
    const store = new FilesStore();
    await store.load();

    fetchCalls = []; // reset spy

    // First expand -> fetches src
    await store.toggle("src");
    expect(store.open.has("src")).toBe(true);
    const fetchSrcCalls = fetchCalls.filter((c) => c.url.includes("/files?path=src"));
    expect(fetchSrcCalls.length).toBe(1);
    expect(store.childrenOf("src")).toEqual([
      { name: "sub", isDir: true },
      { name: "a.ts", isDir: false },
    ]);

    // Collapse
    await store.toggle("src");
    expect(store.open.has("src")).toBe(false);
    expect(fetchCalls.filter((c) => c.url.includes("/files?path=src")).length).toBe(1);

    // Expand again -> uses cache, no extra fetch
    await store.toggle("src");
    expect(store.open.has("src")).toBe(true);
    expect(fetchCalls.filter((c) => c.url.includes("/files?path=src")).length).toBe(1);
  });

  test("codeFor, dirChanged, changesCount derive from the status map", async () => {
    const store = new FilesStore();
    await store.load();

    expect(store.codeFor("src/a.ts")).toBe("M");
    expect(store.codeFor("src/sub/b.ts")).toBe("A");
    expect(store.codeFor("README.md")).toBe("M");
    expect(store.codeFor("not-dirty.ts")).toBeUndefined();

    expect(store.dirChanged("src")).toBe(true);
    expect(store.dirChanged("src/sub")).toBe(true);
    expect(store.dirChanged("web")).toBe(false);

    expect(store.changesCount).toBe(3);
  });

  test("openFile sets preview from GET /files/content; closePreview clears", async () => {
    const store = new FilesStore();
    await store.openFile("src/a.ts");

    expect(store.preview).toEqual({
      path: "src/a.ts",
      content: "export const a = 1;\n",
      language: "typescript",
    });

    store.closePreview();
    expect(store.preview).toBeNull();
  });

  test("openFile failure lands in preview.error; openFile on markdown gets language markdown", async () => {
    const store = new FilesStore();

    // Markdown preview
    await store.openFile("README.md");
    expect(store.preview).toEqual({
      path: "README.md",
      content: "# Kanban\n",
      language: "markdown",
    });

    // Error case
    await store.openFile("fail.txt");
    expect(store.preview).toEqual({
      path: "fail.txt",
      content: "",
      language: "plaintext",
      error: "file exceeds preview limit",
    });
  });
});
