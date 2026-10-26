import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const faviconPath = join(root, "web", "public", "favicon.svg");
const indexPath = join(root, "web", "index.html");

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
