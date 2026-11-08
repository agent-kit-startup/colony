// Moving a terminal tab between the editor area (#tabs) and the drawer panel (#term-tabs)
// (src/tabmove.ts; kit ADR 2026-10-24 amend 2026-11-07). Node strips the types (Node 22.18 or
// later; src/tabmove.ts keeps to erasable syntax). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PLACE, DRAG_THRESHOLD, dragStarted, dropPlace, isPtyTab, moveLabel, moveTarget, openPlace, otherPlace, placementPatch, readPlacement, recordMove, tabKind } from "../src/tabmove.ts";

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

// Remembered placement per kind (amend 2026-11-07 tab placement memory).
test("defaults are today's placement", () => {
  assert.deepEqual(DEFAULT_PLACE, { shell: "panel", interactive: "editor", queue: "editor" });
  for (const k of ["shell", "interactive", "queue"]) assert.equal(openPlace(k, {}), DEFAULT_PLACE[k], k);
});

test("a new tab opens where its kind was last moved, other kinds unaffected", () => {
  const m = { shell: "editor", queue: "panel" };
  assert.equal(openPlace("shell", m), "editor");
  assert.equal(openPlace("queue", m), "panel");
  assert.equal(openPlace("interactive", m), "editor", "interactive keeps its default");
});

test("reading settings.json drops unknown kinds and bad values", () => {
  assert.deepEqual(readPlacement({ shell: "editor", interactive: "panel", queue: "editor" }), { shell: "editor", interactive: "panel", queue: "editor" });
  assert.deepEqual(readPlacement({ shell: "drawer", interactive: 1, queue: null, browser: "editor" }), {});
  assert.deepEqual(readPlacement({ shell: "Editor", queue: "panel" }), { queue: "panel" });
  for (const v of [undefined, null, "editor", 3, ["shell"], true]) assert.deepEqual(readPlacement(v), {}, String(v));
});

test("a move records the kind's new place; moving back to the default clears it", () => {
  assert.deepEqual(placementPatch("shell", "editor"), { terminalPlacement: { shell: "editor" } });
  assert.deepEqual(placementPatch("shell", "panel"), { terminalPlacement: { shell: null } });
  assert.deepEqual(placementPatch("interactive", "panel"), { terminalPlacement: { interactive: "panel" } });
  assert.deepEqual(placementPatch("queue", "editor"), { terminalPlacement: { queue: null } });
  let m = recordMove({}, "interactive", "panel");
  assert.deepEqual(m, { interactive: "panel" });
  m = recordMove(m, "shell", "editor");
  assert.deepEqual(m, { interactive: "panel", shell: "editor" });
  const before = m;
  m = recordMove(m, "interactive", "editor");
  assert.deepEqual(m, { shell: "editor" });
  assert.deepEqual(before, { interactive: "panel", shell: "editor" }, "the previous memory is not mutated");
});

test("only drawer shells and agent centre PTYs have a kind", () => {
  assert.equal(tabKind("drawer:3"), "shell");
  assert.equal(tabKind("drawer:3", "queue"), "shell", "a drawer id is a shell whatever it runs");
  assert.equal(tabKind("term:1", "interactive"), "interactive");
  assert.equal(tabKind("term:7", "queue"), "queue");
  assert.equal(tabKind("term:1"), null, "a centre PTY without an agent kind remembers nothing");
  assert.equal(tabKind("term:1", "review"), null);
  for (const id of ["run:3", "mission", "/home/u/a.md", "term:", "drawer:x", ""]) assert.equal(tabKind(id, "interactive"), null, id);
});
