import { api } from "../api";

// Serve health/staleness + the restart flow, shared by the header's stale chip
// and Settings → General → Service so the logic lives in exactly one place.

export interface ServeGit {
  commit: string | null;
  head: string | null;
  dirty: boolean;
}

interface HealthBody {
  booted?: number;
  version?: string;
  git?: ServeGit | null;
}

export const service = $state({
  /** true when serve runs code older than HEAD (or the tracked tree is dirty) */
  stale: false,
  restarting: false,
  /** tooltip copy for the chip; null when not stale */
  detail: null as string | null,
});

async function health(): Promise<HealthBody | null> {
  try {
    const res = await api.health.get();
    const data = res.data as HealthBody | undefined; // treaty data narrows late — cast like board.refresh()
    return data ?? null;
  } catch {
    return null; // serve down or restarting — not the chip's problem
  }
}

/** Refresh staleness from /health's boot-commit vs live-HEAD report. Cheap; called on a 30s poll. */
export async function pollServe(): Promise<void> {
  const body = await health();
  const git = body?.git ?? null;
  if (!git || !git.commit || !git.head) {
    service.stale = false; // unknown (no git, or an old pre-git-report serve) — stay quiet
    service.detail = null;
    return;
  }
  service.stale = git.commit !== git.head || git.dirty;
  service.detail = service.stale
    ? `serve runs ${git.commit.slice(0, 7)}, HEAD is ${git.head.slice(0, 7)}${git.dirty ? ", tree dirty" : ""} — click to rebuild + restart`
    : null;
}

export interface RestartResult {
  ok: boolean;
  /** user-visible note for the non-ok paths; empty on success */
  note: string;
  /** true when the failure is real (vs. a user cancel) — styles the note red */
  failed: boolean;
}

/**
 * Rebuild the web bundle and restart the server (POST /restart). Waits for a
 * newer boot stamp, then the caller reloads the page. In-flight agent sessions
 * are confirmed once before forcing.
 */
export async function restartService(): Promise<RestartResult> {
  if (service.restarting) return { ok: true, note: "", failed: false };
  service.restarting = true;
  try {
    const before = (await health())?.booted ?? 0;
    let res = await api.restart.post();
    // in-flight agent sessions: the server refuses unless forced — ask once
    const conflict = res.error?.value as { code?: string; sessions?: number } | undefined;
    if (res.error && conflict?.code === "sessions-in-flight") {
      const n = conflict.sessions ?? 0;
      if (!confirm(`${n} agent session${n === 1 ? "" : "s"} running — restarting kills ${n === 1 ? "it" : "them"}. Restart anyway?`)) {
        return { ok: false, note: "restart cancelled — agent sessions left running", failed: false };
      }
      res = await api.restart.post(null, { query: { force: "true" } });
    }
    if (res.error) {
      const value = res.error.value;
      const note =
        typeof value === "object" && value !== null && "error" in value && typeof value.error === "string"
          ? value.error
          : "restart unavailable";
      return { ok: false, note, failed: true };
    }
    // vite build can take a while; poll until a server with a newer boot stamp answers
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const booted = (await health())?.booted;
      if (typeof booted === "number" && booted > before) return { ok: true, note: "", failed: false };
    }
    return { ok: false, note: "server didn't come back — check the serve log (build errors?).", failed: true };
  } catch {
    return { ok: false, note: "cannot reach the API — is it running?", failed: true };
  } finally {
    service.restarting = false;
  }
}
