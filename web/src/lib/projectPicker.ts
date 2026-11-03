import type { DirEntry } from "../../../src/files";

/** Case-insensitive substring match over entry names; blank query → the same list, order preserved. */
export function filterDirs(dirs: DirEntry[], query: string): DirEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return dirs;
  return dirs.filter((d) => d.name.toLowerCase().includes(q));
}

/** Last non-empty "/" segment of a directory path ("/a/b/" → "b", "/" → ""). */
export function projectNameFromPath(fullPath: string): string {
  const segments = fullPath.split("/").filter((s) => s.length > 0);
  return segments.pop() ?? "";
}

/** null = acceptable; otherwise the inline message the confirm step shows and blocks on. */
export function projectNameProblem(name: string, existing: string[]): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "project name is required";
  if (trimmed.length > 48) return "project name must be 1 to 48 characters";
  if (existing.includes(trimmed)) return `project '${trimmed}' already exists — pick another name`;
  return null;
}
