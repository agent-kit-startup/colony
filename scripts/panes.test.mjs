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
