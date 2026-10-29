import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { pools } from "../web/src/lib/pools.svelte";
import { board } from "../web/src/lib/board.svelte";
import type { WorkerPool } from "../src/db";
import type { CatalogModel } from "../src/models";

type FetchCall = { url: string; method: string; body?: unknown };

describe("pools store", () => {
  let calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    calls = [];
    pools.pools = [];
    pools.loaded = false;
    pools.models = [];
    board.error = "";

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      let body: unknown;
      if (init?.body && typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      calls.push({ url, method, body });

      if (url.endsWith("/pools") && method === "GET") {
        return new Response(
          JSON.stringify({
            pools: [
              {
                id: "heavy",
                name: "heavy",
                enabled: true,
                roles: ["reviewer"],
                slots: [{}],
                updatedAt: 123,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/pi-models") && method === "GET") {
        const models: CatalogModel[] = [
          {
            id: "claude-3-5",
            provider: "anthropic",
            context: "200k",
            maxOut: "8k",
            thinking: true,
            images: false,
          },
        ];
        return new Response(JSON.stringify({ models }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (method === "PUT") {
        const id = url.split("/").pop();
        const pool = body as Partial<WorkerPool>;
        return new Response(
          JSON.stringify({
            id,
            name: pool.name ?? "",
            enabled: pool.enabled ?? false,
            roles: pool.roles ?? [],
            slots: pool.slots ?? [{}],
            updatedAt: Date.now(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (method === "DELETE") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("load() fetches pools and models through the stubbed API", async () => {
    await pools.load();

    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", "http://localhost:4600/pools"],
      ["GET", "http://localhost:4600/pi-models"],
    ]);
    expect(pools.pools).toEqual([
      {
        id: "heavy",
        name: "heavy",
        enabled: true,
        roles: ["reviewer"],
        slots: [{}],
        updatedAt: 123,
      },
    ]);
    expect(pools.models).toEqual([
      {
        id: "claude-3-5",
        provider: "anthropic",
        context: "200k",
        maxOut: "8k",
        thinking: true,
        images: false,
      },
    ]);
    expect(pools.loaded).toBe(true);
  });

  test("addDraft + remove deletes a draft locally without any API call", async () => {
    const draft = pools.addDraft();
    expect(pools.pools.some((p) => p.id === draft.id)).toBe(true);

    calls = [];
    const ok = await pools.remove(draft.id);

    expect(ok).toBe(true);
    expect(pools.pools.some((p) => p.id === draft.id)).toBe(false);
    expect(calls).toEqual([]);
    expect(board.error).toBe("");
  });

  test("remove of a saved pool still calls DELETE /pools/:id", async () => {
    pools.pools = [
      {
        id: "heavy",
        name: "heavy",
        enabled: true,
        roles: ["reviewer"],
        slots: [{}],
        updatedAt: 123,
      },
    ];

    const ok = await pools.remove("heavy");

    expect(ok).toBe(true);
    expect(pools.pools).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url.endsWith("/pools/heavy")).toBe(true);
  });

  test("saving a draft then deleting it goes through DELETE", async () => {
    const draft = pools.addDraft();
    draft.name = "saved draft";

    const saved = await pools.save(draft);
    expect(saved).toBe(true);

    calls = [];
    const ok = await pools.remove(draft.id);

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url.endsWith(`/pools/${draft.id}`)).toBe(true);
    expect(pools.pools).toEqual([]);
  });

  test("remove surfaces the API error and keeps the pool when DELETE fails", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      return new Response(JSON.stringify({ error: "no pool 'heavy'" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    pools.pools = [
      {
        id: "heavy",
        name: "heavy",
        enabled: true,
        roles: ["reviewer"],
        slots: [{}],
        updatedAt: 123,
      },
    ];

    const ok = await pools.remove("heavy");

    expect(ok).toBe(false);
    expect(board.error).toBe("no pool 'heavy'");
    expect(pools.pools).toHaveLength(1);
    expect(pools.pools[0].id).toBe("heavy");
  });

  test("addDraft avoids ids already used by pools or drafts", () => {
    pools.pools = [
      {
        id: "4fzol",
        name: "existing",
        enabled: true,
        roles: [],
        slots: [{}],
        updatedAt: 1,
      },
    ];

    const spy = spyOn(Math, "random").mockReturnValueOnce(0.12345).mockReturnValueOnce(0.6789);
    try {
      const draft = pools.addDraft();
      expect(draft.id).toBe("ofura");
      expect(draft.id).not.toBe("4fzol");
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }

    // "ofura" is now in drafts; 0.6789 collides with drafts, 0.12345 collides with pools.pools
    const spy2 = spyOn(Math, "random")
      .mockReturnValueOnce(0.6789)
      .mockReturnValueOnce(0.12345)
      .mockReturnValueOnce(0.9999);
    try {
      const draft2 = pools.addDraft();
      expect(draft2.id).not.toBe("ofura");
      expect(draft2.id).not.toBe("4fzol");
      expect(spy2).toHaveBeenCalledTimes(3);
    } finally {
      spy2.mockRestore();
    }
  });

  test("load() clears stale draft tracking", async () => {
    const draft = pools.addDraft();
    const draftId = draft.id;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });

      if (url.endsWith("/pools") && method === "GET") {
        return new Response(
          JSON.stringify({
            pools: [
              {
                id: draftId,
                name: "server version",
                enabled: true,
                roles: [],
                slots: [{}],
                updatedAt: 123,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/pi-models") && method === "GET") {
        return new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (method === "DELETE") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await pools.load();

    calls = [];
    const ok = await pools.remove(draftId);

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url.endsWith(`/pools/${draftId}`)).toBe(true);
  });
});
