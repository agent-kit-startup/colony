// Regenerate src/fileglyphs.ts, the Explorer's file-type glyphs (shell ADR amend 2026-11-07,
// point 1): a curated subset of Material Design Icons (Pictogrammers, icons under Apache-2.0)
// and Seti-UI (MIT), fetched at pinned commits. Only the path data and the viewBox are kept:
// every fill, style, id and class is dropped, and the tree colours the glyph with
// currentColor from a skin token (point 2). A glyph with a knockout part (a white path) or a
// gradient is refused rather than flattened. Not part of the build; run by hand:
//   node scripts/gen-fileglyphs.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const SOURCES = {
  mdi: {
    name: "Material Design Icons",
    licence: "Apache-2.0",
    repo: "Templarian/MaterialDesign-SVG",
    commit: "9e04201d4557e729822fb57f62a316c3dea1d4a8",
    dir: "svg",
  },
  seti: {
    name: "Seti-UI",
    licence: "MIT",
    repo: "jesseweed/seti-ui",
    commit: "2d6c5e68b4ded73c92dac291845ee44e1182d511",
    dir: "icons",
    // Seti draws on a 32-unit grid with every mark inside 4..28 (measured with getBBox at the
    // pinned commit); framing it to that square puts it on Material Design's 24-unit scale, so
    // both sets show at the same size in a 16px row.
    frame: "4 4 24 24",
  },
};

/** Glyph id -> [source, upstream file name without .svg]. */
const PICK = {
  folder: ["mdi", "folder"],
  "folder-open": ["mdi", "folder-open"],
  file: ["mdi", "file-outline"],
  document: ["mdi", "file-document-outline"],
  text: ["mdi", "text-box-outline"],
  table: ["mdi", "file-table-outline"],
  database: ["mdi", "database-outline"],
  archive: ["mdi", "zip-box-outline"],
  binary: ["mdi", "console"],
  settings: ["mdi", "cog-outline"],
  lock: ["mdi", "lock-outline"],
  key: ["mdi", "key-outline"],
  go: ["mdi", "language-go"],
  rust: ["seti", "rust"],
  typescript: ["seti", "typescript"],
  javascript: ["seti", "javascript"],
  python: ["seti", "python"],
  shell: ["seti", "shell"],
  c: ["seti", "c"],
  cpp: ["seti", "cpp"],
  java: ["seti", "java"],
  ruby: ["seti", "ruby"],
  lua: ["seti", "lua"],
  html: ["seti", "html"],
  css: ["seti", "css"],
  json: ["seti", "json"],
  yaml: ["seti", "yml"],
  xml: ["seti", "xml"],
  markdown: ["seti", "markdown"],
  docker: ["seti", "docker"],
  npm: ["seti", "npm"],
  git: ["seti", "git_ignore"],
  license: ["seti", "license"],
  makefile: ["seti", "makefile"],
  image: ["seti", "image"],
  svg: ["seti", "svg"],
  pdf: ["seti", "pdf"],
};

const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+eE-]+$/;
const WHITE = /fill="#(?:fff|ffffff|fdfefc)"/i;

/** Keep the viewBox and each path's d (and opacity); refuse anything that does not flatten. */
export function normalize(svg, id) {
  if (/<(?:linearGradient|radialGradient|image|script|use|foreignObject|text)\b/i.test(svg)) throw new Error(`${id}: unsupported element`);
  if (WHITE.test(svg)) throw new Error(`${id}: knockout (white) part would be lost`);
  let vb = svg.match(/<svg[^>]*\sviewBox="([^"]+)"/)?.[1];
  if (!vb) {
    const w = svg.match(/<svg[^>]*\swidth="(\d+)"/)?.[1];
    const hh = svg.match(/<svg[^>]*\sheight="(\d+)"/)?.[1];
    if (!w || !hh) throw new Error(`${id}: no viewBox`);
    vb = `0 0 ${w} ${hh}`;
  }
  if (!/^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/.test(vb)) throw new Error(`${id}: odd viewBox ${vb}`);
  const paths = [];
  for (const m of svg.matchAll(/<path\b([^>]*)\/?>/g)) {
    const d = m[1].match(/\sd="([^"]+)"/)?.[1];
    if (!d || !PATH_DATA.test(d)) throw new Error(`${id}: bad path data`);
    const op = m[1].match(/\sopacity="([\d.]+)"/)?.[1];
    paths.push(op ? [d.trim(), Number(op)] : d.trim());
  }
  if (!paths.length) throw new Error(`${id}: no path`);
  return { vb, d: paths };
}

async function main() {
  const out = {};
  for (const [id, [src, file]] of Object.entries(PICK)) {
    const s = SOURCES[src];
    const url = `https://raw.githubusercontent.com/${s.repo}/${s.commit}/${s.dir}/${file}.svg`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${id}: ${res.status} ${url}`);
    const g = normalize(await res.text(), id);
    if (s.frame && g.vb === "0 0 32 32") g.vb = s.frame;
    out[id] = { src, file: `${s.dir}/${file}.svg`, ...g };
  }
  const lines = Object.entries(out).map(([id, g]) => `  ${JSON.stringify(id)}: ${JSON.stringify(g)},`);
  const text = `${HEADER}
export const GLYPH_SOURCES = ${JSON.stringify(
    Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, { name: v.name, licence: v.licence, repo: v.repo, commit: v.commit }])),
    null,
    2,
  )} as const;

/** Glyph id -> source, upstream file (at the source's commit), viewBox and path data
 *  (a string, or [d, opacity]). Path data only: the tree draws it with fill currentColor. */
export const GLYPHS: Record<string, { src: keyof typeof GLYPH_SOURCES; file: string; vb: string; d: (string | [string, number])[] }> = {
${lines.join("\n")}
};
`;
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "fileglyphs.ts"), text);
  console.log(`wrote ${Object.keys(out).length} glyphs`);
}

const HEADER = `// GENERATED by scripts/gen-fileglyphs.mjs: do not edit by hand. The Explorer's file-type
// glyphs, a curated subset of two upstream icon sets at pinned commits (shell ADR amend
// 2026-11-07, point 1). No Nerd Font, no eza table, no CC BY or OFL source. Attribution:
// NOTICE and licenses/.
/*! Colony file-type glyphs include:
 * - Material Design Icons, Pictogrammers (https://github.com/Templarian/MaterialDesign-SVG),
 *   icons licensed under the Apache License, Version 2.0.
 * - Seti-UI (https://github.com/jesseweed/seti-ui), Copyright (c) 2014 Jesse Weed, MIT License:
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this
 *   software and associated documentation files (the "Software"), to deal in the Software
 *   without restriction, including without limitation the rights to use, copy, modify, merge,
 *   publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
 *   to whom the Software is furnished to do so, subject to the following conditions: The above
 *   copyright notice and this permission notice shall be included in all copies or substantial
 *   portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 *   EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 *   FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 *   HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 *   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
 *   USE OR OTHER DEALINGS IN THE SOFTWARE.
 */`;

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
