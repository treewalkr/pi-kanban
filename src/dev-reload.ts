// Watch marker for the dev restart button: POST /dev/restart rewrites this file with a
// fresh stamp (src/dev-restart.ts), bun --watch sees the content change and reloads the
// whole server. Imported by src/index.ts purely so the watcher tracks it.
export const restartStamp = 0;
