// Explorer keyboard map, selection model and filter (src/treenav.ts; shell ADR amend
// 2026-11-07, point 4). Node strips the types. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { contextTargets, dropDir, filterRows, firstMatch, movePlan, navKey, outermost, selectTo } from "../src/treenav.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(ROOT, f), "utf8");

// /w/src (expanded) > a.ts, lib (collapsed); /w/docs (collapsed); /w/README.md
const rows = [
  { path: "/w/src", isDir: true, expanded: true, depth: 0 },
  { path: "/w/src/a.ts", isDir: false, expanded: false, depth: 1 },
  { path: "/w/src/lib", isDir: true, expanded: false, depth: 1 },
  { path: "/w/docs", isDir: true, expanded: false, depth: 0 },
  { path: "/w/README.md", isDir: false, expanded: false, depth: 0 },
];
const key = (k, mods = {}) => ({ key: k, ...mods });

test("Up and Down move the focus, clamped; Shift extends; no focus starts at the top", () => {
  assert.deepEqual(navKey(rows, 1, key("ArrowDown"), ""), { kind: "focus", index: 2, extend: false });
  assert.deepEqual(navKey(rows, 4, key("ArrowDown"), ""), { kind: "focus", index: 4, extend: false });
  assert.deepEqual(navKey(rows, 0, key("ArrowUp"), ""), { kind: "focus", index: 0, extend: false });
  assert.deepEqual(navKey(rows, 3, key("ArrowUp", { shiftKey: true }), ""), { kind: "focus", index: 2, extend: true });
  assert.deepEqual(navKey(rows, -1, key("ArrowDown"), ""), { kind: "focus", index: 0, extend: false });
  assert.equal(navKey([], -1, key("ArrowDown"), ""), null);
});

test("Home and End jump", () => {
  assert.deepEqual(navKey(rows, 2, key("Home"), ""), { kind: "focus", index: 0, extend: false });
  assert.deepEqual(navKey(rows, 2, key("End", { shiftKey: true }), ""), { kind: "focus", index: 4, extend: true });
});

test("Right expands a closed folder, then goes to its first child; nothing on a file", () => {
  assert.deepEqual(navKey(rows, 2, key("ArrowRight"), ""), { kind: "expand", index: 2 });
  assert.deepEqual(navKey(rows, 0, key("ArrowRight"), ""), { kind: "focus", index: 1, extend: false });
  assert.equal(navKey(rows, 1, key("ArrowRight"), ""), null);
  const empty = [{ path: "/w/e", isDir: true, expanded: true, depth: 0 }, { path: "/w/f", isDir: false, expanded: false, depth: 0 }];
  assert.equal(navKey(empty, 0, key("ArrowRight"), ""), null, "an open empty folder has no child to go to");
});

test("Left collapses an open folder, else goes to the parent", () => {
  assert.deepEqual(navKey(rows, 0, key("ArrowLeft"), ""), { kind: "collapse", index: 0 });
  assert.deepEqual(navKey(rows, 2, key("ArrowLeft"), ""), { kind: "focus", index: 0, extend: false });
  assert.deepEqual(navKey(rows, 1, key("ArrowLeft"), ""), { kind: "focus", index: 0, extend: false });
  assert.equal(navKey(rows, 4, key("ArrowLeft"), ""), null, "a top-level row has no parent row");
});

test("Enter opens, F2 renames, Delete trashes; nothing without a focused row", () => {
  assert.deepEqual(navKey(rows, 4, key("Enter"), ""), { kind: "open", index: 4 });
  assert.deepEqual(navKey(rows, 1, key("F2"), ""), { kind: "rename", index: 1 });
  assert.deepEqual(navKey(rows, 1, key("Delete"), ""), { kind: "delete" });
  assert.equal(navKey(rows, -1, key("Enter"), ""), null);
  assert.equal(navKey(rows, -1, key("Delete"), ""), null);
});

