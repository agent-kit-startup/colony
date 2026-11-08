// Rail labels read as whole words: the verdict over measured line boxes (src/railfit.ts).
// The COLONY_SMOKE step rail-labels-whole measures the real DOM. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { railFitVerdict } from "../src/railfit.ts";

const content = { left: 7.5, right: 68.5 };
const word = (w, ...lines) => ({ word: w, lines });

test("a single-line word inside the content box passes", () => {
  const fit = railFitVerdict(0, [{ label: "Workspace", content, words: [word("Workspace", { left: 9.6, right: 68.4 })] }]);
  assert.equal(fit.ok, true);
  assert.deepEqual(fit.labels, [{ label: "Workspace", broken: [], overflow: 0 }]);
});

test("a two-word label may wrap between its words", () => {
  const fit = railFitVerdict(0, [
    { label: "Flight Log", content, words: [word("Flight", { left: 23, right: 52 }), word("Log", { left: 28, right: 48 })] },
  ]);
  assert.equal(fit.ok, true);
});

test("a word laid out on two lines is broken inside the word", () => {
  const fit = railFitVerdict(0, [
    { label: "Processes", content, words: [word("Processes", { left: 8, right: 60 }, { left: 34, right: 40 })] },
  ]);
  assert.equal(fit.ok, false);
  assert.deepEqual(fit.labels[0].broken, ["Processes"]);
});

test("a line past the item's content box overflows", () => {
  const fit = railFitVerdict(0, [{ label: "Workspace", content, words: [word("Workspace", { left: 7.5, right: 74.3 })] }]);
  assert.equal(fit.ok, false);
  assert.equal(fit.labels[0].overflow, 5.8);
});

test("sub-pixel slack: 0.5px past the box still fits", () => {
  const fit = railFitVerdict(0, [{ label: "Workspace", content, words: [word("Workspace", { left: 7, right: 69 })] }]);
  assert.equal(fit.ok, true);
});

test("a rail that scrolls sideways fails even when every label fits", () => {
  const fit = railFitVerdict(3, [{ label: "Ship", content, words: [word("Ship", { left: 26, right: 49 })] }]);
  assert.equal(fit.ok, false);
  assert.equal(fit.railOverflowX, 3);
});

test("styles.css: rail labels never break inside a word, the rail fits Workspace", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles.css"), "utf8");
  const lbl = css.match(/^\.rail-item \.lbl \{([^}]*)\}/m);
  assert.ok(lbl, ".rail-item .lbl rule");
  assert.doesNotMatch(lbl[1], /overflow-wrap|word-break/);
  const railW = Number(css.match(/--rail-w: (\d+)px;/)[1]);
  // Workspace at 11px Adwaita Sans is 58.75px; the content box is --rail-w - 15px.
  assert.ok(railW - 15 >= 60.75, `--rail-w ${railW}px leaves under 2px over Workspace`);
});
