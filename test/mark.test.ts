import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const faviconPath = join(root, "web", "public", "favicon.svg");
const indexPath = join(root, "web", "index.html");
const markPath = join(root, "web", "src", "lib", "Mark.svelte");
const appCssPath = join(root, "web", "src", "app.css");
const appPath = join(root, "web", "src", "lib", "Sidebar.svelte");
const galleryPath = join(root, "web", "src", "gallery", "Gallery.svelte");

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function hexToLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  const num = parseInt(clean, 16);
  const r = ((num >> 16) & 0xff) / 255;
  const g = ((num >> 8) & 0xff) / 255;
  const b = ((num >> 0) & 0xff) / 255;
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrast(hex1: string, hex2: string): number {
  const l1 = hexToLuminance(hex1);
  const l2 = hexToLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** The `d` of every path, in order. */
function extractPaths(svgContent: string): string[] {
  return Array.from(svgContent.matchAll(/<path\s+[^>]*d="([^"]+)"/g)).map((m) => m[1]);
}

test("favicon.svg serves the lucide kanban glyph at 24×24", () => {
  expect(existsSync(faviconPath)).toBe(true);
  const content = readFileSync(faviconPath, "utf-8");

  expect(content).toContain('viewBox="0 0 24 24"');
  // Three hanging columns, stroked in the brand color, transparent background.
  expect(extractPaths(content)).toEqual(["M5 3v14", "M12 3v8", "M19 3v18"]);
  expect(content).toContain('fill="none"');
  expect(content).toContain('stroke="#648ee1"');
});

test("favicon color is legible on dark and light chrome (WCAG >= 3:1)", () => {
  const color = "#648ee1";
  const whiteContrast = contrast(color, "#ffffff");
  const darkContrast = contrast(color, "#1a1a1a");

  expect(whiteContrast).toBeGreaterThanOrEqual(3);
  expect(darkContrast).toBeGreaterThanOrEqual(3);
});

test("index.html links /favicon.svg and drops the data URI", () => {
  expect(existsSync(faviconPath)).toBe(true);
  const content = readFileSync(indexPath, "utf-8");

  expect(content).toContain('href="/favicon.svg"');
  expect(content).toContain('type="image/svg+xml"');
  expect(content).not.toContain("data:image/svg+xml");
});

test("header mark and favicon share the same geometry", () => {
  const faviconContent = readFileSync(faviconPath, "utf-8");
  const markContent = readFileSync(markPath, "utf-8");

  expect(faviconContent).toContain('viewBox="0 0 24 24"');
  expect(markContent).toContain('viewBox="0 0 24 24"');

  expect(extractPaths(markContent)).toEqual(extractPaths(faviconContent));
  // Same stroke weight, so the favicon and the header read as one glyph.
  const width = (content: string) => content.match(/stroke-width="([^"]+)"/)?.[1];
  expect(width(markContent)).toBe(width(faviconContent));
});

test("header mark is theme-driven via currentColor and --accent", () => {
  const markContent = readFileSync(markPath, "utf-8");
  expect(markContent).toContain('stroke="currentColor"');
  expect(markContent).not.toMatch(/#[0-9a-fA-F]{3,8}/);

  const cssContent = readFileSync(appCssPath, "utf-8");
  const markCssMatch = cssContent.match(/\.mark\s*\{([^}]+)\}/);
  expect(markCssMatch).not.toBeNull();
  const markCss = markCssMatch![1];
  expect(markCss).toContain("color: var(--accent);");
  expect(markCss).not.toContain("background");
});

test("mark stays bold at small sizes: stroke-width 2, round caps", () => {
  for (const path of [faviconPath, markPath]) {
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('stroke-width="2"');
    expect(content).toContain('stroke-linecap="round"');
    // The glyph is pure stroke: no filled shapes hiding in it.
    expect(content).not.toMatch(/<rect/);
    expect(content).not.toMatch(/fill="#/);
  }
});

test("the gallery header renders the shared mark component", () => {
  const appContent = readFileSync(appPath, "utf-8");
  const galleryContent = readFileSync(galleryPath, "utf-8");

  // The sidebar's brand is text-only now (Brand.svelte); the gallery keeps the mark.
  expect(appContent).toContain('import Brand from "./Brand.svelte";');
  expect(appContent).not.toContain("Mark.svelte");
  expect(galleryContent).toContain('import Mark from "../lib/Mark.svelte";');
  expect(galleryContent).toContain("<Mark />");
  expect(galleryContent).not.toContain('<span class="mark">');
});
