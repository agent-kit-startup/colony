// Oligarchy inside Colony is the web game in a frame (kit ADR 2026-11-17 points 1, 6, 8 and 10;
// plan oligarchy-web-game-colony-link g5): no engine, no engine view, one sandboxed frame on the
// exact game origin, the data channel of src/oligarchyfeed.ts, the privacy wording. The frame and
// the navigation lock are checked in cargo (src-tauri/src/gameframe.rs) and in COLONY_SMOKE
// (step oligarchy-view). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { FRAME_SANDBOX, GAME_PATH, OLIGARCHY_ORIGINS, gameUrl, playTarget } from "../src/oligarchyfeed.ts";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const PROD = "https://oligarchy.missionkit.io";

test("Colony runs no game engine: the dependency, its catalog seam and the engine view are gone", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.dependencies["@dadado/oligarchy-engine"], undefined);
  assert.doesNotMatch(read("pnpm-lock.yaml"), /oligarchy-engine/);
  for (const gone of ["src/oligarchy.ts", "src/oligarchycatalog.ts", "src/oligarchy-engine.d.ts", "scripts/oligarchy-catalog.mjs"]) assert.equal(existsSync(new URL(gone, root)), false, gone);
  const sources = [...readdirSync(new URL("src/", root)).filter((f) => f.endsWith(".ts")).map((f) => `src/${f}`), "vite.config.ts"];
  for (const f of sources) {
    const src = read(f);
    assert.doesNotMatch(src, /oligarchy-engine|virtual:oligarchy-catalog|oligarchycatalog|ColonyView/, f);
  }
  const wf = read(".github/workflows/release.yml");
  assert.doesNotMatch(wf, /COLONY_GAME_CATALOG|oligarchy-catalog|colony-game|secrets\.COLONY_GAME_DEPLOY_KEY/);
});

test("the game address: an allowed origin plus /game/, nothing else", () => {
  assert.deepEqual([...OLIGARCHY_ORIGINS], [PROD]);
  assert.equal(GAME_PATH, "/game/");
  assert.equal(gameUrl(), `${PROD}/game/`);
  assert.equal(gameUrl(PROD), `${PROD}/game/`);
  for (const bad of ["https://oligarchy-staging.missionkit.io", "https://oligarchy.missionkit.io.evil.com", "http://oligarchy.missionkit.io", "*", "/", ""]) assert.equal(gameUrl(bad), null, bad);
  const staging = "https://oligarchy-staging.missionkit.io";
  assert.equal(gameUrl(staging, [PROD, staging]), `${staging}/game/`, "a caller-built list (the later staging switch) may add staging");
});

test("the frame sandbox: scripts and the page's own origin only", () => {
  assert.deepEqual(FRAME_SANDBOX.split(" ").sort(), ["allow-same-origin", "allow-scripts"]);
  const view = read("src/oligarchyview.ts");
  // One iframe, sandboxed before its src is set, no referrer.
  assert.equal(view.match(/h\("iframe"/g)?.length, 1);
  assert.match(view, /h\("iframe", \{ class: "oligarchy-frame", sandbox: FRAME_SANDBOX, referrerpolicy: "no-referrer", title: "Oligarchy", src: this\.url \}\)/);
  assert.doesNotMatch(view, /allow-top-navigation|allow-popups|allow-forms|allow-modals|allow-downloads|srcdoc/);
  // The only iframe in the frontend is the game's.
  for (const f of readdirSync(new URL("src/", root)).filter((n) => n.endsWith(".ts") && n !== "oligarchyview.ts")) assert.doesNotMatch(read(`src/${f}`), /h\("iframe"|createElement\("iframe"\)/, f);
});

test("the channel: answers only with a folder open, then posts on change to the exact origin", () => {
  const view = read("src/oligarchyview.ts");
  assert.match(view, /gameDataRequestHandler\(\s*\(\) => this\.frame\?\.contentWindow,\s*this\.origin,/);
  assert.match(view, /if \(!this\.host\.workspaceRoot\(\)\) return;\s*if \(answer\(ev\)\) this\.asked = true;/);
  assert.match(view, /if \(this\.asked && root\) postGameData\(this\.frame\.contentWindow, this\.origin, this\.ledger\(\)\);/);
  assert.doesNotMatch(view, /postMessage\(/, "posts only through oligarchyfeed.ts");
  assert.doesNotMatch(view, /localStorage/, "Colony keeps no game state");
});

test("offline: the network-needed state, never an empty frame", () => {
  const view = read("src/oligarchyview.ts");
  assert.match(view, /headline: "The game needs the network"/);
  assert.match(view, /window\.addEventListener\("offline"/);
  assert.match(view, /window\.addEventListener\("online"/);
});

test("colony://play still opens the game: the open folder's tab, or the game with no folder", () => {
  assert.equal(playTarget(true), "tab");
  assert.equal(playTarget(false), "no-folder");
  const main = read("src/main.ts");
  assert.match(main, /import \{ playTarget \} from "\.\/oligarchyfeed";/);
  assert.match(main, /if \(playTarget\(!!workspace\) === "tab"\) showTab\("colony"\);/);
});

test("the rail item and the View menu entry are named Oligarchy; the view id stays colony", () => {
  const main = read("src/main.ts");
  assert.match(main, /\{ id: "colony", label: "Oligarchy", icon: "colony", tip: "Oligarchy: [^"]+", views: \["colony"\] \}/);
  const menu = JSON.parse(read("src/menu.json"));
  const view = menu.menus.find((m) => m.label === "View").items.find((i) => i.id === "view:colony");
  assert.equal(view.label, "Oligarchy");
});

test("PRIVACY.md carries the ADR 2026-11-17 acceptance wording verbatim, the README the frame rule", () => {
  const privacy = read("PRIVACY.md");
  assert.ok(
    privacy.includes(
      "**Oligarchy inside Colony.** Inside Colony, the Oligarchy game is a page loaded from oligarchy.missionkit.io. Colony gives that page the kind and time of each outcome in the open repository's ledger (a to-do closed, a test run passed, a CI run, a release) and counts per kind. It does not give file contents, paths, commit messages, plan or to-do names, or test commands. The page keeps that data on your computer and sends it to no server, missionkit.io included. The game in a browser outside Colony reads nothing from your computer.",
    ),
  );
  assert.match(privacy, /\| Open the Oligarchy rail item .*\| `src\/oligarchyview\.ts` \|/);
  const readme = read("README.md");
  assert.doesNotMatch(readme, /frame-src 'none'|oligarchy-engine|COLONY_GAME_CATALOG/);
  assert.match(readme, /frame-src https:\/\/oligarchy\.missionkit\.io/);
});
