// The Settings view (kit ADR 2026-10-24 amend 2026-11-11 point 2, amend 2026-11-19 points 6
// and 7): one Settings surface. Source-level checks of src/main.ts, src/menu.json and
// src/styles.css, and the About panel, App updates, Editor and files and Kit config bodies
// rendered on the small DOM of ./test-dom.mjs; the window itself is checked by the
// COLONY_SMOKE steps `settings-view`, `menu-actions` and `settings-no-folder`.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { elements, setInvoke } from "./test-dom.mjs";

// The About panel listens for Escape on the window.
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
const { openAboutPanel } = await import("../src/about.ts");
const { AppUpdates } = await import("../src/appupdates.ts");
const { EditorFiles, commandValue } = await import("../src/editorfiles.ts");
const { KitConfig, parseRaw, valueAt } = await import("../src/kitconfig.ts");

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

const GROUPS = ["Appearance", "App updates", "Engine", "Editor and files", "Kit config", "Integrations", "Files"];

test("the groups come in ADR order: Appearance, App updates, Engine, Editor and files, Kit config, Integrations, Files", async () => {
  const main = await read("src/main.ts");
  const spec = JSON.parse(await read("src/menu.json"));
  assert.deepEqual(spec.groups, GROUPS);
  assert.deepEqual(
    spec.config.map((i) => [i.id, i.group]),
    [["engine", "Engine"], ["omarchy", "Integrations"], ["settings-json", "Files"]],
  );
  assert.ok(spec.config.every((i) => spec.groups.includes(i.group)), "every row sits in a group of `groups`");
  assert.ok(main.includes('for (const group of menuSpec.groups.filter((g) => g !== "Appearance")) {'), "the view builds its groups in `groups` order after the Appearance markup");
  assert.ok(main.includes('const SETTINGS_BODIES: Record<string, HTMLElement> = { "App updates": appUpdates.el, "Editor and files": editorFiles.el, "Kit config": kitConfig.el };'));
  assert.ok(spec.config.every((i) => !!i.omarchyOnly === (i.group === "Integrations")), "Integrations shows on Omarchy only");
  assert.ok(!spec.menus.some((m) => m.items.some((i) => spec.config.some((c) => c.id === i.id))), "a Settings row is no menu bar item");
  const from = main.indexOf('<div id="settings-pane"');
  const pane = main.slice(from, main.indexOf('<div id="quick"', from));
  assert.deepEqual([...pane.matchAll(/data-group="([^"]+)"/g)].map((m) => m[1]), ["Appearance"]);
  assert.deepEqual(
    [...pane.matchAll(/<div class="menu-label"[^>]*>([^<]+)</g)].map((m) => m[1]),
    ["Skin", "Title bar (on the next start)", "Rail position", "Rail labels", "Oligarchy on the rail"],
  );
});

test("Help → Check for updates opens Settings at App updates and runs the check there", async () => {
  const main = await read("src/main.ts");
  const spec = JSON.parse(await read("src/menu.json"));
  assert.deepEqual(spec.menus.find((m) => m.label === "Help").items.filter((i) => i.id).map((i) => i.id), ["about", "shortcuts", "check-updates"]);
  assert.ok(main.includes('\n  "check-updates": () => checkUpdatesInSettings(),'));
  const fn = main.slice(main.indexOf("function checkUpdatesInSettings() {"), main.indexOf("\n}\n", main.indexOf("function checkUpdatesInSettings() {")));
  assert.ok(fn.includes("showSettings();") && fn.includes('appUpdates.el.closest(".settings-group")') && fn.includes("appUpdates.check()"), fn);
  assert.ok(main.includes("\n  about: () => openAboutPanel(),"));
});

test("the About panel shows the version only; App updates holds the channel, the check and Update and restart", async () => {
  const about = await read("src/about.ts");
  assert.ok(!/appUpdateCheck|appUpdateInstall|Update and restart|Channel|checkForUpdates/.test(about), "About keeps no update action");
  const calls = [];
  const status = { version: "0.6.0", channel: "direct", install: "AppImage", canCheck: true, canInstall: true, note: "Updates come from GitHub Releases." };
  setInvoke(async (cmd) => {
    calls.push(cmd);
    if (cmd === "app_update_status") return status;
    if (cmd === "app_update_check") return { current: "0.6.0", available: "0.7.0" };
    throw new Error(cmd);
  });
  await openAboutPanel();
  const panel = document.body.childNodes.find((n) => n.attributes?.id === "about-panel");
  const labels = elements(panel).filter((e) => e.className === "engine-row").map((r) => r.childNodes[0].childNodes[0].data);
  assert.deepEqual(labels, ["Version", "License"]);
  assert.equal(elements(panel).filter((e) => e.tagName === "BUTTON").length, 1, "only the close button");
  assert.deepEqual(calls, ["app_update_status"]);

  const reports = [];
  const updates = new AppUpdates((m) => reports.push(m));
  await updates.load();
  const rows = elements(updates.el).filter((e) => e.className === "settings-row").map((r) => r.childNodes[0].childNodes[0].data);
  assert.deepEqual(rows, ["Version", "Channel", "Installed as", "Updates"]);
  const buttons = elements(updates.el).filter((e) => e.tagName === "BUTTON");
  assert.deepEqual(buttons.map((b) => b.childNodes[0].data), ["Check for updates", "Update and restart"]);
  assert.ok(buttons.every((b) => !b.dataset.cmd), "no data-cmd: the Settings action rows are menu.json `config` only");
  assert.ok(!calls.includes("app_update_check"), "showing the section asks no network");
  await updates.check();
  assert.ok(calls.includes("app_update_check"));
  assert.match(reports.at(-1), /0\.7\.0 is available .*Update and restart/);
});

test("Editor and files: editor.command, editor.terminal and fileManager rows", async () => {
  assert.equal(commandValue("  "), null);
  assert.equal(commandValue(" zed --wait "), "zed --wait");
  assert.deepEqual(commandValue('["code", "--wait"]'), ["code", "--wait"]);
  assert.throws(() => commandValue("[1]"));
  const sets = [];
  let settings = { editor: { command: ["code", "--wait"] }, workspaces: {} };
  setInvoke(async (cmd, args) => {
    if (cmd === "settings_get") return { path: "/s.json", settings, error: null };
    if (cmd === "settings_set_editor") {
      sets.push(args);
      return { path: "/s.json", settings, error: null };
    }
    throw new Error(cmd);
  });
  const rows = new EditorFiles(() => {});
  await rows.load();
  const inputs = elements(rows.el).filter((e) => e.tagName === "INPUT");
  assert.deepEqual(inputs.map((i) => i.dataset.key), ["editor.command", "fileManager"]);
  assert.equal(inputs[0].value, '["code","--wait"]');
  const choices = elements(rows.el).filter((e) => e.tagName === "BUTTON");
  assert.deepEqual(choices.map((b) => b.dataset.editorTerminal), ["null", "true", "false"]);
  assert.ok(choices[0].classList.contains("on"), "unset: decided per source");
  inputs[1].value = "yazi";
  inputs[1].dispatchEvent({ type: "change" });
  choices[2].click();
  inputs[0].value = "[1";
  inputs[0].dispatchEvent({ type: "change" });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sets, [{ key: "fileManager", value: "yazi" }, { key: "editor.terminal", value: false }], "a malformed array saves nothing");
});

