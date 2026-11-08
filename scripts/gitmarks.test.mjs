// Explorer git marks (src/gitmarks.ts). Node strips the types. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMarkIndex, MARK_TOKENS, stronger } from "../src/gitmarks.ts";

const r = "/w";

test("files take their own letter; unknown paths have none", () => {
  const idx = buildMarkIndex([
    { path: `${r}/src/a.ts`, mark: "M" },
    { path: `${r}/new.ts`, mark: "A" },
    { path: `${r}/notes.txt`, mark: "U" },
    { path: `${r}/docs/b.md`, mark: "R" },
    { path: `${r}/c.rs`, mark: "!" },
  ]);
  assert.deepEqual(idx.get(`${r}/src/a.ts`, false), { letter: "M", ignored: false, title: "modified" });
  assert.equal(idx.get(`${r}/new.ts`, false).letter, "A");
  assert.equal(idx.get(`${r}/notes.txt`, false).letter, "U");
  assert.equal(idx.get(`${r}/docs/b.md`, false).letter, "R");
  assert.equal(idx.get(`${r}/c.rs`, false).letter, "!");
  assert.deepEqual(idx.get(`${r}/clean.ts`, false), { letter: null, ignored: false, title: "" });
});

test("a folder takes the strongest status among its descendants, deleted files included", () => {
  const idx = buildMarkIndex([
    { path: `${r}/src/deep/x.ts`, mark: "U" },
    { path: `${r}/src/y.ts`, mark: "M" },
    { path: `${r}/src/deep/gone.ts`, mark: "D" },
    { path: `${r}/lib/z.ts`, mark: "A" },
    { path: `${r}/lib/w.ts`, mark: "!" },
  ]);
  assert.deepEqual(idx.get(`${r}/src`, true), { letter: "M", ignored: false, title: "contains modified files" });
  assert.equal(idx.get(`${r}/src/deep`, true).letter, "D");
  assert.equal(idx.get(`${r}/lib`, true).letter, "!");
  assert.equal(idx.get(r, true).letter, "!", "the root folder too");
  assert.equal(idx.get(`${r}/other`, true).letter, null);
});

test("a collapsed untracked folder marks itself and everything inside it", () => {
  const idx = buildMarkIndex([{ path: `${r}/scratch/`, mark: "U" }]);
  assert.equal(idx.get(`${r}/scratch`, true).letter, "U");
  assert.equal(idx.get(`${r}/scratch/a/b.txt`, false).letter, "U");
  assert.equal(idx.get(r, true).letter, "U");
  assert.equal(idx.get(`${r}/scratchpad.txt`, false).letter, null, "a sibling with the same prefix is not inside");
});

test("ignored paths are dimmed, carry no letter and never colour their parents", () => {
  const idx = buildMarkIndex([
    { path: `${r}/node_modules/`, mark: "I" },
    { path: `${r}/app/.env`, mark: "I" },
  ]);
  assert.deepEqual(idx.get(`${r}/node_modules`, true), { letter: null, ignored: true, title: "ignored" });
  assert.equal(idx.get(`${r}/node_modules/x/index.js`, false).ignored, true);
  assert.equal(idx.get(`${r}/app/.env`, false).ignored, true);
  assert.deepEqual(idx.get(`${r}/app`, true), { letter: null, ignored: false, title: "" });
});

test("strength order and theme tokens", () => {
  assert.equal(stronger("U", "A"), "A");
  assert.equal(stronger("M", "D"), "M");
  assert.equal(stronger("!", "M"), "!");
  assert.equal(stronger(null, "R"), "R");
  const allowed = new Set(["--green", "--yellow", "--red", "--blue", "--purple", "--cyan", "--orange"]);
  for (const t of Object.values(MARK_TOKENS)) assert.ok(allowed.has(t), `${t} is one of the seven semantic tokens`);
});
