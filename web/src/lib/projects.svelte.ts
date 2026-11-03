import { api } from "../api";
import type { ProjectRoute } from "../../../src/db";
import type { DirListing } from "../../../src/files";
import { board } from "./board.svelte";

type EdenError = { value?: unknown };

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Project routes for the settings dialog's Projects section; loads lazily on first view. */
class ProjectsStore {
  loaded = $state(false);
  /** True when the last GET /projects failed — the panel distinguishes this from loading. */
  loadFailed = $state(false);
  projects = $state<ProjectRoute[]>([]);
  /** Last server-confirmed routes: the close guard's baseline. */
  private saved = $state<ProjectRoute[]>([]);

  /** True when a row's repo path or test gate differs from the saved state. */
  get dirty(): boolean {
    return JSON.stringify(this.projects) !== JSON.stringify(this.saved);
  }

  /** Per-row dirty check for the ghost-until-dirty save button. */
  isDirty(route: ProjectRoute): boolean {
    const saved = this.saved.find((p) => p.name === route.name);
    if (!saved) return false;
    return saved.repoPath !== (route.repoPath ?? null) || saved.testGate !== route.testGate;
  }

  /** Drop unsaved edits (close guard → discard). */
  revert(): void {
    this.projects = clone(this.saved);
  }

  private snapshot(): void {
    this.saved = clone(this.projects);
  }

  private fail(error: EdenError): void {
    const value = error.value as { error?: string } | undefined;
    board.error = value?.error ?? "request failed";
  }

  async load(): Promise<void> {
    this.loadFailed = false;
    const res = await api.projects.get();
    if (res.error) {
      this.fail(res.error);
      this.loadFailed = true;
    } else {
      this.projects = res.data.projects;
      this.loaded = true;
      this.snapshot();
    }
  }

  async listDirs(dirPath = ""): Promise<DirListing | null> {
    const { data, error } = await api.fs.dirs.get({ query: { path: dirPath } });
    if (error) {
      this.fail(error);
      return null;
    }
    return data as DirListing;
  }

  /** POST /fs/mkdir; returns the created absolute path, or null with the message in board.error. */
  async makeDir(parentPath: string, name: string): Promise<{ path: string } | null> {
    const { data, error } = await api.fs.mkdir.post({ path: parentPath, name });
    if (error) {
      this.fail(error);
      return null;
    }
    return data as { path: string };
  }

  async save(route: { name: string; repoPath: string | null; testGate: boolean }): Promise<boolean> {
    const { data, error } = await api.projects({ name: route.name }).put({
      repoPath: route.repoPath,
      testGate: route.testGate,
    });
    if (error) {
      this.fail(error);
      return false;
    }
    const saved = (data as { project: ProjectRoute }).project;
    const idx = this.projects.findIndex((p) => p.name === saved.name);
    if (idx !== -1) this.projects[idx] = saved;
    else {
      this.projects = [...this.projects, saved].sort((a, b) => a.name.localeCompare(b.name));
    }
    this.snapshot();
    return true;
  }
}

export const projects = new ProjectsStore();
