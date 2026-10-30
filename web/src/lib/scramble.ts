/**
 * The brand's click trick (web/src/lib/Brand.svelte), pi-web's sidebar
 * easter egg: the name scrambles into the version in the accent; it
 * scrambles back after VERSION_SHOWN_MS, or at once on a second click.
 */

export const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
/** The text settles left to right over its length times this many frames. */
export const SCRAMBLE_FRAMES_PER_CHAR = 4;
/** How long the version stays, counted from the click that showed it. */
export const VERSION_SHOWN_MS = 3000;

/** How many frames `target` takes to settle. */
export function scrambleFrameCount(target: string): number {
  return target.length * SCRAMBLE_FRAMES_PER_CHAR;
}

/**
 * The scramble's text at `frame` (from 0): spaces kept, the characters
 * settling left to right, every one not yet settled random; `target` itself
 * from the last frame on. The length never changes, so in the brand's row
 * neither does the width while it scrambles.
 */
export function scrambleFrame(target: string, frame: number, random: () => number = Math.random): string {
  const total = scrambleFrameCount(target);
  if (frame >= total) return target;
  const settled = Math.floor((frame / total) * target.length);
  let text = "";
  for (let index = 0; index < target.length; index++) {
    const char = target[index];
    text += char === " " || index < settled ? char : SCRAMBLE_CHARS[Math.floor(random() * SCRAMBLE_CHARS.length)];
  }
  return text;
}
