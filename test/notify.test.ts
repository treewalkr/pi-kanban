import { describe, expect, test } from "bun:test";
import { loadNotifyEnabled, notificationBody, notify, parseLaneEvent, shouldNotify, type LaneEventPayload } from "../web/src/lib/notify.svelte";

const payload: LaneEventPayload = {
  taskId: "ab12cd",
  title: "Attention notifications on Review entry",
  fromLaneId: "implement",
  toLaneId: "review",
  cause: "handoff",
  actor: "pi-builder",
  createdAt: 1730419200000,
};

describe("parseLaneEvent", () => {
  test("valid JSON string → payload object", () => {
    expect(parseLaneEvent(JSON.stringify(payload))).toEqual(payload);
    expect(parseLaneEvent({ ...payload })).toEqual(payload); // pre-parsed object accepted too
  });

  test("null fromLaneId is legal", () => {
    expect(parseLaneEvent(JSON.stringify({ ...payload, fromLaneId: null }))).toEqual({ ...payload, fromLaneId: null });
  });

  test("missing field / wrong type / non-JSON / null toLaneId → null, never throws", () => {
    const broken: unknown[] = [
      null,
      undefined,
      42,
      "not json",
      "{}",
      [],
      {},
      { ...payload, taskId: 7 },
      { ...payload, title: undefined },
      { ...payload, fromLaneId: 0 },
      { ...payload, toLaneId: null },
      { ...payload, cause: 1 },
      { ...payload, actor: false },
      { ...payload, createdAt: "1730419200000" },
    ];
    for (const input of broken) {
      expect(parseLaneEvent(input)).toBeNull();
    }
    // extra keys are tolerated, not rejected
    expect(parseLaneEvent(JSON.stringify({ ...payload, extra: true }))).toEqual(payload);
  });
});

describe("shouldNotify", () => {
  const granted = { enabled: true, permission: "granted" as const, hidden: true };

  test("review + enabled + granted + hidden → true", () => {
    expect(shouldNotify(payload, granted)).toBe(true);
  });

  test("each gate flipped alone → false", () => {
    expect(shouldNotify({ ...payload, toLaneId: "done" }, granted)).toBe(false); // other lane
    expect(shouldNotify(payload, { ...granted, enabled: false })).toBe(false); // disabled
    expect(shouldNotify(payload, { ...granted, permission: "denied" as const })).toBe(false);
    expect(shouldNotify(payload, { ...granted, permission: "default" as const })).toBe(false);
    expect(shouldNotify(payload, { ...granted, permission: "unsupported" as const })).toBe(false);
    expect(shouldNotify(payload, { ...granted, hidden: false })).toBe(false); // visible tab
  });
});

describe("notificationBody", () => {
  test("exact copy", () => {
    expect(notificationBody(payload)).toBe("Attention notifications on Review entry · ab12cd entered Review");
  });

  test("titles truncate to 80 chars + ellipsis, matching the osascript body", () => {
    const long = { ...payload, title: "y".repeat(120) };
    expect(notificationBody(long)).toBe(`${"y".repeat(80)}… · ab12cd entered Review`);
    const exactly80 = { ...payload, title: "z".repeat(80) };
    expect(notificationBody(exactly80)).toBe(`${"z".repeat(80)} · ab12cd entered Review`); // no ellipsis at the limit
  });
});

describe("loadNotifyEnabled", () => {
  test("true iff read() returns 'on'", () => {
    expect(loadNotifyEnabled(() => "on")).toBe(true);
    expect(loadNotifyEnabled(() => "off")).toBe(false);
    expect(loadNotifyEnabled(() => null)).toBe(false);
    expect(loadNotifyEnabled(() => "garbage")).toBe(false);
  });
});

describe("notify store", () => {
  test("defaults to disabled and survives a missing DOM", () => {
    expect(typeof notify.enabled).toBe("boolean");
    notify.disable(); // persists "off" without throwing
    expect(notify.enabled).toBe(false);
    expect(notify.permission()).toBe("unsupported"); // bun tests have no Notification
    expect(notify.onLaneData("garbage")).toBeUndefined(); // parse failure swallowed
  });
});
