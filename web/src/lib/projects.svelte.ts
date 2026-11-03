import { api } from "../api";
import type { ProjectRoute } from "../../../src/db";
import type { DirListing } from "../../../src/files";
import { board } from "./board.svelte";

type EdenError = { value?: unknown };

/** Project routes for the settings dialog's Projects section; loads lazily on first view. */
class ProjectsStore {
  loaded = $state(false);
  projects = $state<ProjectRoute[]>([]);

  private fail(error: EdenError): void {
    const value = error.value as { error?: string } | undefined;
    board.error = value?.error ?? "request failed";
  }

  async load(): Promise<void> {
    const res = await api.projects.get();
    if (res.error) this.fail(res.error);
    else {
      this.projects = res.data.projects;
      this.loaded = true;
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
    return true;
  }
}

export const projects = new ProjectsStore();
