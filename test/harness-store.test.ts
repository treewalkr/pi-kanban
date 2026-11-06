import { beforeEach, describe, expect, it, mock } from "bun:test";
import { join } from "node:path";

/**
 * Store-level races around the harness master switch. The api module is
 * stubbed with hand-controlled promises so a fetch round started BEFORE a
 * write can be made to resolve AFTER the post-write round — the exact
 * interleaving that used to snap the switch back to its pre-write state.
 */

type Probe = {
  id: string;
  label: string;
  status: "ready" | "missing";
  detail: string;
  models: Array<{ id: string; label: string; note: string }>;
  enabled?: boolean;
};

const probes: Probe[] = [
  { id: "pi", label: "pi agent", status: "ready", detail: "runtime", models: [] },
  { id: "claude", label: "Claude Code", status: "ready", detail: "2.1.318", models: [] },
];

let putCalls: Array<{ id: string; enabled: boolean }> = [];
let putError = false;
/** One entry per /harnesses GET: "gate" parks the round on a hand-released promise. */
let getModes: Array<"gate" | "now"> = [];
let gates: Array<() => void> = [];

const ok = <T,>(data: T) => () => Promise.resolve({ data, error: null });

const api = {
  harnesses: Object.assign(
    ({ id }: { id: string }) => ({
      enabled: {
        put: async ({ enabled }: { enabled: boolean }) => {
          putCalls.push({ id, enabled });
          if (!putError) {
            const probe = probes.find((p) => p.id === id);
            if (probe) probe.enabled = enabled; // the server's post-write state
          }
          return putError ? { error: { message: "boom" } } : { error: null };
        },
      },
    }),
    {
      // snapshot at call time: a round that started before the PUT answers with pre-write state
      get: () => {
        const snapshot = structuredClone(probes);
        const mode = getModes.shift() ?? "now";
        return new Promise((resolve) => {
          const deliver = () => resolve({ data: { harnesses: snapshot }, error: null });
          if (mode === "now") deliver();
          else gates.push(deliver);
        });
      },
    },
  ),
  "pi-models": { get: ok({ models: [] }) },
  "chat-models": { get: ok({ models: [] }) },
  engines: { get: ok({ engines: [], settings: { maxWorkers: 12, defaultEngine: null, disabledModels: [] } }) },
  activity: { get: ok({ engines: [] }) },
};

mock.module(join(import.meta.dir, "../web/src/api"), () => ({ api }));

const { HarnessStore } = await import("../web/src/lib/harnesses.svelte");

function releaseGate(): void {
  gates.shift()?.();
}

/** The claude view's switch state, straight from the store's list. */
function switchState(store: InstanceType<typeof HarnessStore>): boolean | undefined {
  return store.list.find((h) => h.id === "claude")?.enabled;
}

describe("HarnessStore.toggle", () => {
  beforeEach(() => {
    putCalls = [];
    putError = false;
    getModes = [];
    gates = [];
    probes[1].enabled = undefined;
  });

  it("flips optimistically and a stale pre-write round never overwrites it", async () => {
    const store = new HarnessStore();
    getModes = ["now"]; // A: initial load — the rail renders
    await store.load();
    expect(switchState(store)).toBe(true);

    // B: a refresh is already in flight when the switch is clicked (gated)
    getModes = ["gate"];
    const slowRound = store.refresh();

    const flip = store.toggle("claude", false);
    expect(switchState(store)).toBe(false); // realtime: flipped before any network answer

    await flip; // PUT lands; the forced round reads the post-write state
    expect(putCalls).toEqual([{ id: "claude", enabled: false }]);
    expect(switchState(store)).toBe(false);

    releaseGate(); // round B answers with pre-write state — after the forced round
    await slowRound;
    expect(switchState(store)).toBe(false); // the guard must discard it
  });

  it("reverts the flip when the write fails and raises the banner flag", async () => {
    const store = new HarnessStore();
    putError = true;
    getModes = ["now", "now"];
    await store.load();
    await store.toggle("claude", false);
    expect(switchState(store)).toBe(true);
    expect(store.toggleFailed).toBe("claude");
    expect(putCalls).toHaveLength(1);
  });
});
