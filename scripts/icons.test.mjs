// src/icons.ts: the chrome icons are 1px lines on the pixel grid (plan
// colony-sidebar-native-kit s4). The test reads the source, so it needs no DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (f) => readFileSync(join(SRC, f), "utf8");
const icons = read("icons.ts");

/** The PATHS table, evaluated from its source text (a static object of string literals). */
function paths() {
  const m = icons.match(/const PATHS = (\{[\s\S]*?\n\}) as const;/);
  assert.ok(m, "PATHS table found");
  return new Function(`return ${m[1]};`)();
}

const half = (n) => Math.abs((Number(n) % 1 + 1) % 1 - 0.5) < 1e-9;
const whole = (n) => Math.abs(Number(n) - Math.round(Number(n))) < 1e-9;

/** Walk a path's straight segments; returns the lines that miss the grid. Curves end the walk. */
function offGrid(d) {
  const bad = [];
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+/g) ?? [];
  let x = 0, y = 0, sx = 0, sy = 0, cmd = "";
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const t = tokens[i];
    if (/[a-zA-Z]/.test(t)) { cmd = t; i++; if (/[zZ]/.test(cmd)) { x = sx; y = sy; } if (/[zZ]/.test(cmd)) continue; }
    switch (cmd) {
      case "M": x = num(); y = num(); sx = x; sy = y; cmd = "L"; break;
      case "m": x += num(); y += num(); sx = x; sy = y; cmd = "l"; break;
      case "L": x = num(); y = num(); break;
      case "l": x += num(); y += num(); break;
      case "H": if (!half(y)) bad.push(`H at y=${y}`); x = num(); break;
      case "h": if (!half(y)) bad.push(`h at y=${y}`); x += num(); break;
      case "V": if (!half(x)) bad.push(`V at x=${x}`); y = num(); break;
      case "v": if (!half(x)) bad.push(`v at x=${x}`); y += num(); break;
      default: return bad; // a curve or arc: the rest of the path is not grid-checked
    }
  }
  return bad;
}

test("the shell draws 1px strokes with butt caps", () => {
  assert.match(icons, /export const ICON_SHELL = '.*stroke-width="1" stroke-linecap="butt" stroke-linejoin="miter"/);
  assert.ok(!icons.includes('stroke-width="1.5"'), "no 1.5px stroke left");
  assert.ok(!icons.includes('stroke-linecap="round"'), "no round caps");
});

test("every rail, tab, section and button icon kind exists", () => {
  const kinds = new Set(Object.keys(paths()));
  const refs = new Set();
  for (const f of ["main.ts", "cockpit.ts", "workspace.ts", "ui.ts", "transcript.ts", "git.ts"]) {
    const src = read(f);
    for (const m of src.matchAll(/icon: "([a-z-]+)"/g)) refs.add(m[1]);
    for (const m of src.matchAll(/\bicon(?:Btn)?\("([a-z-]+)"/g)) refs.add(m[1]);
    for (const m of src.matchAll(/: "([a-z-]+)" \}/g)) if (kinds.has(m[1])) refs.add(m[1]);
  }
  const missing = [...refs].filter((k) => !kinds.has(k));
  assert.deepEqual(missing, [], "kinds referenced but not drawn");
  // The twelve rail items each have their own glyph; none borrows a section icon.
  const rail = read("main.ts").match(/const RAIL: RailItem\[\] = \[([\s\S]*?)\n\];/)[1];
  const railKinds = [...rail.matchAll(/icon: "([a-z-]+)"/g)].map((m) => m[1]);
  assert.equal(railKinds.length, 12);
  assert.equal(new Set(railKinds).size, 12, "every rail item has a distinct icon");
  for (const k of ["current-mission", "queue", "inbox", "chats", "flight-log", "review", "ship", "activity", "terminals", "processes", "workspace", "colony"]) assert.ok(railKinds.includes(k), k);
  for (const k of ["play", "pause", "stop"]) assert.ok(kinds.has(k), `${k} mark`);
});

test("straight lines, rects and circles sit on the pixel grid", () => {
  const bad = [];
  for (const [kind, svg] of Object.entries(paths())) {
    for (const m of svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)) {
      if (!(half(m[1]) && half(m[2]) && whole(m[3]) && whole(m[4]))) bad.push(`${kind}: rect ${m[0]}`);
    }
    for (const m of svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"([^>]*)>/g)) {
      const filled = m[4].includes("fill=");
      const [cx, cy, r] = [m[1], m[2], m[3]].map(Number);
      const on = filled ? whole : half;
      if (!(on(cx - r) && on(cx + r) && on(cy - r) && on(cy + r))) bad.push(`${kind}: circle ${m[0]}`);
    }
    for (const m of svg.matchAll(/<path d="([^"]+)"([^>]*)>/g)) {
      if (m[2].includes("fill=")) continue; // a filled mark: edges, not strokes
      for (const b of offGrid(m[1])) bad.push(`${kind}: ${b} in ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("the chrome sizes the icons at 16px, one unit per pixel", () => {
  const css = read("styles.css");
  for (const sel of [".rail-icon", ".tab-svg", "#win-controls svg", "#btn-top-more svg", ".dock-group svg", ".term-toggle svg"]) {
    const rule = css.split("\n").find((l) => l.startsWith(`${sel} {`));
    assert.ok(rule, sel);
    assert.match(rule, /width: 16px; height: 16px;/, sel);
  }
  assert.match(css, /--mc-chrome-icon-size: 16px/.test(read("tokens.css")) ? /\.space-icon \{[^\n]*var\(--mc-chrome-icon-size\)/ : /never/);
  // Underlines and separators at 1px; the run-gate tab marks its state with the border colour.
  assert.match(css, /\.tabbar \.tab \{[^\n]*border-bottom: 1px solid transparent; \}/);
  assert.match(css, /\.tabbar \.tab\.run-gate \{ border-bottom-color: var\(--yellow\); \}/);
  assert.ok(!/box-shadow: inset 0 -2px/.test(css), "no 2px inset underline");
  assert.match(css, /\.now-step:not\(:last-child\)::before \{[^\n]*width: 1px;/);
  // Active or current items: the 1px border colour only (no left bar, no inset, no tint).
  assert.match(css, /\.tree-row\.active \{ border-color: var\(--blue\); \}/);
  assert.match(css, /\.rail-item\.active \{ color: var\(--text-primary\); border-color: var\(--border-active\); \}/);
  for (const l of css.split("\n")) {
    if (/\.(active|current|held)\b[^{]*\{/.test(l) && !/-mark\b|marker/.test(l)) { // a step or queue marker dot is a badge, not an item
      assert.ok(!/border-left|inset \d/.test(l), `accent bar in: ${l}`);
      assert.ok(!/background: var\(--(blue|yellow|red)-bg\)/.test(l), `tinted fill in: ${l}`);
    }
  }
});
