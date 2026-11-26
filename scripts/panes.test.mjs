// The centre split tree (src/panes.ts; kit ADR 2026-10-24 amend 2026-11-19, free tiling).
// Node strips the types (Node 22.18 or later). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PANES, MAX_RATIO, MIN_RATIO, boxes, clampRatio, cycle, equalize, movePane, neighbour, resizeToward, swapPanes, freshPaneId, heir, isLeaf, leaves, nextShown, nodeAt, pathTo, removePane, setRatio, splitContent, splitPane, stripAdd, stripRemove } from "../src/panes.ts";

const one = { pane: "p1" };

test("a split halves the pane: it keeps the first half, the new pane takes the second", () => {
  const r = splitPane(one, "p1", "right", "p2");
  assert.deepEqual(r, { split: "right", ratio: 0.5, a: { pane: "p1" }, b: { pane: "p2" } });
  assert.deepEqual(one, { pane: "p1" }, "the input tree is never changed");
  const d = splitPane(r, "p2", "down", "p3");
  assert.deepEqual(leaves(d), ["p1", "p2", "p3"]);
  assert.deepEqual(nodeAt(d, ["b"]), { split: "down", ratio: 0.5, a: { pane: "p2" }, b: { pane: "p3" } });
  assert.deepEqual(pathTo(d, "p3"), ["b", "b"]);
  assert.equal(pathTo(d, "p9"), null);
});

test("a split refuses an unknown pane, a taken id and a full tree", () => {
  const r = splitPane(one, "p1", "right", "p2");
  assert.equal(splitPane(r, "p9", "down", "p3"), r);
  assert.equal(splitPane(r, "p1", "down", "p2"), r, "p2 is already a pane");
  let full = one;
  for (let i = 2; i <= MAX_PANES; i++) full = splitPane(full, `p${i - 1}`, i % 2 ? "down" : "right", `p${i}`);
  assert.equal(leaves(full).length, MAX_PANES);
  assert.equal(splitPane(full, "p1", "right", "p99"), full);
});

test("removing a pane gives its space to its sibling; the last pane never goes", () => {
  const t = splitPane(splitPane(one, "p1", "right", "p2"), "p2", "down", "p3");
  assert.deepEqual(removePane(t, "p1"), { split: "down", ratio: 0.5, a: { pane: "p2" }, b: { pane: "p3" } });
  assert.deepEqual(removePane(t, "p3"), { split: "right", ratio: 0.5, a: { pane: "p1" }, b: { pane: "p2" } });
  assert.equal(removePane(one, "p1"), null);
  assert.equal(removePane(t, "p9"), t);
});

test("the heir is the nearest pane of the sibling", () => {
  // p1 | (p2 over p3)
  const t = splitPane(splitPane(one, "p1", "right", "p2"), "p2", "down", "p3");
  assert.equal(heir(t, "p1"), "p2", "the first pane of the right side");
  assert.equal(heir(t, "p3"), "p2");
  assert.equal(heir(t, "p2"), "p3");
  // (p1 over p4) | p2: removing p2 hands its space to p4, the pane next to it.
  const u = splitPane(splitPane(one, "p1", "right", "p2"), "p1", "down", "p4");
  assert.equal(heir(u, "p2"), "p4");
  assert.equal(heir(one, "p1"), null);
});

test("ratios stay inside the bounds", () => {
  const t = splitPane(one, "p1", "right", "p2");
  assert.equal(setRatio(t, [], 0.3).ratio, 0.3);
  assert.equal(setRatio(t, [], 0).ratio, MIN_RATIO);
  assert.equal(setRatio(t, [], 2).ratio, MAX_RATIO);
  assert.equal(setRatio(t, ["a"], 0.3), t, "a leaf has no ratio");
  assert.equal(clampRatio(Number.NaN), 0.5);
  assert.equal(isLeaf(t), false);
  assert.equal(isLeaf(one), true);
});

test("a strip adds after the shown tab, never twice, and removes", () => {
  let s = { order: [] };
  s = stripAdd(s, "a");
  s = stripAdd(s, "b");
  s = stripAdd(s, "c", "a");
  assert.deepEqual(s.order, ["a", "c", "b"]);
  assert.equal(stripAdd(s, "b"), s);
  assert.deepEqual(stripAdd(s, "d", "zz").order, ["a", "c", "b", "d"]);
  assert.deepEqual(stripRemove(s, "c").order, ["a", "b"]);
});

