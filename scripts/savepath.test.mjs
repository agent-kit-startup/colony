// Save as… path rules (src/savepath.ts). Node strips the types (Node 22.18 or later). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { SHORTCUTS, saveAsInitial, saveAsTarget } from "../src/savepath.ts";

const root = "/home/u/ws";
const from = "/home/u/ws/docs/a.md";

test("a relative name resolves inside the workspace", () => {
  assert.deepEqual(saveAsTarget(root, from, "docs/b.md"), { path: "/home/u/ws/docs/b.md" });
  assert.deepEqual(saveAsTarget(root, from, "  b.md "), { path: "/home/u/ws/b.md" });
  assert.deepEqual(saveAsTarget(root, from, "a//b.md"), { path: "/home/u/ws/a/b.md" });
});

test("an absolute name must sit inside the workspace", () => {
  assert.deepEqual(saveAsTarget(root, from, "/home/u/ws/new/c.md"), { path: "/home/u/ws/new/c.md" });
  assert.match(saveAsTarget(root, from, "/home/u/other/c.md").error, /outside the workspace/);
  assert.match(saveAsTarget(root, from, "/home/u/ws2/c.md").error, /outside the workspace/);
  assert.match(saveAsTarget(root, from, "/home/u/ws").error, /file name/);
});

test("dot segments, empty and folder names, and the file itself are refused", () => {
  assert.match(saveAsTarget(root, from, "../x.md").error, /\.\./);
  assert.match(saveAsTarget(root, from, "docs/./x.md").error, /\.\./);
  assert.match(saveAsTarget(root, from, "").error, /file name/);
  assert.match(saveAsTarget(root, from, "docs/").error, /folder/);
  assert.match(saveAsTarget(root, from, "docs/a.md").error, /use Save/);
});

test("the initial name is the workspace-relative path, else the base name", () => {
  assert.equal(saveAsInitial(root, from), "docs/a.md");
  assert.equal(saveAsInitial(root, "/home/u/.config/colony/settings.json"), "settings.json");
});

test("Save has a shortcut for the palette and no accelerator in the menu", async () => {
  assert.equal(SHORTCUTS.save, "Ctrl+S");
  const menu = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../src/menu.json", import.meta.url), "utf8"));
  const file = menu.menus.find((m) => m.label === "File").items;
  assert.deepEqual(file.filter((i) => i.id === "save" || i.id === "save-as").map((i) => i.label), ["Save", "Save as…"]);
  assert.ok(file.every((i) => !/[&_]/.test(i.label ?? "")), "no mnemonics");
  assert.ok(file.every((i) => !("accelerator" in i)), "no accelerators");
});
