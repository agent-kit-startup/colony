// Markup sinks in Colony's own code (kit plan colony-conflicts-and-smoke-residuals c4,
// explorer-git-workbench review finding S2). Forge, agent, diff and file text is rendered with
// h() and text nodes only (git-cicd ADR point 6). The three innerHTML writes that predate this
// guard take static input only: src/icons.ts's two SVG templates and the app shell in
// src/main.ts. This test pins that list and what feeds each one, so a new sink, or a variable
// reaching one of the three, fails here. Source-level: no DOM. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(fileURLToPath(new URL("..", import.meta.url)), "src");
const read = (f) => readFileSync(join(SRC, f), "utf8");
const files = readdirSync(SRC, { recursive: true }).filter((f) => /\.ts$/.test(f));
const SINK = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|srcdoc|DOMParser|createContextualFragment|parseFromString/;

const ALLOWED = [
  ["icons.ts", 't.innerHTML = `<svg class="${cls}" ${ICON_SHELL} aria-hidden="true">${PATHS[kind]}</svg>`;'],
  ["icons.ts", 't.innerHTML = `<svg class="state-ring" ${ICON_SHELL} aria-hidden="true">${RING}</svg>`;'],
  ["main.ts", 'document.getElementById("app")!.innerHTML = `'],
];

test("the only markup sinks are the three static ones", () => {
  const found = files.flatMap((f) =>
    read(f)
      .split("\n")
      .filter((line) => SINK.test(line))
      .map((line) => [f, line.trim()]),
  );
  assert.deepEqual(found, ALLOWED);
});

/** The argument list of each call `name(...)` in `src` (balanced parentheses, not a definition). */
function calls(src, name) {
  const out = [];
  const re = new RegExp(`(?<![\\w.$])${name}\\(`, "g");
  for (const m of src.matchAll(re)) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 10), m.index))) continue;
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

/** Split an argument list at its top-level commas. */
function args(list) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

test("icon() gets its class from a string literal, its paths from a static table", () => {
  const icons = read("icons.ts");
  assert.match(icons, /export function icon\(kind: IconKind, cls = "space-icon"\): SVGSVGElement \{/);
  let n = 0;
  for (const f of files) {
    for (const call of calls(read(f), "icon")) {
      const a = args(call);
      n++;
      assert.ok(a.length <= 2, `${f}: icon(${call})`);
      if (a[1] !== undefined) assert.match(a[1], /^"[a-z][a-z -]*"$/, `${f}: icon(${call}) passes a literal class`);
    }
  }
  assert.ok(n >= 10, `icon() call sites found: ${n}`);
  // PATHS, ICON_SHELL and RING are string literals with no interpolation or handler.
  const table = icons.match(/const PATHS = \{([\s\S]*?)\n\} as const;/);
  assert.ok(table, "PATHS table found");
  const values = [...table[1].matchAll(/^\s*(?:"[^"]+"|[a-zA-Z]+):\s*('[^']*'|"[^"]*"),?$/gm)].map((m) => m[1]);
  const keys = table[1].match(/^\s*(?:"[^"]+"|[a-zA-Z]+):/gm) ?? [];
  assert.equal(values.length, keys.length, "every PATHS entry is one quoted literal");
  for (const v of values) {
    assert.ok(!v.includes("${") && !/\bon[a-z]+=|<script|javascript:|href=/i.test(v), `static SVG only: ${v.slice(0, 60)}`);
    assert.match(v.slice(1, -1), /^(<(path|rect|circle|line|polyline|polygon|ellipse)( [a-z-]+="[-0-9A-Za-z. ,]*")+\/>)+$/, `SVG shapes only: ${v.slice(0, 60)}`);
  }
  assert.match(icons, /export const ICON_SHELL = '[^'$`]*';/);
  assert.match(icons, /const RING = '<path d="[-0-9A-Za-z. ,]*"\/>';/);
});

test("the app shell template in main.ts interpolates nothing", () => {
  const main = read("main.ts");
  const from = main.indexOf('document.getElementById("app")!.innerHTML = `');
  assert.ok(from >= 0);
  const body = main.slice(from + 'document.getElementById("app")!.innerHTML = `'.length);
  let end = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\") i++;
    else if (body[i] === "`") {
      end = i;
      break;
    }
  }
  assert.ok(end > 0, "the template ends");
  assert.ok(!body.slice(0, end).includes("${"), "no ${…} in the shell markup");
});
