import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { iconFor, type IconName } from "../web/src/lib/fileIcons";

describe("file icons", () => {
  test("iconFor maps extensions and special names (port of pi-web FileIcons)", () => {
    expect(iconFor("a.ts")).toBe("typescript");
    expect(iconFor("Dockerfile")).toBe("docker");
    expect(iconFor(".env")).toBe("env");
    expect(iconFor("bun.lock")).toBe("bun-lock");
    expect(iconFor("x.unknown")).toBe("_file");

    const expectedIcons: IconName[] = [
      "_file",
      "_folder",
      "_folder_open",
      "bash",
      "config",
      "css",
      "database",
      "docker",
      "env",
      "git",
      "graphql",
      "html",
      "javascript",
      "javascript-react",
      "json",
      "lock",
      "npm-lock",
      "bun-lock",
      "next",
      "eslint",
      "markdown",
      "ms-word",
      "pdf",
      "python",
      "rust",
      "sass",
      "terraform",
      "toml",
      "typescript",
      "typescript-react",
      "yaml",
      "go",
    ];

    expect(expectedIcons.length).toBe(32);

    const iconsDir = join(import.meta.dir, "../web/public/icons/catppuccin");
    expect(existsSync(join(iconsDir, "LICENSE"))).toBe(true);

    for (const theme of ["latte", "mocha"]) {
      for (const icon of expectedIcons) {
        const svgPath = join(iconsDir, theme, `${icon}.svg`);
        expect(existsSync(svgPath)).toBe(true);
      }
    }
  });
});
