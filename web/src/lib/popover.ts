export interface AnchorRect {
  left: number;
  right: number;
  bottom: number;
}

export interface PopoverPos {
  top: number;
  left?: number;
  right?: number;
}

/** Fixed-position coordinates for a popover opening 6px below its anchor, aligned
 *  to the anchor's left or right edge and kept at least 8px inside the viewport. */
export function popoverBelow(rect: AnchorRect, viewportWidth: number, align: "left" | "right"): PopoverPos {
  const top = rect.bottom + 6;
  if (align === "left") return { top, left: Math.max(8, rect.left) };
  return { top, right: Math.max(8, viewportWidth - rect.right) };
}
