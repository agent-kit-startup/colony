// Commit graph lane layout (src/graphlayout.ts). Node strips the types. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { LANE_COLOURS, layoutGraph, shortHash } from "../src/graphlayout.ts";

const c = (hash, ...parents) => ({ hash, parents });

test("a straight history stays in one lane with one colour", () => {
  const { rows, lanes } = layoutGraph([c("c", "b"), c("b", "a"), c("a")]);
  assert.equal(lanes, 1);
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0]);
  assert.equal(new Set(rows.map((r) => r.colour)).size, 1);
  assert.deepEqual(rows[0].segs, [{ part: "bottom", from: 0, to: 0, colour: rows[0].colour }], "the tip has no line above it");
  assert.deepEqual(rows[2].segs, [{ part: "top", from: 0, to: 0, colour: rows[0].colour }], "the root has no line below it");
});

test("a merge opens a lane for its second parent and the fork point closes it", () => {
  // m merges s (side) into w (main work); both fork from a.
  const { rows, lanes } = layoutGraph([c("m", "w", "s"), c("w", "a"), c("s", "a"), c("a")]);
  assert.equal(lanes, 2);
  const [m, w, s, a] = rows;
  assert.equal(m.merge, true);
  assert.equal(m.lane, 0);
  assert.ok(m.segs.some((x) => x.part === "bottom" && x.from === 0 && x.to === 1), "merge edge to lane 1");
  assert.notEqual(m.segs.find((x) => x.to === 1).colour, m.colour, "the merged branch has its own colour");
  assert.equal(w.lane, 0);
  assert.ok(w.segs.some((x) => x.part === "pass" && x.from === 1), "lane 1 crosses w");
  assert.equal(s.lane, 1);
  assert.equal(a.lane, 0);
  const tops = a.segs.filter((x) => x.part === "top").map((x) => x.from).sort();
  assert.deepEqual(tops, [0, 1], "both lanes end at the fork point");
});

test("two branch tips fork off one commit and each keeps a lane", () => {
  const { rows, lanes } = layoutGraph([c("x", "base"), c("y", "base"), c("base")]);
  assert.equal(lanes, 2);
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 0]);
  assert.equal(rows[1].segs.filter((x) => x.part === "pass").length, 1, "x's lane passes y");
});

test("a freed lane is reused instead of widening the graph", () => {
  // s joins main at a, which frees lane 1; the later tip t takes lane 1 again.
  const { rows, lanes } = layoutGraph([c("m", "a", "s"), c("s", "a"), c("a", "b"), c("t", "b"), c("b")]);
  assert.equal(lanes, 2);
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 0, 1, 0]);
});

test("a page boundary never changes the rows already drawn", () => {
  const all = [c("m", "w", "s"), c("w", "v"), c("s", "r"), c("v", "a"), c("r", "a"), c("a", "z"), c("z")];
  const full = layoutGraph(all).rows;
  for (let n = 1; n < all.length; n++) assert.deepEqual(layoutGraph(all.slice(0, n)).rows, full.slice(0, n), `first ${n}`);
  const cut = layoutGraph(all.slice(0, 2)).rows;
  assert.ok(cut[1].segs.some((x) => x.part === "bottom"), "a parent not loaded yet leaves its lane open at the bottom");
});

test("an octopus merge opens one lane per extra parent and colours wrap", () => {
  const { rows, lanes } = layoutGraph([c("o", "p1", "p2", "p3"), c("p1"), c("p2"), c("p3")]);
  assert.equal(lanes, 3);
  assert.deepEqual(rows[0].segs.filter((x) => x.part === "bottom").map((x) => x.to), [0, 1, 2]);
  assert.ok(rows.every((r) => r.colour >= 0 && r.colour < LANE_COLOURS));
  const many = layoutGraph(Array.from({ length: 20 }, (_, i) => c(`t${i}`)));
  assert.ok(many.rows.every((r) => r.colour < LANE_COLOURS));
});

test("empty input and short hashes", () => {
  assert.deepEqual(layoutGraph([]), { rows: [], lanes: 0 });
  assert.equal(shortHash("0123456789abcdef"), "0123456");
});
