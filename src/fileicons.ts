// Explorer file-type icons (shell ADR amend 2026-11-07, points 1 and 2). The map from file
// names and extensions to glyphs is written in-house (eza's icon table is EUPL-1.2 and is not
// copied); the glyphs are the bundled subset in src/fileglyphs.ts, drawn by src/filetree.ts.
// No imports, so the Node tests load it as is. Each glyph has one file
// class, and each class one skin token, so the tree follows the live theme and no colour is
// written here. A name with no entry gets the generic file glyph; folders get the folder
// glyph, open while expanded. The file name never goes into markup.
export type FileClass = "dir" | "code" | "config" | "docs" | "image" | "archive" | "exec" | "other";

/** File class -> skin token (the seven semantic colours plus --text-muted). */
export const CLASS_TOKENS: Record<FileClass, string> = {
  dir: "--blue",
  code: "--green",
  config: "--yellow",
  docs: "--cyan",
  image: "--purple",
  archive: "--red",
  exec: "--orange",
  other: "--text-muted",
};

/** Glyph id -> file class. */
export const GLYPH_CLASS: Record<string, FileClass> = {
  folder: "dir",
  "folder-open": "dir",
  file: "other",
  lock: "other",
  rust: "code",
  typescript: "code",
  javascript: "code",
  python: "code",
  go: "code",
  c: "code",
  cpp: "code",
  java: "code",
  ruby: "code",
  lua: "code",
  html: "code",
  css: "code",
  json: "config",
  yaml: "config",
  xml: "config",
  settings: "config",
  docker: "config",
  npm: "config",
  git: "config",
  makefile: "config",
  key: "config",
  markdown: "docs",
  text: "docs",
  document: "docs",
  license: "docs",
  pdf: "docs",
  table: "docs",
  database: "docs",
  image: "image",
  svg: "image",
  archive: "archive",
  shell: "exec",
  binary: "exec",
};

/** Exact names, lower-cased; checked before the prefixes and the extension. */
export const NAMES: Record<string, string> = {
  "cargo.toml": "rust",
  "cargo.lock": "lock",
  "package.json": "npm",
  "package-lock.json": "lock",
  "pnpm-lock.yaml": "lock",
  "pnpm-workspace.yaml": "npm",
  "yarn.lock": "lock",
  "bun.lockb": "lock",
  "flake.lock": "lock",
  ".npmrc": "npm",
  dockerfile: "docker",
  containerfile: "docker",
  ".dockerignore": "docker",
  "docker-compose.yml": "docker",
  "docker-compose.yaml": "docker",
  "compose.yml": "docker",
  "compose.yaml": "docker",
  makefile: "makefile",
  gnumakefile: "makefile",
  justfile: "makefile",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  ".gitkeep": "git",
  ".editorconfig": "settings",
  ".env": "settings",
  ".bashrc": "shell",
  ".bash_profile": "shell",
  ".zshrc": "shell",
  ".profile": "shell",
};

/** Name prefixes, lower-cased (README.md, LICENSE-MIT, Dockerfile.dev, .env.local). */
export const PREFIXES: [string, string][] = [
  ["readme", "markdown"],
  ["license", "license"],
  ["licence", "license"],
  ["copying", "license"],
  ["notice", "license"],
  ["dockerfile.", "docker"],
  [".env.", "settings"],
];

/** Extensions (the part after the last dot), lower-cased. */
export const EXTENSIONS: Record<string, string> = {
  rs: "rust",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  py: "python", pyi: "python",
  go: "go",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
  java: "java",
  rb: "ruby",
  lua: "lua",
  html: "html", htm: "html",
  css: "css", scss: "css", sass: "css", less: "css",
  json: "json", jsonc: "json", json5: "json",
  yml: "yaml", yaml: "yaml",
  xml: "xml",
  toml: "settings", ini: "settings", conf: "settings", cfg: "settings", env: "settings", properties: "settings",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  txt: "text", log: "text",
  rst: "document", adoc: "document", org: "document", tex: "document", doc: "document", docx: "document", odt: "document", rtf: "document",
  pdf: "pdf",
  csv: "table", tsv: "table", xls: "table", xlsx: "table", ods: "table",
  db: "database", sqlite: "database", sqlite3: "database", sql: "database",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", ico: "image", avif: "image", tif: "image", tiff: "image",
  svg: "svg",
  zip: "archive", tar: "archive", gz: "archive", tgz: "archive", bz2: "archive", xz: "archive", zst: "archive", "7z": "archive", rar: "archive", deb: "archive", rpm: "archive",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  appimage: "binary", exe: "binary", bin: "binary", run: "binary",
  lock: "lock",
  pem: "key", key: "key", crt: "key", cer: "key", pub: "key", asc: "key", gpg: "key",
};

/** The glyph id for a tree entry. */
export function glyphFor(name: string, isDir: boolean, expanded = false): string {
  if (isDir) return expanded ? "folder-open" : "folder";
  const n = name.toLowerCase();
  const exact = NAMES[n];
  if (exact) return exact;
  for (const [p, g] of PREFIXES) if (n.startsWith(p)) return g;
  const dot = n.lastIndexOf(".");
  // A leading dot alone (".bashrc") is a hidden name, not an extension.
  if (dot > 0) return EXTENSIONS[n.slice(dot + 1)] ?? "file";
  return "file";
}

export function classFor(glyph: string): FileClass {
  return GLYPH_CLASS[glyph] ?? "other";
}