test("after a close the pane shows its history, else the neighbour, else nothing", () => {
  const s = { order: ["a", "b", "c"] };
  assert.equal(nextShown(s, "b", "a"), "a", "the history wins");
  assert.equal(nextShown(s, "b", null), "c", "the tab after the closed one");
  assert.equal(nextShown(s, "c", null), "b", "the last tab: the one before");
  assert.equal(nextShown(s, "b", "b"), "c", "the closed tab is no target");
  assert.equal(nextShown({ order: ["a"] }, "a", null), null);
});

test("what a split puts in the new pane", () => {
  assert.equal(splitContent("/r/a.ts", true, 1, true), "copy", "a file: the same file side by side");
  assert.equal(splitContent("term:1", false, 2, true), "move", "a terminal moves when the pane keeps a tab");
  assert.equal(splitContent("term:1", false, 1, true), "empty", "the pane's only tab stays");
  assert.equal(splitContent("mission", false, 3, false), "empty", "a view stays");
  assert.equal(splitContent(null, false, 0, false), "empty");
});

test("fresh pane ids", () => {
  assert.equal(freshPaneId([]), "p1");
  assert.equal(freshPaneId(["p1", "p2", "p4"]), "p3");
});

// ---- keyboard (plan to-do t3) ----------------------------------------------------------
// p1 | (p2 over p3)
const tee = () => splitPane(splitPane(one, "p1", "right", "p2"), "p2", "down", "p3");

test("a split can put the new pane first (left or above)", () => {
  assert.deepEqual(splitPane(one, "p1", "right", "p2", true), { split: "right", ratio: 0.5, a: { pane: "p2" }, b: { pane: "p1" } });
});

test("boxes follow the ratios in the unit square", () => {
  const b = boxes(setRatio(tee(), [], 0.25));
  assert.deepEqual(b.get("p1"), { x: 0, y: 0, w: 0.25, h: 1 });
  assert.deepEqual(b.get("p2"), { x: 0.25, y: 0, w: 0.75, h: 0.5 });
  assert.deepEqual(b.get("p3"), { x: 0.25, y: 0.5, w: 0.75, h: 0.5 });
});

test("the neighbour in a direction shares the longest stretch of the edge, null at the edge", () => {
  const t = tee();
  assert.equal(neighbour(t, "p2", "left"), "p1");
  assert.equal(neighbour(t, "p3", "left"), "p1");
  assert.equal(neighbour(t, "p2", "down"), "p3");
  assert.equal(neighbour(t, "p3", "up"), "p2");
  assert.equal(neighbour(t, "p1", "left"), null);
  assert.equal(neighbour(t, "p2", "up"), null);
  assert.equal(neighbour(t, "p9", "up"), null);
  // p1 faces p2 and p3 equally: the tie goes to reading order.
  assert.equal(neighbour(t, "p1", "right"), "p2");
  // With p2 taller, p1 meets more of p2... and with p3 taller, more of p3.
  assert.equal(neighbour(setRatio(t, ["b"], 0.3), "p1", "right"), "p3");
  assert.equal(neighbour(one, "p1", "right"), null);
});

test("next and previous wrap around in reading order", () => {
  const t = tee();
  assert.equal(cycle(t, "p3", 1), "p1");
  assert.equal(cycle(t, "p1", -1), "p3");
  assert.equal(cycle(t, "p1", 1), "p2");
  assert.equal(cycle(one, "p1", 1), null);
});

test("swap trades two panes' places and keeps the shape", () => {
  const t = setRatio(tee(), [], 0.3);
  const s = swapPanes(t, "p1", "p3");
  assert.deepEqual(s, { split: "right", ratio: 0.3, a: { pane: "p3" }, b: { split: "down", ratio: 0.5, a: { pane: "p2" }, b: { pane: "p1" } } });
  assert.equal(swapPanes(t, "p1", "p9"), t);
  assert.equal(swapPanes(t, "p1", "p1"), t);
});

test("move takes a pane past its neighbour: it leaves its place and halves the neighbour on the far side", () => {
  const t = tee();
  // p3 moves left: p2 takes the whole right half, p1 is split with p3 on its left.
  assert.deepEqual(movePane(t, "p3", "left"), { split: "right", ratio: 0.5, a: { split: "right", ratio: 0.5, a: { pane: "p3" }, b: { pane: "p1" } }, b: { pane: "p2" } });
  // p1 moves right past p2 (its neighbour by reading order): p1 goes right of p2.
  assert.deepEqual(movePane(t, "p1", "right"), { split: "down", ratio: 0.5, a: { split: "right", ratio: 0.5, a: { pane: "p2" }, b: { pane: "p1" } }, b: { pane: "p3" } });
  assert.equal(movePane(t, "p1", "left"), t, "nothing on the left");
  assert.deepEqual(leaves(movePane(t, "p2", "down")), ["p1", "p3", "p2"]);
});

