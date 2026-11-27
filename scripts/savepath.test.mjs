// Save as… path rules (src/savepath.ts). Node strips the types (Node 22.18 or later). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { SHORTCUTS, paneKey, saveAsInitial, saveAsTarget, shortcutRows } from "../src/savepath.ts";

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

test("Help > Keyboard shortcuts lists every bound key once: the menu actions, Ctrl+1..9, Ctrl+W", async () => {
  const fs = await import("node:fs/promises");
  const menu = JSON.parse(await fs.readFile(new URL("../src/menu.json", import.meta.url), "utf8"));
  // A submenu (View → Splits) lists its items in its place.
  const items = menu.menus.flatMap((m) => m.items.flatMap((i) => (i.items ? i.items.filter((c) => c.id) : i.id ? [i] : [])));
  const rail = ["Cockpit", "Queue", "Inbox", "Chats", "Flight Log", "Review", "Ship", "Activity", "Terminals", "Processes"];
  const rows = shortcutRows(items, rail);
  // Every SHORTCUTS id is a menu item, so no bound key is missing from the panel.
  for (const id of Object.keys(SHORTCUTS)) assert.ok(items.some((i) => i.id === id), `${id} is a menu item`);
  assert.equal(rows.length, Object.keys(SHORTCUTS).length + 9 + 1);
  assert.equal(new Set(rows.map((r) => r.keys)).size, rows.length, "no key twice");
  assert.deepEqual(rows.find((r) => r.keys === "Ctrl+P"), { keys: "Ctrl+P", name: "Go to file" });
  assert.deepEqual(rows.find((r) => r.keys === "Alt+Left"), { keys: "Alt+Left", name: "Back" });
  assert.deepEqual(rows.find((r) => r.keys === "Ctrl+7"), { keys: "Ctrl+7", name: "Go to Ship" });
  assert.ok(!rows.some((r) => r.keys === "Ctrl+10"), "the rail's tenth item has no key");
  assert.deepEqual(rows.at(-1), { keys: "Ctrl+W", name: "Close the active tab" });
  // The keys the handler binds in src/main.ts are the ones the table names.
  const main = await fs.readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  for (const id of ["open-folder", "quick-open", "commands", "open-in-editor", "new-terminal", "new-window"]) assert.ok(main.includes(`runAction("${id}")`), `${id} bound in the keyboard handler`);
});

test("Ctrl+Alt keys drive the split tree, by key position, and leave Monaco its Linux keys", () => {
  assert.equal(paneKey("ArrowLeft", false, false), "pane-focus-left");
  assert.equal(paneKey("ArrowDown", false, true), "pane-focus-down", "focus by direction works from the editor too");
  assert.equal(paneKey("ArrowRight", true, true), "tab-to-pane-right");
  assert.equal(paneKey("ArrowUp", true, false), "tab-to-pane-up");
  assert.equal(paneKey("ArrowUp", true, true), null, "Ctrl+Alt+Shift+Up is Monaco's copy line up on Linux");
  assert.equal(paneKey("ArrowDown", true, true), null);
  assert.equal(paneKey("PageDown", false, false), "pane-focus-next");
  assert.equal(paneKey("PageUp", false, false), "pane-focus-prev");
  assert.equal(paneKey("KeyZ", false, false), "pane-zoom");
  assert.equal(paneKey("Digit0", false, false), "pane-equalize");
  assert.equal(paneKey("Backslash", false, false), "split-right");
  assert.equal(paneKey("Minus", false, false), "split-down");
  assert.equal(paneKey("KeyZ", true, false), null);
  assert.equal(paneKey("KeyS", false, false), null);
  // Every id paneKey returns has its key in SHORTCUTS, so the panel and the palette show it.
  for (const code of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
    for (const shift of [false, true]) assert.ok(SHORTCUTS[paneKey(code, shift, false)].startsWith("Ctrl+Alt+"), code);
  }
  for (const code of ["PageDown", "PageUp", "KeyZ", "Digit0", "Backslash", "Minus"]) assert.ok(SHORTCUTS[paneKey(code, false, false)].startsWith("Ctrl+Alt+"), code);
  // Clear of the keys the amend reserves: Alt+arrows, Ctrl+digits, Ctrl+Shift+C / V.
  for (const k of Object.values(SHORTCUTS)) assert.ok(!/^(Alt\+(Left|Right)|Ctrl\+[1-9]|Ctrl\+Shift\+[CV])$/.test(k) || ["Alt+Left", "Alt+Right"].includes(k), k);
});

test("a Ctrl+Alt press with an empty code falls back to its key (displays that send no code)", () => {
  assert.equal(paneKey("", false, false, "ArrowLeft"), "pane-focus-left");
  assert.equal(paneKey("", true, false, "ArrowRight"), "tab-to-pane-right");
  assert.equal(paneKey("", true, true, "ArrowUp"), null, "the editor keeps Ctrl+Alt+Shift+Up without a code too");
  assert.equal(paneKey("", false, false, "PageDown"), "pane-focus-next");
  assert.equal(paneKey("", false, false, "0"), "pane-equalize");
  assert.equal(paneKey("", false, false, "z"), "pane-zoom");
  assert.equal(paneKey("", false, false, "Z"), "pane-zoom");
  assert.equal(paneKey("", false, false, "\\"), "split-right");
  assert.equal(paneKey("", false, false, "-"), "split-down");
  assert.equal(paneKey("", false, false, "s"), null);
  assert.equal(paneKey("", false, false, ""), null);
  assert.equal(paneKey("", false, false), null, "no code and no key");
  // A code, when there is one, wins over the key (the key position counts, not the layout).
  assert.equal(paneKey("KeyZ", false, false, "y"), "pane-zoom");
  assert.equal(paneKey("KeyY", false, false, "z"), null);
});
