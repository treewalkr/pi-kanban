import { api } from "../api";
import type { FileEntry } from "../../../src/files";
import type { GitFileCode } from "../../../src/git";

export type SidebarTab = "queue" | "files";

export interface FilePreviewState {
  path: string;
  content: string;
  language: string;
  size: number;
  binary: boolean;
  error?: string;
}

export function joinPath(dir: string, name: string): string {
  return dir === "" ? name : dir + "/" + name;
}

function loadSidebarTab(): SidebarTab {
  try {
    const val = localStorage.getItem("kanban-sidebar-tab");
    if (val === "queue" || val === "files") return val;
  } catch {
    /* storage unavailable */
  }
  return "queue";
}

export class FilesStore {
  tab = $state<SidebarTab>(loadSidebarTab());
  entries = $state<Map<string, FileEntry[]>>(new Map());
  open = $state<Set<string>>(new Set());
  status = $state<Record<string, GitFileCode> | null>(null);
  loadError = $state<string | null>(null);
  preview = $state<FilePreviewState | null>(null);

  loading = $state<Set<string>>(new Set());
  dirErrors = $state<Map<string, string>>(new Map());

  previewModeHint = $state<"source" | "preview" | "diff" | null>(null);
  diff = $state<{ path: string; supported: boolean; patch?: string } | null>(null);

  searchQuery = $state("");
  searchMatches = $state<string[] | null>(null);
  searching = $state(false);
  searchError = $state(false);

  changesView = $state(false);
  lineStats = $state<{ additions: number; deletions: number }>({ additions: 0, deletions: 0 });

  setTab(t: SidebarTab): void {
    this.tab = t;
    try {
      localStorage.setItem("kanban-sidebar-tab", t);
    } catch {
      /* storage unavailable */
    }
    if (t === "files") {
      if (this.status === null) {
        void this.load();
      } else {
        void this.refresh();
      }
    }
  }

  async load(): Promise<void> {
    this.loadError = null;
    const [entriesRes, statusRes] = await Promise.all([
      api.files.get({ query: { path: "" } }),
      api.git.status.get(),
    ]);

    if (entriesRes.error) {
      const val = (entriesRes.error as { value?: unknown })?.value as
        | { error?: string }
        | undefined;
      this.loadError = val?.error ?? "failed to load files";
    } else if (entriesRes.data) {
      const next = new Map(this.entries);
      next.set("", entriesRes.data.entries);
      this.entries = next;
    }

    if (statusRes.error) {
      console.warn("failed to fetch git status", statusRes.error);
      this.status = {};
    } else if (statusRes.data) {
      this.status = statusRes.data.files;
      this.lineStats = {
        additions: statusRes.data.additions ?? 0,
        deletions: statusRes.data.deletions ?? 0,
      };
    }
  }

  async refresh(): Promise<void> {
    const dirs = ["", ...this.open];
    const [statusRes, ...dirResults] = await Promise.all([
      api.git.status.get(),
      ...dirs.map((d) => api.files.get({ query: { path: d } })),
    ]);

    if (statusRes.error) {
      console.warn("failed to fetch git status", statusRes.error);
      this.status = {};
    } else if (statusRes.data) {
      this.status = statusRes.data.files;
      this.lineStats = {
        additions: statusRes.data.additions ?? 0,
        deletions: statusRes.data.deletions ?? 0,
      };
    }

    const nextEntries = new Map(this.entries);
    const nextDirErrors = new Map(this.dirErrors);

    dirs.forEach((d, i) => {
      const res = dirResults[i];
      if (res.data) {
        nextEntries.set(d, res.data.entries);
        nextDirErrors.delete(d);
      } else if (res.error) {
        const val = (res.error as { value?: unknown })?.value as
          | { error?: string }
          | undefined;
        const msg = val?.error ?? "failed to load directory";
        if (d === "") {
          this.loadError = msg;
        } else {
          nextDirErrors.set(d, msg);
        }
      }
    });

    this.entries = nextEntries;
    this.dirErrors = nextDirErrors;
  }

