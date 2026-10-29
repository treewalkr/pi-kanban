import type { CatalogSkill } from "../../../src/skills";

/** Case-insensitive substring match over name+description; blank query → the whole catalog. */
export function filterSkills(catalog: CatalogSkill[], query: string): CatalogSkill[] {
  const q = query.trim().toLowerCase();
  if (!q) return catalog;
  return catalog.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
}

/** The "add custom path" row appears only when the query is non-blank and filterSkills found nothing. */
export function offerCustomPath(query: string, filteredCount: number): boolean {
  return query.trim().length > 0 && filteredCount === 0;
}

/** A selected path's chip: catalog name when some entry's path matches, else the raw path (known: false). */
export function skillLabel(path: string, catalog: CatalogSkill[]): { label: string; known: boolean } {
  const match = catalog.find((s) => s.path === path);
  if (match) {
    return { label: match.name, known: true };
  }
  return { label: path, known: false };
}

/** Toggle membership: appends at the end, removes in place, never duplicates. */
export function toggleSkill(selected: string[], path: string): string[] {
  if (selected.includes(path)) {
    return selected.filter((p) => p !== path);
  }
  return [...selected, path];
}
