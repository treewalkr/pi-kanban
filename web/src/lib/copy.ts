/** Copy text to the clipboard. Resolves false when the clipboard API is
 *  unavailable or the write fails — never throws. */
export async function copyText(text: string): Promise<boolean> {
  try {
    const nav = typeof navigator !== "undefined" ? navigator : undefined;
    if (!nav?.clipboard?.writeText) return false;
    await nav.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
