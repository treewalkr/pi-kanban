/**
 * Graceful-shutdown registry. Loops and servers register cleanup (terminate
 * children, release leases); signal handlers and the restart path run it all
 * before exit — nothing outlives the server that spawned it.
 */
const fns = new Set<() => void | Promise<void>>();

export function registerShutdown(fn: () => void | Promise<void>): () => void {
  fns.add(fn);
  return () => fns.delete(fn);
}

export async function runShutdown(): Promise<void> {
  for (const fn of [...fns]) {
    try {
      await fn();
    } catch {
      /* best effort — keep shutting down */
    }
  }
}
