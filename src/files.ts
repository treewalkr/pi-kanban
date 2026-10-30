import { readdirSync, readFileSync, statSync, type Dirent, type Stats } from "node:fs";
import * as path from "node:path";
import { KanbanError } from "./db";

export interface FileEntry {
  name: string;
  isDir: boolean;
}

export const PREVIEW_MAX_BYTES = 512 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  json: "text/plain; charset=utf-8",
  ts: "text/plain; charset=utf-8",
  tsx: "text/plain; charset=utf-8",
  js: "text/plain; charset=utf-8",
  mjs: "text/plain; charset=utf-8",
  cjs: "text/plain; charset=utf-8",
  css: "text/plain; charset=utf-8",
  html: "text/plain; charset=utf-8",
  xml: "text/plain; charset=utf-8",
  yml: "text/plain; charset=utf-8",
  yaml: "text/plain; charset=utf-8",
  toml: "text/plain; charset=utf-8",
  sh: "text/plain; charset=utf-8",
};

export function contentTypeFor(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export const EXT_TO_HLJS: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  css: "css",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  svelte: "xml",
  py: "python",
  rs: "rust",
  go: "go",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  diff: "diff",
  patch: "diff",
};

export function languageForPath(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return EXT_TO_HLJS[ext] ?? "plaintext";
}

function resolveSafe(root: string, relPath: string): string {
  const rootResolved = path.resolve(root);
  const target = path.isAbsolute(relPath)
    ? path.resolve(relPath)
    : path.resolve(rootResolved, relPath);

  const rootWithSep = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  const isInside = target === rootResolved || target.startsWith(rootWithSep);
  if (!isInside) {
    throw new KanbanError(`path escapes repo root: '${relPath}'`, "invalid");
  }
  return target;
}

export async function listFiles(root: string, dirPath: string): Promise<FileEntry[]> {
  const target = resolveSafe(root, dirPath);
  let dirents: Dirent[];
  try {
    dirents = readdirSync(target, { withFileTypes: true });
  } catch (err: any) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") {
      throw new KanbanError(`no such directory: '${dirPath}'`, "not-found");
    }
    throw err;
  }

  const entries: FileEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name === ".git" || dirent.name === ".DS_Store") {
      continue;
    }
    let isDir = false;
    if (dirent.isDirectory()) {
      isDir = true;
    } else if (dirent.isFile()) {
      isDir = false;
    } else {
      try {
        const s = statSync(path.join(target, dirent.name));
        if (s.isDirectory()) {
          isDir = true;
        } else if (s.isFile()) {
          isDir = false;
        } else {
          continue;
        }
      } catch {
        continue;
      }
    }
    entries.push({ name: dirent.name, isDir });
  }

  entries.sort((a, b) =>
    a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)
  );

  return entries;
}

export async function rawFilePath(root: string, relPath: string): Promise<string> {
  const target = resolveSafe(root, relPath);
  let s: Stats;
  try {
    s = statSync(target);
  } catch (err: any) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") {
      throw new KanbanError(`no such file: '${relPath}'`, "not-found");
    }
    throw err;
  }
  if (s.isDirectory()) {
    throw new KanbanError(`no such file: '${relPath}'`, "not-found");
  }
  return target;
}

export async function readFile(
  root: string,
  filePath: string
): Promise<{ content: string; language: string }> {
  const target = resolveSafe(root, filePath);
  let s: Stats;
  try {
    s = statSync(target);
  } catch (err: any) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") {
      throw new KanbanError(`no such file: '${filePath}'`, "not-found");
    }
    throw err;
  }
  if (s.isDirectory()) {
    throw new KanbanError(`no such file: '${filePath}'`, "not-found");
  }
  if (s.size > PREVIEW_MAX_BYTES) {
    throw new KanbanError("file exceeds the 512 KB preview limit", "invalid");
  }

  const buffer = readFileSync(target);
  const checkLen = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) {
      throw new KanbanError("binary file — no preview", "invalid");
    }
  }

  const content = buffer.toString("utf-8");
  const language = languageForPath(filePath);
  return { content, language };
}
