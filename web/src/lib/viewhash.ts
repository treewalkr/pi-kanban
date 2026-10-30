/**
 * Hash helpers for project focus mode. Pure string manipulation, no DOM access.
 */

/** "#project=foo%20bar" → "foo bar"; "" for absent/foreign/empty-value hashes. */
export function parseProjectHash(hash: string): string {
  if (!hash.startsWith("#project=")) return "";
  const raw = hash.slice("#project=".length);
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

/** "foo" → "#project=foo" (encodeURIComponent); "" → "". */
export function projectHash(project: string): string {
  if (!project) return "";
  return `#project=${encodeURIComponent(project)}`;
}

/** Boot priority: the hash wins when it names a project, else the stored value. */
export function initialProject(stored: string, hash: string): string {
  const fromHash = parseProjectHash(hash);
  return fromHash !== "" ? fromHash : stored;
}
