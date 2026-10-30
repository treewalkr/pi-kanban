/** Copy text to the clipboard. Tries the async Clipboard API first (secure
 *  contexts only), then falls back to execCommand for plain-HTTP origins and
 *  older browsers. Resolves false when both paths fail — never throws. */
export async function copyText(text: string): Promise<boolean> {
  try {
    const nav = typeof navigator !== "undefined" ? navigator : undefined;
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch {
    // denied or transient failure — try the legacy path below
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
