// The Settings view (kit ADR 2026-10-24 amend 2026-11-11, point 2): one Settings surface.
// Source-level checks of src/main.ts, src/menu.json and src/styles.css; the window itself is
// checked by the COLONY_SMOKE steps `settings-view` and `settings-no-folder`.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

test("the gear and File → Settings… show the same view; settings.json opens from one row", async () => {
  const main = await read("src/main.ts");
  const spec = JSON.parse(await read("src/menu.json"));
  const file = spec.menus.find((m) => m.label === "File");
  assert.equal(file.items.find((i) => i.id === "settings")?.label, "Settings…", "the File item names the view, not the file");
  assert.ok(main.includes('$("btn-settings").addEventListener("click", () => showSettings());'), "the gear shows the Settings view");
  assert.ok(main.includes("\n  settings: () => showSettings(),"), "File → Settings… shows the Settings view");
  assert.ok(main.includes('\n  "settings-json": () => openSettings(),'), "Open settings.json opens the raw file");
  assert.equal(main.split("openSettings()").length - 1, 2, "openSettings has one caller: the settings-json row");
});

test("the rows sit under Appearance, Engine, Integrations and Files", async () => {
  const main = await read("src/main.ts");
  const spec = JSON.parse(await read("src/menu.json"));
  assert.deepEqual(
    spec.config.map((i) => [i.id, i.group]),
    [["engine", "Engine"], ["omarchy", "Integrations"], ["settings-json", "Files"]],
  );
  assert.ok(spec.config.every((i) => !!i.omarchyOnly === (i.group === "Integrations")), "Integrations shows on Omarchy only");
  assert.ok(!spec.menus.some((m) => m.items.some((i) => spec.config.some((c) => c.id === i.id))), "a Settings row is no menu bar item");
  const from = main.indexOf('<div id="settings-pane"');
  const pane = main.slice(from, main.indexOf('<div id="quick"', from));
  assert.deepEqual([...pane.matchAll(/data-group="([^"]+)"/g)].map((m) => m[1]), ["Appearance"]);
  assert.deepEqual(
    [...pane.matchAll(/<div class="menu-label"[^>]*>([^<]+)</g)].map((m) => m[1]),
    ["Skin", "Title bar (on the next start)", "Rail position", "Rail labels"],
  );
});

test("Settings is a view of its own, not a Workspace section", async () => {
  const main = await read("src/main.ts");
  const sections = /const WORKSPACE_SECTIONS = \[([^\]]*)\]/.exec(main)?.[1].replace(/["\s]/g, "").split(",");
  assert.deepEqual(sections, ["memory", "health", "decisions", "agents", "skills", "rules", "commands", "plans"]);
  const rail = main.slice(main.indexOf("const RAIL: RailItem[] = ["), main.indexOf("\n];", main.indexOf("const RAIL: RailItem[] = [")));
  assert.ok(!/config/i.test(rail), "no rail item or tooltip names Config");
  assert.ok(!(await read("src/workspace.ts")).includes('config: {'), "Workspace has no Config section");
  assert.match(main, /pin\("settings", "Settings", /, "Settings is a pinned view (Back returns from it)");
  for (const f of ["src/main.ts", "src/palette.ts", "src/engine.ts", "src/agent.ts", "src/shiplane.ts", "README.md"]) {
    assert.ok(!/Workspace → Config|Run → Engine|More → /.test(await read(f)), `${f} names the old place of a setting`);
  }
});

// Active, selected and current items change only the 1px border colour: no left accent bar,
// no inset, no tinted background.
test("the current choice and the gear's mark change only the border colour", async () => {
  const css = await read("src/styles.css");
  for (const sel of [".settings-pane button.on", '#btn-settings[aria-current="page"]']) {
    const rules = css.split("\n").filter((l) => l.startsWith(`${sel} {`));
    assert.equal(rules.length, 1, sel);
    assert.ok(/border-color/.test(rules[0]) && !/background|border-left|border-width|inset|box-shadow/.test(rules[0]), rules[0]);
  }
  const hover = css.split("\n").filter((l) => l.startsWith(".settings-pane button:hover"));
  assert.ok(hover.length === 1 && !/background/.test(hover[0]), hover[0]);
});
