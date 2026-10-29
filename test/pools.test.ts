import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pools } from "../web/src/lib/pools.svelte";
import { board } from "../web/src/lib/board.svelte";

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
        return new Response(
          JSON.stringify({
            models: [
              {
                id: "claude-3-5",
                name: "Claude",
                provider: "anthropic",
                context: "200k",
                thinking: true,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
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
        name: "Claude",
        provider: "anthropic",
        context: "200k",
        thinking: true,
      },
    ]);
    expect(pools.loaded).toBe(true);
  });
});
