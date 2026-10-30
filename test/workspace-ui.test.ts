import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cardPath = join(import.meta.dir, "..", "web", "src", "lib", "Card.svelte");
const cardSource = readFileSync(cardPath, "utf-8");

const detailPath = join(import.meta.dir, "..", "web", "src", "lib", "TaskDetail.svelte");
const detailSource = readFileSync(detailPath, "utf-8");

const boardStorePath = join(import.meta.dir, "..", "web", "src", "lib", "board.svelte.ts");
const boardStoreSource = readFileSync(boardStorePath, "utf-8");

const appPath = join(import.meta.dir, "..", "web", "src", "App.svelte");
const appSource = readFileSync(appPath, "utf-8");

describe("workspace UI rendering and wiring (AC1, AC2, AC5)", () => {
  test("Card.svelte renders a workspace chip bound to board.workspaces", () => {
    expect(cardSource).toContain("GitBranch");
    expect(cardSource).toContain("{#if board.workspaces[task.id]}");
    expect(cardSource).toContain("{@const ws = board.workspaces[task.id]}");
    expect(cardSource).toContain('<span class="chip ws"');
    expect(cardSource).toContain('title={ws.path ?? "branch exists — no worktree checked out"}>');
    expect(cardSource).toContain("<GitBranch size={11} strokeWidth={1.75} /> {ws.branch}");

    // Chip lives inside .card-meta immediately after project chip
    const metaIdx = cardSource.indexOf('<div class="card-meta">');
    expect(metaIdx).toBeGreaterThan(-1);

    const projectIdx = cardSource.indexOf("{#if task.project}<span class=\"chip\">{task.project}</span>{/if}", metaIdx);
    expect(projectIdx).toBeGreaterThan(metaIdx);

    const wsIdx = cardSource.indexOf("{#if board.workspaces[task.id]}", projectIdx);
    expect(wsIdx).toBeGreaterThan(projectIdx);
  });

  test("TaskDetail.svelte renders the workspace chip in the detail head", () => {
    expect(detailSource).toContain("GitBranch");
    expect(detailSource).toContain("{#if board.workspaces[me.id]}");
    expect(detailSource).toContain("{@const ws = board.workspaces[me.id]}");
    expect(detailSource).toContain('<span class="chip ws"');
    expect(detailSource).toContain('title={ws.path ?? "branch exists — no worktree checked out"}>');
    expect(detailSource).toContain("<GitBranch size={11} strokeWidth={1.75} /> {ws.branch}");

    // Chip lives inside .detail-head after project chip
    const headIdx = detailSource.indexOf('<div class="detail-head">');
    expect(headIdx).toBeGreaterThan(-1);

    const projectIdx = detailSource.indexOf("{#if me.project}<span class=\"chip\">{me.project}</span>{/if}", headIdx);
    expect(projectIdx).toBeGreaterThan(headIdx);

    const wsIdx = detailSource.indexOf("{#if board.workspaces[me.id]}", projectIdx);
    expect(wsIdx).toBeGreaterThan(projectIdx);
  });

  test("board store carries workspaces and App polls board refresh", () => {
    // board.svelte.ts has state and assigns workspaces in refresh()
    expect(boardStoreSource).toContain("workspaces = $state<Record<string, CardWorkspace>>({});");
    expect(boardStoreSource).toContain("this.workspaces = boardRes.data.workspaces ?? {};");

    // App.svelte 10s git interval polls board.refresh guarded by !board.editing
    expect(appSource).toContain("10_000");
    expect(appSource).toContain("void ui.loadGit();");
    expect(appSource).toContain("if (!board.editing) board.refresh();");
  });
});
