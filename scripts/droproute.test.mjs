// Routing of a file dropped on the window from the desktop (src/droproute.ts). Node strips
// the types (Node 22.18 or later; src/droproute.ts keeps to erasable syntax). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { dropPoint, dropZone, parentDir, shellQuote, terminalText } from "../src/droproute.ts";

/** A fake element: `chain` lists it and its ancestors as { sel, path?, dir? } (a selector
 *  it matches: ".xterm", ".tree-row", "#side", "#center"). */
function hit(...chain) {
  const at = (i) => {
    if (i >= chain.length) return null;
    const c = chain[i];
    return {
      dataset: c.path ? { path: c.path } : {},
      classList: { contains: (t) => (t === "dir" ? !!c.dir : false) },
      closest: (sel) => {
        for (let j = i; j < chain.length; j++) if (chain[j].sel === sel) return at(j);
        return null;
      },
    };
  };
  return at(0);
}

const root = "/home/u/proj";

test("a terminal takes the drop, wherever it sits", () => {
  assert.deepEqual(dropZone(hit({ sel: "canvas" }, { sel: ".xterm" }, { sel: "#center" }), root), { kind: "terminal" });
  assert.deepEqual(dropZone(hit({ sel: "div" }, { sel: ".xterm" }), null), { kind: "terminal" }, "no folder open: still the terminal");
});

test("an Explorer folder row, a file row, or below the rows", () => {
  assert.deepEqual(dropZone(hit({ sel: "span" }, { sel: ".tree-row", path: `${root}/src`, dir: true }, { sel: "#side" }), root), { kind: "explorer", dir: `${root}/src` });
  assert.deepEqual(dropZone(hit({ sel: ".tree-row", path: `${root}/src/a.ts` }, { sel: "#side" }), root), { kind: "explorer", dir: `${root}/src` });
  assert.deepEqual(dropZone(hit({ sel: "#tree" }, { sel: "#side" }), root), { kind: "explorer", dir: root });
});

test("the centre opens the files; elsewhere, or with no folder, nothing", () => {
  assert.deepEqual(dropZone(hit({ sel: "div" }, { sel: "#center" }), root), { kind: "editor" });
  assert.deepEqual(dropZone(hit({ sel: "#rail" }), root), { kind: "none" });
  assert.deepEqual(dropZone(hit({ sel: "div" }, { sel: "#center" }), null), { kind: "none" });
  assert.deepEqual(dropZone(null, root), { kind: "none" });
});

test("paths are quoted as single shell words", () => {
  assert.equal(shellQuote("/home/u/a-b_c.txt"), "/home/u/a-b_c.txt");
  assert.equal(shellQuote("/home/u/my file.txt"), "'/home/u/my file.txt'");
  assert.equal(shellQuote("/tmp/it's"), "'/tmp/it'\\''s'");
  assert.equal(shellQuote("/tmp/$(rm -rf ~)"), "'/tmp/$(rm -rf ~)'");
  assert.equal(terminalText(["/a b", "/c"]), "'/a b' /c ");
  assert.equal(terminalText([]), "");
});

test("the drop point: CSS pixels as is on Linux, device pixels scaled elsewhere", () => {
  assert.deepEqual(dropPoint({ x: 300, y: 120 }, true, 2), { x: 300, y: 120 });
  assert.deepEqual(dropPoint({ x: 300, y: 120 }, false, 2), { x: 150, y: 60 });
  assert.deepEqual(dropPoint({ x: 300, y: 120 }, false, 0), { x: 300, y: 120 });
});

test("parent folder", () => {
  assert.equal(parentDir("/a/b/c.txt"), "/a/b");
  assert.equal(parentDir("/c.txt"), "/");
});
