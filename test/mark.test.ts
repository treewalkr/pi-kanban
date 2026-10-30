import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const faviconPath = join(root, "web", "public", "favicon.svg");
const indexPath = join(root, "web", "index.html");
const markPath = join(root, "web", "src", "lib", "Mark.svelte");
const appCssPath = join(root, "web", "src", "app.css");
const appPath = join(root, "web", "src", "lib", "Sidebar.svelte");
const brandPath = join(root, "web", "src", "lib", "Brand.svelte");
const galleryPath = join(root, "web", "src", "gallery", "Gallery.svelte");

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function hexToLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  const num = parseInt(clean, 16);
  const r = ((num >> 16) & 255) / 255;
  const g = ((num >> 8) & 255) / 255;
  const b = (num & 255) / 255;
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrast(hex1: string, hex2: string): number {
  const l1 = hexToLuminance(hex1);
  const l2 = hexToLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

interface RectGeometry {
  x: string;
  y: string;
  width: string;
  height: string;
  rx: string;
}

function extractRectGeometries(svgContent: string): RectGeometry[] {
  const rectMatches = Array.from(svgContent.matchAll(/<rect\s+([^>]+)\/>/g));
  return rectMatches.map((m) => {
    const attrs = m[1];
    const get = (name: string) => attrs.match(new RegExp(`${name}="([^"]+)"`))?.[1] ?? "";
    return {
      x: get("x"),
      y: get("y"),
      width: get("width"),
      height: get("height"),
      rx: get("rx"),
    };
  });
}

test("favicon.svg serves a three-bar transparent mark at 16×16", () => {
  expect(existsSync(faviconPath)).toBe(true);
  const content = readFileSync(faviconPath, "utf-8");

  expect(content).toContain('viewBox="0 0 16 16"');

  const rectMatches = Array.from(content.matchAll(/<rect\s+([^>]+)\/>/g));
  expect(rectMatches.length).toBe(3);

  for (const match of rectMatches) {
    const attrs = match[1];
    expect(attrs).toContain('fill="#648ee1"');

    // Ensure no background rect spanning full 16x16
    const widthMatch = attrs.match(/width="([^"]+)"/);
    const heightMatch = attrs.match(/height="([^"]+)"/);
    expect(widthMatch).not.toBeNull();
    expect(heightMatch).not.toBeNull();
    const w = parseFloat(widthMatch![1]);
    const h = parseFloat(heightMatch![1]);
    expect(w).toBeLessThan(16);
    expect(h).toBeLessThan(16);
  }
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

  expect(faviconContent).toContain('viewBox="0 0 16 16"');
  expect(markContent).toContain('viewBox="0 0 16 16"');

  const faviconRects = extractRectGeometries(faviconContent);
  const markRects = extractRectGeometries(markContent);

  expect(faviconRects.length).toBe(3);
  expect(markRects).toEqual(faviconRects);
});

test("header mark is theme-driven via currentColor and --accent", () => {
  const markContent = readFileSync(markPath, "utf-8");
  const markRects = Array.from(markContent.matchAll(/<rect\s+([^>]+)\/>/g));
  expect(markRects.length).toBe(3);

  for (const match of markRects) {
    expect(match[1]).toContain('fill="currentColor"');
  }
  expect(markContent).not.toMatch(/#[0-9a-fA-F]{3,8}/);

  const cssContent = readFileSync(appCssPath, "utf-8");
  const markCssMatch = cssContent.match(/\.mark\s*\{([^}]+)\}/);
  expect(markCssMatch).not.toBeNull();
  const markCss = markCssMatch![1];
  expect(markCss).toContain("color: var(--accent);");
  expect(markCss).not.toContain("background");
});

test("mark has no sub-pixel detail", () => {
  const faviconContent = readFileSync(faviconPath, "utf-8");
  const markContent = readFileSync(markPath, "utf-8");

  for (const content of [faviconContent, markContent]) {
    expect(content).not.toContain("stroke");
    const rects = extractRectGeometries(content);
    for (const r of rects) {
      expect(parseFloat(r.width)).toBeGreaterThanOrEqual(3);
    }
  }
});

test("both headers render the shared mark component", () => {
  const appContent = readFileSync(appPath, "utf-8");
  const galleryContent = readFileSync(galleryPath, "utf-8");
  const brandContent = readFileSync(brandPath, "utf-8");

  // The sidebar's mark lives in the brand button (web/src/lib/Brand.svelte).
  expect(appContent).toContain('import Brand from "./Brand.svelte";');
  expect(appContent).toContain("<Brand />");
  expect(appContent).not.toContain('<span class="mark">');
  expect(brandContent).toContain('import Mark from "./Mark.svelte";');
  expect(brandContent).toContain("<Mark />");

  expect(galleryContent).toContain('import Mark from "../lib/Mark.svelte";');
  expect(galleryContent).toContain("<Mark />");
  expect(galleryContent).not.toContain('<span class="mark">');
});
