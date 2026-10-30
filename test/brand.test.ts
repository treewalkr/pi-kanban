import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCRAMBLE_CHARS,
  SCRAMBLE_FRAMES_PER_CHAR,
  scrambleFrame,
  scrambleFrameCount,
  VERSION_SHOWN_MS,
} from "../web/src/lib/scramble";

const root = join(import.meta.dir, "..");
const brandPath = join(root, "web", "src", "lib", "Brand.svelte");
const sidebarPath = join(root, "web", "src", "lib", "Sidebar.svelte");
const cssPath = join(root, "web", "src", "app.css");
const viteConfigPath = join(root, "vite.config.ts");

/** A fixed sequence for Math.random's place. */
function sequence(...values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length];
}

test("the scramble keeps the length and the spaces and settles left to right", () => {
  const target = "kanban";
  const total = scrambleFrameCount(target);
  expect(total).toBe(target.length * SCRAMBLE_FRAMES_PER_CHAR);
  expect(VERSION_SHOWN_MS).toBe(3000);

  // The first frame: nothing settled, every character from the set.
  const pick = (value: number) => SCRAMBLE_CHARS[Math.floor(value * SCRAMBLE_CHARS.length)];
  const first = scrambleFrame(target, 0, sequence(0, 0.5, 0.99));
  expect(first.length).toBe(target.length);
  for (const char of first) expect(SCRAMBLE_CHARS.includes(char)).toBe(true);
  expect(first).toBe(`${pick(0)}${pick(0.5)}${pick(0.99)}${pick(0)}${pick(0.5)}${pick(0.99)}`);

  // Spaces survive untouched (a multi-part version keeps its gaps).
  expect(scrambleFrame("a b", 0, () => 0)).toBe(`${pick(0)} ${pick(0)}`);

  // Halfway, the first half is final.
  const half = scrambleFrame(target, total / 2, () => 0);
  expect(half.slice(0, 3)).toBe("kan");
  expect(half.slice(3)).toBe("AAA");

  // From the last frame on, the text itself; every frame before has its length.
  expect(scrambleFrame(target, total)).toBe(target);
  expect(scrambleFrame(target, total + 5)).toBe(target);
  for (let frame = 0; frame < total; frame++) expect(scrambleFrame(target, frame).length).toBe(target.length);
});

test("the brand is a button named for what its click shows, with the mark", () => {
  const brand = readFileSync(brandPath, "utf8");
  expect(brand).toContain('type="button"');
  expect(brand).toContain('class:is-version={versionShown}');
  expect(brand).toContain('aria-label={`kanban, version ${__APP_VERSION__}`}');
  expect(brand).toContain('<Mark />');
  expect(brand).not.toContain("style=");
  // Reduced motion swaps the text at once instead of scrambling.
  expect(brand).toContain("prefers-reduced-motion");
  // A second click takes the version back down at once.
  expect(brand).toContain("if (versionShown)");
});

test("the sidebar renders the brand where the plain div used to be", () => {
  const sidebar = readFileSync(sidebarPath, "utf8");
  expect(sidebar).toContain('import Brand from "./Brand.svelte";');
  expect(sidebar).toContain("<Brand />");
  expect(sidebar).not.toContain('class="sidebar-brand"');
});

test("the version reaches the brand through vite's define", () => {
  const config = readFileSync(viteConfigPath, "utf8");
  expect(config).toContain("__APP_VERSION__");
  expect(config).toContain("package.json");
  expect(existsSync(join(root, "web", "src", "vite-env.d.ts"))).toBe(true);
});

test("the brand's look: no box, keyboard-only ring, version in the accent", () => {
  const css = readFileSync(cssPath, "utf8");
  const start = css.indexOf(".sidebar-brand {");
  const block = css.slice(start, css.indexOf("}", start));
  expect(block).toContain("background: transparent");
  expect(block).toContain("border: 0");
  expect(css).toContain(".sidebar-brand:focus-visible");
  const version = css.slice(css.indexOf(".sidebar-brand.is-version {"));
  expect(version.slice(0, version.indexOf("}"))).toContain("color: var(--accent)");
});
