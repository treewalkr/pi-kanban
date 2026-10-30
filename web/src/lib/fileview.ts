export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function splitHighlightedLines(html: string): string[] {
  if (!html) return [""];
  const lines: string[] = [];
  const openTags: string[] = [];
  let currentLine = "";

  const tokenRegex = /(<\/?[a-zA-Z0-9_-]+(?:\s+[^>]*)?>|\n|[^<\n]+|<)/g;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(html)) !== null) {
    const token = match[0];
    if (token === "\n") {
      let lineEnd = currentLine;
      for (let i = openTags.length - 1; i >= 0; i--) {
        const tagName = openTags[i].match(/^<([a-zA-Z0-9_-]+)/)?.[1] ?? "span";
        lineEnd += `</${tagName}>`;
      }
      lines.push(lineEnd);
      currentLine = openTags.join("");
    } else if (token.startsWith("</")) {
      currentLine += token;
      openTags.pop();
    } else if (token.startsWith("<") && token !== "<" && !token.endsWith("/>")) {
      currentLine += token;
      openTags.push(token);
    } else {
      currentLine += token;
    }
  }

  let lineEnd = currentLine;
  for (let i = openTags.length - 1; i >= 0; i--) {
    const tagName = openTags[i].match(/^<([a-zA-Z0-9_-]+)/)?.[1] ?? "span";
    lineEnd += `</${tagName}>`;
  }
  lines.push(lineEnd);

  return lines;
}

export type DiffLine = {
  kind: "add" | "del" | "ctx";
  text: string;
  oldNo?: number;
  newNo?: number;
};

export function parseUnifiedDiff(patch: string): DiffLine[] {
  if (!patch || !patch.includes("@@ ")) return [];

  const rawLines = patch.split(/\r?\n/);
  const diffLines: DiffLine[] = [];
  let inHunk = false;
  let currentOld = 0;
  let currentNew = 0;

  for (const line of rawLines) {
    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      inHunk = true;
      currentOld = parseInt(hunkMatch[1], 10);
      currentNew = parseInt(hunkMatch[2], 10);
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith("\\")) {
      continue;
    }

    if (line.startsWith("+")) {
      diffLines.push({
        kind: "add",
        text: line.slice(1),
        newNo: currentNew++,
      });
    } else if (line.startsWith("-")) {
      diffLines.push({
        kind: "del",
        text: line.slice(1),
        oldNo: currentOld++,
      });
    } else if (line.startsWith(" ") || line === "") {
      diffLines.push({
        kind: "ctx",
        text: line.startsWith(" ") ? line.slice(1) : line,
        oldNo: currentOld++,
        newNo: currentNew++,
      });
    } else {
      inHunk = false;
    }
  }

  return diffLines;
}

export type DiffSegment =
  | { kind: "lines"; lines: DiffLine[] }
  | { kind: "gap"; count: number };

export function collapseDiff(lines: DiffLine[], context = 3): DiffSegment[] {
  if (lines.length === 0) return [];

  const changedIndices: number[] = [];
  lines.forEach((l, idx) => {
    if (l.kind === "add" || l.kind === "del") {
      changedIndices.push(idx);
    }
  });

  const visible = new Set<number>();
  for (const ci of changedIndices) {
    const start = Math.max(0, ci - context);
    const end = Math.min(lines.length - 1, ci + context);
    for (let j = start; j <= end; j++) {
      visible.add(j);
    }
  }

  const segments: DiffSegment[] = [];
  let i = 0;
  while (i < lines.length) {
    if (visible.has(i)) {
      const block: DiffLine[] = [];
      while (i < lines.length && visible.has(i)) {
        block.push(lines[i]);
        i++;
      }
      segments.push({ kind: "lines", lines: block });
    } else {
      let count = 0;
      while (i < lines.length && !visible.has(i)) {
        count++;
        i++;
      }
      segments.push({ kind: "gap", count });
    }
  }

  return segments;
}

export interface SearchNode {
  name: string;
  path: string;
  isDir: boolean;
  children: SearchNode[];
}

export function buildSearchTree(paths: string[]): SearchNode[] {
  const roots: SearchNode[] = [];
  const byPath = new Map<string, SearchNode>();

  for (const relative of paths) {
    const segments = relative.split("/");
    let current = roots;
    let currentPath = "";
    for (let i = 0; i < segments.length; i++) {
      currentPath = currentPath ? `${currentPath}/${segments[i]}` : segments[i];
      let node = byPath.get(currentPath);
      if (!node) {
        node = {
          name: segments[i],
          path: currentPath,
          isDir: i < segments.length - 1,
          children: [],
        };
        byPath.set(currentPath, node);
        current.push(node);
      }
      current = node.children;
    }
  }

  const sort = (nodes: SearchNode[]) => {
    nodes.sort((a, b) =>
      a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)
    );
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "avif",
  "ico",
]);

export function isImagePath(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
