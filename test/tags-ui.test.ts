import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cardPath = join(import.meta.dir, "..", "web", "src", "lib", "Card.svelte");
const cardSource = readFileSync(cardPath, "utf-8");

const detailPath = join(import.meta.dir, "..", "web", "src", "lib", "TaskDetail.svelte");
const detailSource = readFileSync(detailPath, "utf-8");

const appPath = join(import.meta.dir, "..", "web", "src", "App.svelte");
const appSource = readFileSync(appPath, "utf-8");

const editorPath = join(import.meta.dir, "..", "web", "src", "lib", "TaskEditor.svelte");
const editorSource = readFileSync(editorPath, "utf-8");

describe("tag-lite UI rendering and wiring (AC2, AC3)", () => {
  test("Card.svelte renders tag chips after the project chip in .card-meta", () => {
    expect(cardSource).toContain('{#if task.tags.length > 0}{#each task.tags as tag (tag)}<span class="chip tag">#{tag}</span>{/each}{/if}');

    const metaIdx = cardSource.indexOf('<div class="card-meta">');
    expect(metaIdx).toBeGreaterThan(-1);

    const projectIdx = cardSource.indexOf('{#if task.project}<span class="chip">{task.project}</span>{/if}', metaIdx);
    expect(projectIdx).toBeGreaterThan(metaIdx);

    const tagsIdx = cardSource.indexOf('{#if task.tags.length > 0}', projectIdx);
    expect(tagsIdx).toBeGreaterThan(projectIdx);
  });

  test("TaskDetail.svelte renders tag chips after the project chip in the detail head", () => {
    expect(detailSource).toContain('{#if me.tags.length > 0}{#each me.tags as tag (tag)}<span class="chip tag">#{tag}</span>{/each}{/if}');

    const headIdx = detailSource.indexOf('<div class="detail-head">');
    expect(headIdx).toBeGreaterThan(-1);

    const projectIdx = detailSource.indexOf('{#if me.project}<span class="chip">{me.project}</span>{/if}', headIdx);
    expect(projectIdx).toBeGreaterThan(headIdx);

    const tagsIdx = detailSource.indexOf('{#if me.tags.length > 0}', projectIdx);
    expect(tagsIdx).toBeGreaterThan(projectIdx);
  });

  test("App.svelte header renders one toggle chip per derived tag with active state", () => {
    const chipsIdx = appSource.indexOf('<div class="chips">');
    expect(chipsIdx).toBeGreaterThan(-1);

    const tagsBlock = appSource.indexOf("{#if board.tags.length > 0}", chipsIdx);
    expect(tagsBlock).toBeGreaterThan(chipsIdx);
    expect(appSource.slice(tagsBlock)).toContain("{#each board.tags as tag (tag)}");
    expect(appSource.slice(tagsBlock)).toContain('class:active={board.tagFilter.includes(tag)}');
    expect(appSource.slice(tagsBlock)).toContain('title="filter tag (AND)"');
    expect(appSource.slice(tagsBlock)).toContain("#{tag}");
  });

  test("TaskEditor.svelte edits tags as space-separated free text with a datalist of known tags", () => {
    expect(editorSource).toContain('let tagsText = $state(source.tags.join(" "));');
    expect(editorSource).toContain('<input list="editor-tags" bind:value={tagsText} placeholder="space separated" />');
    expect(editorSource).toContain('<datalist id="editor-tags">');
    expect(editorSource).toContain("{#each board.tags as t (t)}<option value={t}></option>{/each}");
    expect(editorSource).toContain("tags: tagsText.split(/[\\s,]+/).filter(Boolean)");
  });
});
