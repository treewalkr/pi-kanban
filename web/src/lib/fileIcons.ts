export type IconName =
  | "_file"
  | "_folder"
  | "_folder_open"
  | "bash"
  | "config"
  | "css"
  | "database"
  | "docker"
  | "env"
  | "git"
  | "graphql"
  | "html"
  | "javascript"
  | "javascript-react"
  | "json"
  | "lock"
  | "npm-lock"
  | "bun-lock"
  | "next"
  | "eslint"
  | "markdown"
  | "ms-word"
  | "pdf"
  | "python"
  | "rust"
  | "sass"
  | "terraform"
  | "toml"
  | "typescript"
  | "typescript-react"
  | "yaml"
  | "go";

const EXTENSION_ICONS: Record<string, IconName> = {
  ts: "typescript",
  tsx: "typescript-react",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript-react",
  py: "python",
  json: "json",
  jsonl: "json",
  css: "css",
  less: "css",
  scss: "sass",
  html: "html",
  htm: "html",
  md: "markdown",
  mdx: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  rs: "rust",
  go: "go",
  sql: "database",
  graphql: "graphql",
  gql: "graphql",
  tf: "terraform",
  hcl: "terraform",
  docx: "ms-word",
  pdf: "pdf",
  lock: "lock",
};

function getSpecialFileIcon(name: string): IconName | undefined {
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "docker";
  if (name === ".env" || name.startsWith(".env.")) return "env";
  if ([".gitignore", ".gitattributes", ".gitmodules"].includes(name)) return "git";
  if (name === "package-lock.json") return "npm-lock";
  if (name === "bun.lock") return "bun-lock";
  if (["next.config.js", "next.config.mjs", "next.config.cjs", "next.config.ts"].includes(name)) return "next";
  if ([".eslintrc", ".eslintrc.js", ".eslintrc.json", ".eslintrc.yml", "eslint.config.mjs", "eslint.config.js"].includes(name)) return "eslint";
  if (["yarn.lock", "pnpm-lock.yaml", "cargo.lock"].includes(name)) return "lock";
  if (name.endsWith(".config.ts") || name.endsWith(".config.js") || name.endsWith(".config.mjs") || name.endsWith(".config.cjs")) return "config";
  return undefined;
}

export function iconFor(name: string): IconName {
  const lower = name.toLowerCase();
  const special = getSpecialFileIcon(lower);
  if (special) return special;
  const parts = lower.split(".");
  if (parts.length <= 1) return "_file";
  const ext = parts.pop() ?? "";
  return EXTENSION_ICONS[ext] ?? "_file";
}
