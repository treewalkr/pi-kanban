/** Slice of WheelEvent the pan decision reads. */
export type WheelPanEvent = Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "ctrlKey">;
/** Slice of the board element the pan decision reads. */
export type WheelPanElement = Pick<
  HTMLElement,
  "scrollLeft" | "scrollWidth" | "clientWidth" | "scrollHeight" | "clientHeight"
>;

/**
 * New scrollLeft for the board when a wheel event over the board background
 * should pan horizontally, or null to leave the event to the browser.
 */
export function wheelPan(e: WheelPanEvent, el: WheelPanElement): number | null {
  if (e.ctrlKey) return null;
  if (el.scrollHeight > el.clientHeight) return null;
  if (e.deltaX !== 0 || e.deltaY === 0) return null;

  const dy =
    e.deltaMode === 1
      ? e.deltaY * 16
      : e.deltaMode === 2
        ? e.deltaY * el.clientHeight
        : e.deltaY;

  const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
  return Math.min(Math.max(el.scrollLeft + dy, 0), maxScroll);
}
