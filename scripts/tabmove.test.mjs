// Moving a terminal tab between the editor area (#tabs) and the drawer panel (#term-tabs)
// (src/tabmove.ts; kit ADR 2026-10-24 amend 2026-11-07). Node strips the types (Node 22.18 or
// later; src/tabmove.ts keeps to erasable syntax). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { DRAG_THRESHOLD, dragStarted, dropPlace, isPtyTab, moveLabel, moveTarget, otherPlace } from "../src/tabmove.ts";

/** A fake element whose ancestors (itself first) match the selectors in `chain`. */
const at = (...chain) => ({ closest: (sel) => (sel.split(",").map((s) => s.trim()).some((s) => chain.includes(s)) ? { sel } : null) });

test("only terminal tabs move: centre PTYs and drawer shells", () => {
  for (const id of ["term:1", "term:42", "drawer:1", "drawer:17"]) assert.equal(isPtyTab(id), true, id);
  for (const id of ["run:3", "/home/u/proj/README.md", "mission", "terminals", "term:", "drawer:x", "term:1:2", ""]) assert.equal(isPtyTab(id), false, id);
});

test("a press becomes a drag only past the threshold", () => {
  assert.equal(dragStarted(0, 0), false);
  assert.equal(dragStarted(DRAG_THRESHOLD - 1, 0), false, "a click that wobbles is still a click");
  assert.equal(dragStarted(3, 3), false);
  assert.equal(dragStarted(DRAG_THRESHOLD, 0), true);
  assert.equal(dragStarted(0, -DRAG_THRESHOLD - 2), true, "any direction");
});

test("the bar under the pointer names the place", () => {
  assert.equal(dropPlace(at("button", "#term-tabs")), "panel");
  assert.equal(dropPlace(at("span", "#tabs-rest", "#tabs")), "editor");
  assert.equal(dropPlace(at("canvas", ".xterm", "#terms")), null, "the terminal body is not a drop target");
  assert.equal(dropPlace(at("div", "#views")), null);
  assert.equal(dropPlace(null), null);
});

test("a drop moves only onto the other bar", () => {
  assert.equal(moveTarget("editor", "panel"), "panel");
  assert.equal(moveTarget("panel", "editor"), "editor");
  assert.equal(moveTarget("editor", "editor"), null, "dropped back where it came from");
  assert.equal(moveTarget("panel", "panel"), null);
  assert.equal(moveTarget("panel", null), null, "dropped outside both bars");
});

test("menu labels and the other place", () => {
  assert.equal(moveLabel("editor"), "Move to panel");
  assert.equal(moveLabel("panel"), "Move to editor area");
  assert.equal(otherPlace("editor"), "panel");
  assert.equal(otherPlace("panel"), "editor");
});