test("Kit config: a form over the kit's confirmed values, a raw JSON editor that never writes invalid JSON", async () => {
  assert.equal(valueAt({ a: { b: [1] } }, "a.b").length, 1);
  assert.equal(valueAt({ a: {} }, "a.b"), undefined);
  assert.equal(parseRaw("{").ok, false);
  assert.equal(parseRaw("[]").ok, false);
  assert.equal(parseRaw('{"a": 1}').ok, true);
  const text = '{\n  "purpose": { "value": "mixed" },\n  "stack": { "language": "node", "testCommands": ["pnpm test"] }\n}\n';
  const fields = [
    { path: "purpose.value", label: "Purpose", kind: "choice", options: ["library", "mixed"] },
    { path: "git.provider", label: "Git provider", kind: "choice", options: ["github"] },
    { path: "stack.language", label: "Stack language", kind: "text", options: [] },
    { path: "stack.testCommands", label: "Test commands", kind: "lines", options: [] },
  ];
  const calls = [];
  setInvoke(async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "kit_config_read" || cmd === "kit_config_set") return { path: "/r/.cursor/agent-kit.config.json", exists: true, canCreate: true, text, fields };
    if (cmd === "kit_config_write_raw") return { path: "/r/.cursor/agent-kit.config.json", exists: true, canCreate: true, text: args.text, fields };
    throw new Error(cmd);
  });
  const kit = new KitConfig(() => {});
  await kit.load(null);
  assert.match(kit.el.childNodes[0].childNodes[0].data, /Open a folder/);
  assert.equal(calls.length, 0, "no folder: nothing is read");
  await kit.load("/r");
  const inputs = elements(kit.el).filter((e) => ["INPUT", "SELECT", "TEXTAREA"].includes(e.tagName));
  assert.deepEqual(inputs.map((i) => i.dataset.path), ["purpose.value", "stack.language", "stack.testCommands"], "a key missing from the file shows no input");
  assert.equal(inputs[2].value, "pnpm test");
  inputs[2].value = "pnpm test\n\n cargo test ";
  inputs[2].dispatchEvent({ type: "change" });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.at(-1), ["kit_config_set", { path: "stack.testCommands", value: ["pnpm test", "cargo test"] }]);
  // Raw JSON: invalid text is refused before any write.
  const button = (label) => elements(kit.el).find((e) => e.tagName === "BUTTON" && e.childNodes[0]?.data === label);
  button("Raw JSON").click();
  const raw = elements(kit.el).find((e) => e.tagName === "TEXTAREA");
  assert.equal(raw.value, text);
  const reads = calls.length;
  await kit.load("/r");
  assert.ok(calls.length === reads && elements(kit.el).includes(raw), "Settings shown again keeps the open raw editor");
  const before = calls.length;
  raw.value = '{ "purpose": ';
  button("Save").click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, before, "invalid JSON: no write call");
  assert.ok(elements(kit.el).some((e) => e.className.includes("bad") && /nothing was written/.test(e.childNodes[0]?.data ?? "")));
  raw.value = '{ "purpose": { "value": "library" } }';
  button("Save").click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.at(-1), ["kit_config_write_raw", { text: '{ "purpose": { "value": "library" } }', base: text }], "verbatim, against the text it started from");
});

test("Settings is a view of its own, not a Workspace section", async () => {
  const main = await read("src/main.ts");
  const sections = /const WORKSPACE_SECTIONS = \[([^\]]*)\]/.exec(main)?.[1].replace(/["\s]/g, "").split(",");
  assert.deepEqual(sections, ["overview", "decisions", "agents", "skills", "rules", "commands"]);
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