  async toggle(dir: string): Promise<void> {
    if (this.open.has(dir)) {
      const nextOpen = new Set(this.open);
      nextOpen.delete(dir);
      this.open = nextOpen;
      return;
    }

    const nextOpen = new Set(this.open);
    nextOpen.add(dir);
    this.open = nextOpen;

    if (!this.entries.has(dir)) {
      const nextLoading = new Set(this.loading);
      nextLoading.add(dir);
      this.loading = nextLoading;

      try {
        const { data, error } = await api.files.get({ query: { path: dir } });
        if (error) {
          const val = (error as { value?: unknown })?.value as
            | { error?: string }
            | undefined;
          const nextErrors = new Map(this.dirErrors);
          nextErrors.set(dir, val?.error ?? "failed to load directory");
          this.dirErrors = nextErrors;
        } else if (data) {
          const nextEntries = new Map(this.entries);
          nextEntries.set(dir, data.entries);
          this.entries = nextEntries;
          if (this.dirErrors.has(dir)) {
            const nextErrors = new Map(this.dirErrors);
            nextErrors.delete(dir);
            this.dirErrors = nextErrors;
          }
        }
      } finally {
        const doneLoading = new Set(this.loading);
        doneLoading.delete(dir);
        this.loading = doneLoading;
      }
    }
  }

  async openFile(path: string, modeHint?: "diff"): Promise<void> {
    this.previewModeHint = modeHint ?? null;
    this.diff = null;
    const { data, error } = await api.files.content.get({ query: { path } });
    if (error) {
      const val = (error as { value?: unknown })?.value as
        | { error?: string }
        | undefined;
      this.preview = {
        path,
        content: "",
        language: "plaintext",
        size: 0,
        binary: false,
        error: val?.error ?? "failed to read file",
      };
    } else if (data) {
      this.preview = {
        path: data.path,
        content: data.content,
        language: data.language,
        size: data.size,
        binary: data.binary,
      };
    }
    void this.loadDiff();
  }

  async loadDiff(): Promise<void> {
    if (!this.preview) return;
    const p = this.preview.path;
    try {
      const res = await api.git.diff.get({ query: { path: p } });
      if (res.data) {
        this.diff = { path: p, supported: res.data.supported, patch: res.data.patch };
      } else {
        this.diff = { path: p, supported: false };
      }
    } catch {
      this.diff = { path: p, supported: false };
    }
  }

  async search(q: string): Promise<void> {
    this.searchQuery = q;
    const trimmed = q.trim();
    if (!trimmed) {
      this.searchMatches = null;
      this.searching = false;
      this.searchError = false;
      return;
    }
    this.searching = true;
    this.searchError = false;
    try {
      const res = await api.files.search.get({ query: { q: trimmed } });
      if (res.error) {
        this.searchError = true;
        this.searchMatches = null;
      } else if (res.data) {
        this.searchMatches = res.data.matches;
      }
    } catch {
      this.searchError = true;
      this.searchMatches = null;
    } finally {
      this.searching = false;
    }
  }

  clearSearch(): void {
    this.searchQuery = "";
    this.searchMatches = null;
    this.searching = false;
    this.searchError = false;
  }

  toggleChangesView(): void {
    this.changesView = !this.changesView;
  }

  closePreview(): void {
    this.preview = null;
    this.previewModeHint = null;
    this.diff = null;
  }

  childrenOf(dir: string): FileEntry[] {
    return this.entries.get(dir) ?? [];
  }

  codeFor(path: string): GitFileCode | undefined {
    return this.status?.[path];
  }

  get changesCount(): number {
    return this.status ? Object.keys(this.status).length : 0;
  }

  dirChanged(dir: string): boolean {
    if (!this.status) return false;
    const prefix = dir === "" ? "" : dir + "/";
    for (const p of Object.keys(this.status)) {
      if (dir === "" ? p.length > 0 : p.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }
}

export const files = new FilesStore();