test("resize moves the border on that side of the pane by a step, clamped", () => {
  const t = tee();
  assert.equal(nodeAt(resizeToward(t, "p1", "right", 0.05), []).ratio, 0.55);
  assert.equal(nodeAt(resizeToward(t, "p2", "left", 0.05), []).ratio, 0.45, "p2's left border is the root split");
  assert.equal(nodeAt(resizeToward(t, "p2", "right", 0.05), []).ratio, 0.5, "no border right of p2: unchanged");
  assert.equal(resizeToward(t, "p2", "right", 0.05), t);
  assert.equal(nodeAt(resizeToward(t, "p2", "down", 0.05), ["b"]).ratio, 0.55);
  assert.equal(nodeAt(resizeToward(t, "p3", "up", 0.05), ["b"]).ratio, 0.45);
  assert.equal(resizeToward(t, "p1", "up", 0.05), t, "p1 has no border above");
  let far = t;
  for (let i = 0; i < 30; i++) far = resizeToward(far, "p1", "right", 0.05);
  assert.equal(nodeAt(far, []).ratio, MAX_RATIO);
});

test("equalize gives every pane along an axis the same room", () => {
  // p1 | p2 | p3 built as p1 | (p2 | p3): the root gives p1 a third.
  const row = splitPane(splitPane(one, "p1", "right", "p2"), "p2", "right", "p3");
  const e = equalize(setRatio(setRatio(row, [], 0.8), ["b"], 0.2));
  assert.ok(Math.abs(nodeAt(e, []).ratio - 1 / 3) < 1e-9);
  assert.equal(nodeAt(e, ["b"]).ratio, 0.5);
  // p1 | (p2 over p3): across the row, each side counts one column.
  assert.equal(nodeAt(equalize(setRatio(tee(), [], 0.2)), []).ratio, 0.5);
  assert.deepEqual(equalize(one), one);
});

// ---- drag to dock (plan to-do t4) ----
import { EDGE_SHARE, dockAction, paneDropZone as dropZone, zoneBox } from "../src/panes.ts";

test("a drop near an edge of a pane names that edge; the middle is the centre", () => {
  assert.equal(dropZone(10, 300, 800, 600), "left");
  assert.equal(dropZone(790, 300, 800, 600), "right");
  assert.equal(dropZone(400, 10, 800, 600), "up");
  assert.equal(dropZone(400, 590, 800, 600), "down");
  assert.equal(dropZone(400, 300, 800, 600), "center");
  assert.equal(dropZone(800 * EDGE_SHARE + 1, 300, 800, 600), "center", "just inside the band's limit is the centre");
  assert.equal(dropZone(5, 5, 800, 600), "left", "a corner goes to the nearer edge, left / right on a tie");
  assert.equal(dropZone(400, 5, 800, 600), "up");
  assert.equal(dropZone(-20, 300, 800, 600), "left", "a pointer just outside is clamped to the pane");
  assert.equal(dropZone(10, 10, 0, 600), "center", "a pane with no size has only a centre");
});

test("a zone outlines the half the new pane takes, or the whole pane", () => {
  assert.deepEqual(zoneBox("left"), { x: 0, y: 0, w: 0.5, h: 1 });
  assert.deepEqual(zoneBox("right"), { x: 0.5, y: 0, w: 0.5, h: 1 });
  assert.deepEqual(zoneBox("up"), { x: 0, y: 0, w: 1, h: 0.5 });
  assert.deepEqual(zoneBox("down"), { x: 0, y: 0.5, w: 1, h: 0.5 });
  assert.deepEqual(zoneBox("center"), { x: 0, y: 0, w: 1, h: 1 });
});

test("a drop on a strip or a centre moves the tab; on an edge it splits that pane on that side", () => {
  assert.deepEqual(dockAction("p1", 2, "p2", "strip"), { kind: "move", to: "p2" });
  assert.deepEqual(dockAction("p1", 1, "p2", "center"), { kind: "move", to: "p2" });
  assert.deepEqual(dockAction("p1", 2, "p1", "center"), { kind: "none" }, "back into its own pane: nothing");
  assert.deepEqual(dockAction("p1", 2, "p1", "strip"), { kind: "none" });
  assert.deepEqual(dockAction("p1", 2, "p1", "right"), { kind: "split", at: "p1", dir: "right", before: false });
  assert.deepEqual(dockAction("p1", 2, "p1", "left"), { kind: "split", at: "p1", dir: "right", before: true });
  assert.deepEqual(dockAction("p1", 1, "p2", "up"), { kind: "split", at: "p2", dir: "down", before: true });
  assert.deepEqual(dockAction("p1", 1, "p2", "down"), { kind: "split", at: "p2", dir: "down", before: false });
  assert.deepEqual(dockAction("p1", 1, "p1", "right"), { kind: "none" }, "a pane's only tab cannot split its own pane");
  assert.deepEqual(dockAction(null, 0, "p1", "right"), { kind: "split", at: "p1", dir: "right", before: false }, "a drawer terminal may split any pane");
  assert.deepEqual(dockAction(null, 0, "p1", "center"), { kind: "move", to: "p1" });
});

