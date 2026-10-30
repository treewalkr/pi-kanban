import { describe, expect, test } from "bun:test";
import { wheelPan, type WheelPanElement, type WheelPanEvent } from "../web/src/lib/wheel";

describe("wheelPan", () => {
  const baseEl: WheelPanElement = {
    scrollLeft: 300,
    scrollWidth: 2000,
    clientWidth: 1000,
    scrollHeight: 800,
    clientHeight: 800,
  };

  test("vertical wheel over the background returns a shifted scrollLeft", () => {
    expect(
      wheelPan({ deltaX: 0, deltaY: -120, deltaMode: 0, ctrlKey: false }, baseEl)
    ).toBe(180);
    expect(
      wheelPan({ deltaX: 0, deltaY: 120, deltaMode: 0, ctrlKey: false }, baseEl)
    ).toBe(420);
  });

  test("wheel-down pans right and wheel-up pans left by the same amount", () => {
    const el: WheelPanElement = { ...baseEl, scrollLeft: 500 };
    const right = wheelPan({ deltaX: 0, deltaY: 120, deltaMode: 0, ctrlKey: false }, el);
    const left = wheelPan({ deltaX: 0, deltaY: -120, deltaMode: 0, ctrlKey: false }, el);

    expect(right).toBe(620);
    expect(left).toBe(380);
    expect(right! - el.scrollLeft).toBe(el.scrollLeft - left!);
  });

  test("board with vertical overflow keeps native vertical scrolling", () => {
    const el: WheelPanElement = { ...baseEl, scrollHeight: 900, clientHeight: 800 };
    expect(
      wheelPan({ deltaX: 0, deltaY: 120, deltaMode: 0, ctrlKey: false }, el)
    ).toBeNull();
  });

  test("pan is clamped at both ends of the horizontal range", () => {
    const atStart: WheelPanElement = { ...baseEl, scrollLeft: 0 };
    expect(
      wheelPan({ deltaX: 0, deltaY: -1000, deltaMode: 0, ctrlKey: false }, atStart)
    ).toBe(0);

    const atEnd: WheelPanElement = { ...baseEl, scrollLeft: 1000 };
    expect(
      wheelPan({ deltaX: 0, deltaY: 1000, deltaMode: 0, ctrlKey: false }, atEnd)
    ).toBe(1000);
  });

  test("horizontal and pinch gestures are left to the browser", () => {
    expect(
      wheelPan({ deltaX: -80, deltaY: 0, deltaMode: 0, ctrlKey: false }, baseEl)
    ).toBeNull();
    expect(
      wheelPan({ deltaX: -80, deltaY: -3, deltaMode: 0, ctrlKey: false }, baseEl)
    ).toBeNull();
    expect(
      wheelPan({ deltaX: 0, deltaY: -120, deltaMode: 0, ctrlKey: true }, baseEl)
    ).toBeNull();
    expect(
      wheelPan({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false }, baseEl)
    ).toBeNull();
  });

  test("deltaMode normalizes line and page units", () => {
    expect(
      wheelPan({ deltaX: 0, deltaY: 2, deltaMode: 1, ctrlKey: false }, baseEl)
    ).toBe(332);
    expect(
      wheelPan({ deltaX: 0, deltaY: -2, deltaMode: 1, ctrlKey: false }, baseEl)
    ).toBe(268);
    expect(
      wheelPan({ deltaX: 0, deltaY: 0.5, deltaMode: 2, ctrlKey: false }, baseEl)
    ).toBe(700);
  });
});
