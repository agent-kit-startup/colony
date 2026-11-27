// The rail's game item (kit ADR 2026-10-24 amend 2026-11-19, point 4; src/railgame.ts): a
// settings.json field and a View menu toggle show or hide Oligarchy on the rail, shown by
// default. Pure helpers plus source checks of src/main.ts and src/menu.json; the window itself
// is checked by the COLONY_SMOKE step rail-game. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { RAIL_GAME, railGameShown, railKeyTarget, railOnScreen } from "../src/railgame.ts";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");
const railIds = (main) => {
  const from = main.indexOf("const RAIL: RailItem[] = [");
  return [...main.slice(from, main.indexOf("\n];", from)).matchAll(/^\s*\{ id: "([^"]+)"/gm)].map((m) => m[1]);
};

test("shown unless ui.layout.railGame is false (Ask r0-oligarchy-default: Shown)", () => {
  assert.equal(RAIL_GAME, "colony");
  for (const l of [undefined, null, {}, { railGame: true }, { railLabels: false }]) assert.equal(railGameShown(l), true, JSON.stringify(l));
  assert.equal(railGameShown({ railGame: false }), false);
});

test("hidden takes only the game item off the rail, in rail order", async () => {
  const ids = railIds(await read("src/main.ts")).map((id) => ({ id }));
  assert.equal(ids.length, 14);
  assert.deepEqual(railOnScreen(ids, true), ids);
  const off = railOnScreen(ids, false).map((r) => r.id);
  assert.deepEqual(off, ids.map((r) => r.id).filter((id) => id !== "colony"));
  assert.equal(off.length, 13);
});

test("the arrow keys skip a hidden game item: Processes then Workspace", async () => {
  const off = railOnScreen(railIds(await read("src/main.ts")).map((id) => ({ id })), false).map((r) => r.id);
  const at = off.indexOf("processes");
  assert.equal(off[railKeyTarget("ArrowDown", at, off.length)], "workspace");
  assert.equal(off[railKeyTarget("ArrowRight", at, off.length)], "workspace");
  assert.equal(off[railKeyTarget("ArrowUp", at + 1, off.length)], "processes");
  assert.equal(off[railKeyTarget("End", 0, off.length)], "workspace");
  assert.equal(railKeyTarget("Home", 7, off.length), 0);
  assert.equal(railKeyTarget("ArrowUp", 0, off.length), 0, "clamped at the first item");
  assert.equal(railKeyTarget("ArrowDown", off.length - 1, off.length), off.length - 1, "clamped at the last item");
  assert.equal(railKeyTarget("Enter", 3, off.length), undefined);
});

test("Ctrl+1..9 stay Cockpit to Plans: the game item is item 13 and RAIL never changes", async () => {
  const main = await read("src/main.ts");
  const ids = railIds(main);
  assert.ok(ids.indexOf("colony") >= 9, `colony at ${ids.indexOf("colony")}`);
  assert.ok(main.includes("const CTRL_DIGITS = RAIL.slice(0, 9).map((r) => r.id);"), "CTRL_DIGITS reads RAIL, not the items on screen");
  assert.deepEqual(ids.slice(0, 9), ["mission", "queue", "inbox", "chats", "flight", "review", "ship", "activity", "plans"]);
});

test("one toggle id, in View after the rail rows and before Splits; one Appearance row", async () => {
  const main = await read("src/main.ts");
  const spec = JSON.parse(await read("src/menu.json"));
  const view = spec.menus.find((m) => m.label === "View").items;
  const at = view.findIndex((i) => i.id === "rail-game");
  assert.ok(at > view.findIndex((i) => i.id === "view:workspace"), "after the rail rows");
  assert.ok(at < view.findIndex((i) => i.label === "Splits"), "before the Splits submenu");
  const everywhere = JSON.stringify(spec).split('"rail-game"').length - 1;
  assert.equal(everywhere, 1, "the id has one home");
  assert.ok(!spec.config.some((i) => i.id === "rail-game"), "not a Settings action row");
  assert.ok(main.includes('\n  "rail-game": () => setRail({ game: !railGame() }),'), "the ACTIONS key toggles the item");
  assert.ok(main.includes('data-setting="rail-game" data-game="on"') && main.includes('data-setting="rail-game" data-game="off"'), "Settings → Appearance has Shown and Hidden");
  assert.ok(/railGame: railGame\(\),/.test(main), "the panel-change save writes the field");
  // view:colony, colony://play and the palette do not go through the rail item's button.
  assert.ok(main.includes('if (playTarget(!!workspace) === "tab") showTab("colony");'), "colony://play opens the tab directly");
});