test("typing filters; Backspace trims; Esc clears only a filter; a space only inside a query", () => {
  assert.deepEqual(navKey(rows, 0, key("r"), ""), { kind: "filter", query: "r" });
  assert.deepEqual(navKey(rows, 0, key("e"), "r"), { kind: "filter", query: "re" });
  assert.deepEqual(navKey(rows, 0, key("Backspace"), "re"), { kind: "filter", query: "r" });
  assert.deepEqual(navKey(rows, 0, key("Escape"), "re"), { kind: "filter", query: "" });
  assert.equal(navKey(rows, 0, key("Escape"), ""), null, "Esc with no filter is left to the window");
  assert.equal(navKey(rows, 0, key("Backspace"), ""), null);
  assert.equal(navKey(rows, 0, key(" "), ""), null);
  assert.deepEqual(navKey(rows, 0, key(" "), "a"), { kind: "filter", query: "a " });
});

test("keys with Alt or Meta are never taken; with Ctrl only the selection keys", () => {
  for (const mods of [{ altKey: true }, { metaKey: true }]) {
    assert.equal(navKey(rows, 1, key("ArrowDown", mods), ""), null);
    assert.equal(navKey(rows, 1, key("p", mods), ""), null);
  }
  for (const k of ["p", "Enter", "Delete", "F2", "Home", "ArrowLeft", "a"]) assert.equal(navKey(rows, 1, key(k, { ctrlKey: true }), ""), null, `Ctrl+${k} stays the window's`);
  assert.equal(navKey(rows, 1, key("Tab"), ""), null, "Tab leaves the tree");
});

test("Ctrl+Up and Down move the focus and keep the selection; Ctrl+Space toggles the focused row", () => {
  assert.deepEqual(navKey(rows, 1, key("ArrowDown", { ctrlKey: true }), ""), { kind: "focus", index: 2, extend: false, keep: true });
  assert.deepEqual(navKey(rows, 0, key("ArrowUp", { ctrlKey: true }), ""), { kind: "focus", index: 0, extend: false, keep: true });
  assert.deepEqual(navKey(rows, 3, key(" ", { ctrlKey: true }), ""), { kind: "toggle", index: 3 });
  assert.equal(navKey(rows, -1, key(" ", { ctrlKey: true }), ""), null);
  assert.equal(navKey(rows, 1, key("ArrowDown", { ctrlKey: true, shiftKey: true }), ""), null);
});

test("the filter keeps matches and the folders above them", () => {
  assert.deepEqual(filterRows(rows, ""), [true, true, true, true, true]);
  assert.deepEqual(filterRows(rows, "A.T"), [true, true, false, false, false]);
  assert.deepEqual(filterRows(rows, "readme"), [false, false, false, false, true]);
  assert.deepEqual(filterRows(rows, "zzz"), [false, false, false, false, false]);
  assert.equal(firstMatch(rows, "lib"), 2);
  assert.equal(firstMatch(rows, ""), -1);
});

test("selection: plain click, Ctrl toggles, Shift ranges from the anchor, Ctrl+Shift adds", () => {
  const order = rows.map((r) => r.path);
  const none = { selected: new Set(), anchor: null };
  let s = selectTo(order, none, "/w/src/a.ts", {});
  assert.deepEqual([...s.selected], ["/w/src/a.ts"]);
  s = selectTo(order, s, "/w/docs", { shift: true });
  assert.deepEqual([...s.selected], ["/w/src/a.ts", "/w/src/lib", "/w/docs"]);
  assert.equal(s.anchor, "/w/src/a.ts");
  s = selectTo(order, s, "/w/src", { shift: true });
  assert.deepEqual([...s.selected], ["/w/src", "/w/src/a.ts"], "a new Shift range replaces the old one");
  s = selectTo(order, s, "/w/README.md", { ctrl: true });
  assert.deepEqual([...s.selected].sort(), ["/w/README.md", "/w/src", "/w/src/a.ts"]);
  s = selectTo(order, s, "/w/src", { ctrl: true });
  assert.deepEqual([...s.selected].sort(), ["/w/README.md", "/w/src/a.ts"]);
  const added = selectTo(order, { selected: new Set(["/w/src"]), anchor: "/w/docs" }, "/w/README.md", { shift: true, ctrl: true });
  assert.deepEqual([...added.selected].sort(), ["/w/README.md", "/w/docs", "/w/src"]);
  const lost = selectTo(order, { selected: new Set(), anchor: "/w/gone" }, "/w/docs", { shift: true });
  assert.deepEqual([...lost.selected], ["/w/docs"], "an anchor no longer visible starts at the row");
});