// ---- the tree across restarts (plan to-do t5) ----
import { absInside, readSaved, relInside, saveTree, savedLeaves, treeOf } from "../src/panes.ts";

test("saved paths stay inside the folder", () => {
  assert.equal(relInside("/r/app", "/r/app/src/a.ts"), "src/a.ts");
  assert.equal(relInside("/r/app/", "/r/app"), "");
  assert.equal(relInside("/r/app", "/r/apple/a.ts"), null, "a sibling folder with the same prefix is outside");
  assert.equal(relInside("/r/app", "/etc/passwd"), null);
  assert.equal(relInside("/r/app", "/r/app/a/../../x"), null);
  assert.equal(absInside("/r/app", "src/a.ts"), "/r/app/src/a.ts");
  assert.equal(absInside("/r/app", ""), "/r/app");
  assert.equal(absInside("/r/app", "."), "/r/app");
  assert.equal(absInside("/r/app", "/etc/passwd"), null);
  assert.equal(absInside("/r/app", "a/../../x"), null);
  assert.equal(absInside("/r/app", "a//b"), null);
});

test("a tree saves with each pane's tabs and reads back to the same tree", () => {
  const tree = { split: "right", ratio: 0.4, a: { pane: "p1" }, b: { split: "down", ratio: 0.5, a: { pane: "p3" }, b: { pane: "p2" } } };
  const tabs = { p1: { tabs: [{ file: "src/a.ts" }, { file: "README.md", mode: "preview" }], active: 1 }, p2: { tabs: [{ terminal: "src" }], active: 0 }, p3: { tabs: [], active: null } };
  const saved = saveTree(tree, (id) => tabs[id]);
  assert.deepEqual(saved.a, { pane: "p1", tabs: tabs.p1.tabs, active: 1 });
  assert.deepEqual(saved.b.a, { pane: "p3", tabs: [] }, "no shown tab: no active");
  const back = readSaved(JSON.parse(JSON.stringify({ tree: saved, focused: "p2", at: 5 })));
  assert.ok(back);
  assert.deepEqual(treeOf(back.tree), tree);
  assert.equal(back.focused, "p2");
  assert.deepEqual(savedLeaves(back.tree).map((l) => l.pane), ["p1", "p3", "p2"]);
  assert.equal(savedLeaves(back.tree)[0].active, 1);
});

test("a hand-edited tree Colony cannot trust reads as nothing (one pane)", () => {
  const leaf = (id, extra = {}) => ({ pane: id, tabs: [], ...extra });
  const ok = { tree: { split: "right", ratio: 0.5, a: leaf("p1"), b: leaf("p2") }, focused: "p1" };
  assert.ok(readSaved(ok));
  const bad = [
    null,
    "x",
    { tree: leaf("p1") },
    { tree: leaf("p1"), focused: "p2" },
    { tree: { split: "diagonal", ratio: 0.5, a: leaf("p1"), b: leaf("p2") }, focused: "p1" },
    { tree: { split: "right", ratio: 1, a: leaf("p1"), b: leaf("p2") }, focused: "p1" },
    { tree: { split: "right", ratio: 0.5, a: leaf("p1"), b: leaf("p1") }, focused: "p1" },
    { tree: { split: "right", ratio: 0.5, a: leaf("p1") }, focused: "p1" },
    { tree: leaf("p1", { tabs: [{ file: "../x" }] }), focused: "p1" },
    { tree: leaf("p1", { tabs: [{ file: "/etc/passwd" }] }), focused: "p1" },
    { tree: leaf("p1", { tabs: [{ file: "a", mode: "raw" }] }), focused: "p1" },
    { tree: leaf("p1", { tabs: [{ terminal: "../up" }] }), focused: "p1" },
    { tree: leaf("p1", { tabs: [{ chat: "abc" }] }), focused: "p1" },
    { tree: leaf("p1", { tabs: [{ file: "a" }], active: 3 }), focused: "p1" },
  ];
  for (const b of bad) assert.equal(readSaved(b), null, JSON.stringify(b));
  let wide = leaf("w0");
  for (let i = 1; i <= MAX_PANES; i++) wide = { split: "right", ratio: 0.5, a: leaf(`w${i}`), b: wide };
  assert.equal(readSaved({ tree: wide, focused: "w0" }), null, "more panes than Colony opens");
});
