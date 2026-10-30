import { describe, expect, test } from "bun:test";
import {
  buildSearchTree,
  collapseDiff,
  formatSize,
  isImagePath,
  parseUnifiedDiff,
  splitHighlightedLines,
} from "../web/src/lib/fileview";

describe("fileview helpers", () => {
  test("splitHighlightedLines returns balanced per-line HTML", () => {
    // hljs-typescript sample with multi-line span: line count matches \n+1; each line's <span/</span> counts balance
    const sampleHtml =
      '<span class="hljs-keyword">const</span> x = <span class="hljs-string">"line 1\nline 2\nline 3"</span>;\n<span class="hljs-keyword">export</span> { x };';
    const lines = splitHighlightedLines(sampleHtml);
    expect(lines.length).toBe(4);

    for (const line of lines) {
      const openSpans = (line.match(/<span\b[^>]*>/g) || []).length;
      const closeSpans = (line.match(/<\/span>/g) || []).length;
      expect(openSpans).toBe(closeSpans);
    }

    expect(splitHighlightedLines("")).toEqual([""]);
    expect(splitHighlightedLines("single line")).toEqual(["single line"]);
  });

  test("parseUnifiedDiff + collapseDiff port pi-web's diff view", () => {
    // no @@ -> []
    expect(parseUnifiedDiff("diff --git a b\nindex 123..456\n")).toEqual([]);

    const craftedPatch = `diff --git a/file.ts b/file.ts
index 000..111 100644
--- a/file.ts
+++ b/file.ts
@@ -1,10 +1,10 @@
 line 1
 line 2
 line 3
 line 4
-old 5
+new 5
 line 6
 line 7
 line 8
 line 9
 line 10
\\ No newline at end of file`;

    const diffLines = parseUnifiedDiff(craftedPatch);
    expect(diffLines.length).toBe(11);
    expect(diffLines[0]).toEqual({ kind: "ctx", text: "line 1", oldNo: 1, newNo: 1 });
    expect(diffLines[4]).toEqual({ kind: "del", text: "old 5", oldNo: 5 });
    expect(diffLines[5]).toEqual({ kind: "add", text: "new 5", newNo: 5 });
    expect(diffLines[10]).toEqual({ kind: "ctx", text: "line 10", oldNo: 10, newNo: 10 });

    // only ±3 context visible; hidden run = {kind:"gap", count}
    // line 5 is change (index 4 & 5). Context 3 around them: index 1 to 8 (line 2 to line 9).
    // index 0 (line 1) is outside context -> gap of count 1.
    // index 9, 10 (lines 9? wait: 5 - 3 = 2, so index 1 (line 2) is visible. index 5+3 = 8 (line 9) is visible.
    // index 9, 10 (line 10) is outside -> gap of count 2.
    const segments = collapseDiff(diffLines, 3);
    expect(segments.length).toBe(3);
    expect(segments[0]).toEqual({ kind: "gap", count: 1 });
    expect(segments[1].kind).toBe("lines");
    if (segments[1].kind === "lines") {
      expect(segments[1].lines.length).toBe(8);
      expect(segments[1].lines[0].text).toBe("line 2");
      expect(segments[1].lines[segments[1].lines.length - 1].text).toBe("line 8");
    }
    expect(segments[2]).toEqual({ kind: "gap", count: 2 });
  });

  test("buildSearchTree, isImagePath, formatSize", () => {
    const paths = [
      "src/lib/fileview.ts",
      "src/app.ts",
      "README.md",
      "src/lib/fileIcons.ts",
    ];

    const tree = buildSearchTree(paths);
    // Directories first, then alphabetical: "src" (dir) then "README.md" (file)
    expect(tree.length).toBe(2);
    expect(tree[0].name).toBe("src");
    expect(tree[0].isDir).toBe(true);
    expect(tree[1].name).toBe("README.md");
    expect(tree[1].isDir).toBe(false);

    // Inside src: "lib" (dir) then "app.ts" (file)
    expect(tree[0].children.length).toBe(2);
    expect(tree[0].children[0].name).toBe("lib");
    expect(tree[0].children[0].isDir).toBe(true);
    expect(tree[0].children[1].name).toBe("app.ts");
    expect(tree[0].children[1].isDir).toBe(false);

    // Inside src/lib: fileIcons.ts, fileview.ts
    expect(tree[0].children[0].children.map((c) => c.name)).toEqual([
      "fileIcons.ts",
      "fileview.ts",
    ]);

    // isImagePath
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"]) {
      expect(isImagePath(`test.${ext}`)).toBe(true);
      expect(isImagePath(`UPPER.${ext.toUpperCase()}`)).toBe(true);
    }
    expect(isImagePath("test.ts")).toBe(false);
    expect(isImagePath("test.md")).toBe(false);

    // formatSize
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});
