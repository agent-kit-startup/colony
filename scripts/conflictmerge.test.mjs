// Conflict window model (src/conflictmerge.ts). Node strips the types. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyChoices, hasMarkers, isMarkerLine, pick, splitLinesKeep, unresolved, UNMERGED_XY } from "../src/conflictmerge.ts";

const FILE = ["top\n", "<<<<<<< HEAD\n", "ours 1\n", "||||||| base\n", "base 1\n", "=======\n", "theirs 1\n", ">>>>>>> side\n", "middle\n", "<<<<<<< HEAD\n", "ours 2\n", "=======\n", "theirs 2\n", ">>>>>>> side\n", "end"].join("");
const H1 = { index: 1, startLine: 2, endLine: 8, ours: "ours 1\n", base: "base 1\n", theirs: "theirs 1\n", oursLabel: "HEAD", baseLabel: "base", theirsLabel: "side" };
const H2 = { index: 2, startLine: 10, endLine: 14, ours: "ours 2\n", base: null, theirs: "theirs 2\n", oursLabel: "HEAD", baseLabel: null, theirsLabel: "side" };

test("each choice replaces its marker block and nothing else", () => {
  const out = applyChoices(FILE, [H1, H2], new Map([[1, { kind: "ours", text: pick(H1, "ours") }], [2, { kind: "both", text: pick(H2, "both") }]]));
  assert.equal(out, "top\nours 1\nmiddle\nours 2\ntheirs 2\nend");
  assert.equal(hasMarkers(out), false);
});

test("a hunk without a choice keeps its markers; unresolved lists it", () => {
  const choices = new Map([[2, { kind: "manual", text: "hand written\n" }]]);
  const out = applyChoices(FILE, [H1, H2], choices);
  assert.ok(out.includes("<<<<<<< HEAD\nours 1\n"));
  assert.ok(out.endsWith("middle\nhand written\nend"));
  assert.equal(hasMarkers(out), true);
  assert.deepEqual(unresolved([H1, H2], choices), [1]);
});

test("an empty choice deletes the block (both sides dropped)", () => {
  assert.equal(applyChoices(FILE, [H1, H2], new Map([[1, { kind: "manual", text: "" }], [2, { kind: "theirs", text: "theirs 2\n" }]])), "top\nmiddle\ntheirs 2\nend");
});

test("a file edited since the listing is refused", () => {
  assert.throws(() => applyChoices("top\nchanged\n" + FILE, [H1, H2], new Map()), /changed, reload/);
});

test("both keeps a line break between sides without a final newline, and CRLF stays CRLF", () => {
  assert.equal(pick({ ...H1, ours: "a", theirs: "b" }, "both"), "a\nb");
  assert.equal(pick({ ...H1, ours: "a\r\nx", theirs: "b\r\n" }, "both"), "a\r\nx\r\nb\r\n");
  assert.equal(pick({ ...H1, ours: "", theirs: "b\n" }, "both"), "b\n");
  const crlf = "x\r\n<<<<<<< HEAD\r\no\r\n=======\r\nt\r\n>>>>>>> s\r\ny\r\n";
  const h = { ...H2, startLine: 2, endLine: 6, ours: "o\r\n", theirs: "t\r\n" };
  assert.equal(applyChoices(crlf, [h], new Map([[2, { kind: "theirs", text: h.theirs }]])), "x\r\nt\r\ny\r\n");
});

test("marker lines follow git's size-7 rule", () => {
  for (const m of ["<<<<<<< HEAD\n", "<<<<<<<\n", "=======\n", "=======  \r\n", "||||||| base\n", ">>>>>>> side"]) assert.ok(isMarkerLine(m), m);
  for (const t of ["<<<<<<<< longer\n", " <<<<<<< x\n", "=======x\n", "<<<<<<<HEAD\n", "==\n"]) assert.ok(!isMarkerLine(t), t);
  assert.deepEqual(splitLinesKeep("a\nb"), ["a\n", "b"]);
  assert.ok(UNMERGED_XY.has("UU") && UNMERGED_XY.has("AA") && !UNMERGED_XY.has("M."));
});
