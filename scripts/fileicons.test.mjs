// Explorer file-type icons (src/fileicons.ts, src/fileglyphs.ts; shell ADR amend 2026-11-07,
// points 1 and 2). Node strips the types. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CLASS_TOKENS, EXTENSIONS, GLYPH_CLASS, NAMES, PREFIXES, classFor, glyphFor } from "../src/fileicons.ts";
import { GLYPHS, GLYPH_SOURCES } from "../src/fileglyphs.ts";
import { normalize } from "./gen-fileglyphs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(ROOT, f), "utf8");

test("well-known names win over their extension", () => {
  assert.equal(glyphFor("Cargo.toml", false), "rust");
  assert.equal(glyphFor("Cargo.lock", false), "lock");
  assert.equal(glyphFor("package.json", false), "npm");
  assert.equal(glyphFor("pnpm-lock.yaml", false), "lock");
  assert.equal(glyphFor("Dockerfile", false), "docker");
  assert.equal(glyphFor("Dockerfile.dev", false), "docker");
  assert.equal(glyphFor(".gitignore", false), "git");
  assert.equal(glyphFor("Makefile", false), "makefile");
  assert.equal(glyphFor("README.md", false), "markdown");
  assert.equal(glyphFor("README", false), "markdown");
  assert.equal(glyphFor("LICENSE", false), "license");
  assert.equal(glyphFor("LICENSE-MIT", false), "license");
  assert.equal(glyphFor(".env.local", false), "settings");
});

test("extensions map case-insensitively on the last dot", () => {
  assert.equal(glyphFor("main.rs", false), "rust");
  assert.equal(glyphFor("App.TSX", false), "typescript");
  assert.equal(glyphFor("types.d.ts", false), "typescript");
  assert.equal(glyphFor("build.tar.gz", false), "archive");
  assert.equal(glyphFor("shot.PNG", false), "image");
  assert.equal(glyphFor("logo.svg", false), "svg");
  assert.equal(glyphFor("install.sh", false), "shell");
  assert.equal(glyphFor("Colony.AppImage", false), "binary");
  assert.equal(glyphFor("tsconfig.json", false), "json");
});

test("an unmapped name gets the generic file glyph; folders the folder glyph", () => {
  assert.equal(glyphFor("notes.qqq", false), "file");
  assert.equal(glyphFor("noext", false), "file");
  assert.equal(glyphFor(".hidden", false), "file", "a leading dot is not an extension");
  assert.equal(glyphFor("src", true), "folder");
  assert.equal(glyphFor("src", true, true), "folder-open");
  assert.equal(glyphFor("package.json", true), "folder", "a folder never takes a file glyph");
});

test("every mapped glyph is bundled and has a class; every class has a skin token", () => {
  const used = new Set(["file", "folder", "folder-open", ...Object.values(NAMES), ...PREFIXES.map(([, g]) => g), ...Object.values(EXTENSIONS)]);
  for (const g of used) {
    assert.ok(GLYPHS[g], `glyph ${g} bundled`);
    assert.ok(GLYPH_CLASS[g], `glyph ${g} has a class`);
  }
  for (const g of Object.keys(GLYPHS)) assert.ok(used.has(g), `bundled glyph ${g} is used`);
  const allowed = new Set(["--green", "--yellow", "--red", "--blue", "--purple", "--cyan", "--orange", "--text-muted"]);
  for (const [c, t] of Object.entries(CLASS_TOKENS)) assert.ok(allowed.has(t), `${c} -> ${t}`);
  assert.equal(classFor("nope"), "other");
});

test("the CSS colours each class with its token and nothing else", () => {
  const css = read("src/styles.css");
  for (const [c, t] of Object.entries(CLASS_TOKENS)) {
    assert.ok(css.includes(`.tree-row .file-icon[data-class="${c}"] { color: var(${t}); }`), `css rule for ${c}`);
  }
  const rules = css.split("\n").filter((l) => l.includes(".file-icon"));
  for (const r of rules) {
    assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(r), `no literal colour: ${r}`);
    assert.ok(!/border-left|inset|background/.test(r), `no bar or tint: ${r}`);
  }
});

