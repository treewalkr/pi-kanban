import { describe, expect, test } from "bun:test";
import type { DirEntry } from "../src/files";
import { filterDirs, projectNameFromPath, projectNameProblem } from "../web/src/lib/projectPicker";

describe("web/src/lib/projectPicker.ts", () => {
  test("filterDirs, projectNameFromPath, and projectNameProblem drive the picker's rows and name guard", () => {
    const dirs: DirEntry[] = [
      { name: "Alpha", path: "/a/Alpha", isGitRepo: false },
      { name: "beta-repo", path: "/a/beta-repo", isGitRepo: true },
      { name: "GAMMA", path: "/a/GAMMA", isGitRepo: false },
    ];

    // filterDirs: case-insensitive substring over names
    expect(filterDirs(dirs, "alpha")).toEqual([dirs[0]]);
    expect(filterDirs(dirs, "BETA")).toEqual([dirs[1]]);
    expect(filterDirs(dirs, "a")).toEqual(dirs); // all contain 'a'

    // blank/whitespace query returns the same array reference content in order
    expect(filterDirs(dirs, "")).toBe(dirs);
    expect(filterDirs(dirs, "   ")).toBe(dirs);

    // no match -> []
    expect(filterDirs(dirs, "xyz")).toEqual([]);

    // projectNameFromPath
    expect(projectNameFromPath("/a/b/")).toBe("b");
    expect(projectNameFromPath("/")).toBe("");
    expect(projectNameFromPath("/a/b")).toBe("b");
    expect(projectNameFromPath("")).toBe("");

    // projectNameProblem
    expect(projectNameProblem("  ", [])).toBe("project name is required");
    expect(projectNameProblem("a".repeat(49), [])).toBe("project name must be 1 to 48 characters");
    expect(projectNameProblem("web", ["web"])).toBe("project 'web' already exists — pick another name");
    expect(projectNameProblem("web", ["other"])).toBeNull();
    expect(projectNameProblem("  valid-name  ", [])).toBeNull();
  });
});
