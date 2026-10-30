import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const webSrc = join(root, "web", "src");
const settingsPanelPath = join(webSrc, "lib", "SettingsPanel.svelte");
const sidebarPath = join(webSrc, "lib", "Sidebar.svelte");
const appCssPath = join(webSrc, "app.css");
const packageJsonPath = join(root, "package.json");

function walkSvelteFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSvelteFiles(full));
    } else if (entry.name.endsWith(".svelte")) {
      files.push(full);
    }
  }
  return files;
}

test("only the brand mark hand-draws svg markup", () => {
  const filesWithSvg = walkSvelteFiles(webSrc)
    .filter((file) => /<svg[\s>]/.test(readFileSync(file, "utf-8")))
    .map((file) => relative(webSrc, file))
    .sort();

  expect(filesWithSvg).toEqual(["lib/Mark.svelte"]);
});

test("settings tabs and sidebar foot use the lucide section icons", () => {
  const settingsPanel = readFileSync(settingsPanelPath, "utf-8");
  const sidebar = readFileSync(sidebarPath, "utf-8");

  const lucideImportRegex = /import\s+\{([^}]+)\}\s+from\s+["']@lucide\/svelte["']/;
  const settingsImportMatch = settingsPanel.match(lucideImportRegex);
  expect(settingsImportMatch).not.toBeNull();
  const settingsImports = settingsImportMatch![1].split(",").map((s) => s.trim());
  expect(settingsImports).toContain("Bot");
  expect(settingsImports).toContain("Layers");
  expect(settingsImports).toContain("Settings2");

  const sidebarImportMatch = sidebar.match(lucideImportRegex);
  expect(sidebarImportMatch).not.toBeNull();
  const sidebarImports = sidebarImportMatch![1].split(",").map((s) => s.trim());
  expect(sidebarImports).toContain("Bot");
  expect(sidebarImports).toContain("Layers");
  expect(sidebarImports).toContain("Settings2");

  expect(settingsPanel).toMatch(/<Settings2\b[^>]*\/>\s*<span>General<\/span>/);
  expect(settingsPanel).toMatch(/<Bot\b[^>]*\/>\s*<span>Agents<\/span>/);
  expect(settingsPanel).toMatch(/<Layers\b[^>]*\/>\s*<span>Pools<\/span>/);

  expect(sidebar).toMatch(/s\.id === "agents"[\s\S]*?<Bot\b[^>]*\/>/);
  expect(sidebar).toMatch(/s\.id === "pools"[\s\S]*?<Layers\b[^>]*\/>/);
  expect(sidebar).toMatch(/else[\s\S]*?<Settings2\b[^>]*\/>/);
});

test("lucide section icons keep currentColor and the pinned css sizing", () => {
  const settingsPanel = readFileSync(settingsPanelPath, "utf-8");
  const sidebar = readFileSync(sidebarPath, "utf-8");

  expect(settingsPanel).not.toMatch(/<(Settings2|Bot|Layers)\b[^>]*\bcolor=/);
  expect(sidebar).not.toMatch(/<(Settings2|Bot|Layers)\b[^>]*\bcolor=/);

  const css = readFileSync(appCssPath, "utf-8");
  expect(css).toMatch(/\.settings-tab svg\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;[^}]*\}/);
  expect(css).toMatch(/\.foot-btn svg\s*\{[^}]*width:\s*14px;[^}]*height:\s*14px;[^}]*\}/);
});

test("no new icon dependency is introduced", () => {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  expect(pkg.dependencies["@lucide/svelte"]).toBe("^1.64.0");

  const depNames = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})];
  const iconPackages = depNames.filter((d) => d.includes("icon") || d.includes("lucide"));
  expect(iconPackages).toEqual(["@lucide/svelte"]);

  const settingsPanel = readFileSync(settingsPanelPath, "utf-8");
  const sidebar = readFileSync(sidebarPath, "utf-8");

  for (const content of [settingsPanel, sidebar]) {
    expect(content).toMatch(/from\s+["']@lucide\/svelte["']/);
    expect(content).not.toMatch(/from\s+["'][^"']*(?:icon|heroicons|feather|font-awesome)[^"']*["']/i);
  }
});