test("the context menu acts on the selection when the row is in it, else on the row", () => {
  const order = rows.map((r) => r.path);
  const sel = new Set(["/w/README.md", "/w/src/a.ts"]);
  assert.deepEqual(contextTargets(order, sel, "/w/README.md"), ["/w/src/a.ts", "/w/README.md"]);
  assert.deepEqual(contextTargets(order, sel, "/w/docs"), ["/w/docs"]);
});

test("a folder covers what is inside it", () => {
  assert.deepEqual(outermost(["/w/src", "/w/src/a.ts", "/w/srcx", "/w/README.md"]), ["/w/src", "/w/srcx", "/w/README.md"]);
});

test("the tree wires the map on its own element; the View ids exist with their actions", () => {
  const tree = read("src/filetree.ts");
  assert.match(tree, /el\.addEventListener\("keydown"/);
  assert.match(tree, /closest\("\.tree-input"\)/, "the inline name field keeps its keys");
  const menu = JSON.parse(read("src/menu.json"));
  const view = menu.menus.find((m) => m.label === "View").items.map((i) => i.id);
  const main = read("src/main.ts");
  for (const id of ["explorer-reveal", "explorer-collapse", "explorer-refresh"]) {
    assert.ok(view.includes(id), `${id} in View`);
    assert.ok(main.includes(`"${id}": () =>`), `${id} in ACTIONS`);
  }
  assert.ok(view.indexOf("explorer") < view.indexOf("explorer-reveal"), "after Show or hide the Explorer");
});

test("focus and selection change only the 1px border colour", () => {
  const css = read("src/styles.css");
  const rules = css.split("\n").filter((l) => /tree-row\.(focused|selected)|tree-filter|#tree:focus/.test(l));
  assert.ok(rules.length >= 3);
  for (const r of rules) assert.ok(!/border-left|inset|background|box-shadow|outline: [^n]/.test(r), r);
});

test("drag to move: one rename per outermost row into the folder", () => {
  assert.deepEqual(movePlan(["/w/a.md", "/w/src/b.ts"], "/w/docs"), [
    { from: "/w/a.md", to: "/w/docs/a.md" },
    { from: "/w/src/b.ts", to: "/w/docs/b.ts" },
  ]);
  assert.deepEqual(movePlan(["/w/src", "/w/src/b.ts"], "/w/docs"), [{ from: "/w/src", to: "/w/docs/src" }], "a folder carries its contents");
  assert.deepEqual(movePlan(["/w/docs/a.md", "/w/b.md"], "/w/docs"), [{ from: "/w/b.md", to: "/w/docs/b.md" }], "rows already there stay out");
  assert.deepEqual(movePlan(["/w/docs/a.md"], "/w/docs"), [], "nothing to do");
  assert.deepEqual(movePlan(["/w/src"], "/w/src"), [], "onto itself");
  assert.deepEqual(movePlan(["/w/src"], "/w/src/lib"), [], "into its own child");
  assert.deepEqual(movePlan(["/w/src/a.ts"], "/w"), [{ from: "/w/src/a.ts", to: "/w/a.ts" }], "up to the root");
});

test("a drop lands in a folder row, a file row's folder, or the root from the empty tree", () => {
  assert.equal(dropDir({ path: "/w/src", isDir: true }, true, "/w"), "/w/src");
  assert.equal(dropDir({ path: "/w/src/a.ts", isDir: false }, true, "/w"), "/w/src");
  assert.equal(dropDir({ path: "/w/a.ts", isDir: false }, true, "/w"), "/w");
  assert.equal(dropDir(null, true, "/w"), "/w");
  assert.equal(dropDir(null, false, "/w"), null, "outside the tree: no drop");
});

test("drag uses pointer events on the tree and moves through rename_path, no new command", () => {
  const tree = read("src/filetree.ts");
  assert.match(tree, /el\.addEventListener\("pointerdown"/);
  assert.ok(!/draggable|dragstart/.test(tree), "no HTML5 drag: the window keeps its OS file drop");
  const main = read("src/main.ts");
  assert.match(main, /async function moveItems[\s\S]*?api\.renamePath\(m\.from, m\.to\)/);
  assert.ok(!read("src/api.ts").includes("move_path"), "no move_path command");
  assert.ok(main.includes("getCurrentWebview().onDragDropEvent"), "the OS file drop is still wired");
});