test("glyphs come only from the two permissive sources, at pinned commits", () => {
  assert.deepEqual(Object.keys(GLYPH_SOURCES).sort(), ["mdi", "seti"]);
  assert.equal(GLYPH_SOURCES.mdi.licence, "Apache-2.0");
  assert.equal(GLYPH_SOURCES.mdi.repo, "Templarian/MaterialDesign-SVG");
  assert.equal(GLYPH_SOURCES.seti.licence, "MIT");
  assert.equal(GLYPH_SOURCES.seti.repo, "jesseweed/seti-ui");
  for (const s of Object.values(GLYPH_SOURCES)) assert.match(s.commit, /^[0-9a-f]{40}$/);
  for (const [id, g] of Object.entries(GLYPHS)) {
    assert.ok(GLYPH_SOURCES[g.src], `${id} source`);
    assert.match(g.file, /^(svg|icons)\/[a-z0-9_-]+\.svg$/, `${id} upstream file`);
  }
});

test("glyph data is path data only: no colour, style, id or foreign markup", () => {
  const PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+eE-]+$/;
  for (const [id, g] of Object.entries(GLYPHS)) {
    assert.match(g.vb, /^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/, `${id} viewBox`);
    assert.ok(g.d.length > 0, `${id} has paths`);
    assert.equal(g.vb, g.src === "seti" ? "4 4 24 24" : "0 0 24 24", `${id} on the 24-unit scale`);
    for (const p of g.d) assert.match(typeof p === "string" ? p : p[0], PATH, `${id} path data`);
  }
  const src = read("src/fileglyphs.ts");
  for (const bad of ["fill=", "style=", "id=", "<script", "xlink:", "Gradient", "<svg"]) assert.ok(!src.includes(bad), `no ${bad}`);
});

test("the generator refuses glyphs it cannot flatten to one colour", () => {
  assert.throws(() => normalize('<svg viewBox="0 0 32 32"><path d="M0 0h1"/><path fill="#FFF" d="M1 1h1"/></svg>', "x"), /knockout/);
  assert.throws(() => normalize('<svg viewBox="0 0 32 32"><linearGradient/><path d="M0 0h1"/></svg>', "x"), /unsupported/);
  assert.throws(() => normalize('<svg viewBox="0 0 32 32"><path d="M0 0h1 url(x)"/></svg>', "x"), /bad path/);
  assert.deepEqual(normalize('<svg width="32" height="32"><path fill="#529BBA" d="M0 0h1"/><path opacity=".5" d="M2 2h1"/></svg>', "x"), { vb: "0 0 32 32", d: ["M0 0h1", ["M2 2h1", 0.5]] });
});

test("NOTICE names each bundled source with its licence; Seti-UI's MIT text ships", () => {
  const notice = read("NOTICE");
  assert.match(notice, /Material Design Icons[\s\S]*Apache License,\s+Version 2\.0/);
  assert.match(notice, /Seti-UI[\s\S]*Copyright \(c\) 2014 Jesse Weed, MIT License/);
  for (const s of Object.values(GLYPH_SOURCES)) assert.ok(notice.includes(s.commit), `NOTICE pins ${s.repo}`);
  assert.ok(!/Devicons|Nerd Font|Font Awesome|Codicons/.test(notice), "no source that is not bundled");
  assert.match(read("licenses/seti-ui.MIT.txt"), /Copyright \(c\) 2014 Jesse Weed[\s\S]*Permission is hereby granted/);
});

test("the tree renders the glyph from the table and never parses markup for it", () => {
  const tree = read("src/filetree.ts");
  assert.ok(!tree.includes("innerHTML"), "no innerHTML in filetree.ts");
  assert.match(tree, /createElementNS\(SVG_NS, "path"\)/);
  assert.match(tree, /fileIcon\(entry\.name, entry\.isDir/);
  assert.match(tree, /setGlyph\(glyph, "folder-open"\)/);
  assert.match(tree, /setGlyph\(glyph, "folder"\)/);
});
