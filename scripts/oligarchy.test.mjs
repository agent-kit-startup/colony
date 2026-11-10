// Oligarchy in Colony: the host side of the pinned rules engine (src/oligarchy.ts), the build-time
// catalog seam (scripts/oligarchy-catalog.mjs) and the release step that feeds it. Runs the real
// @dadado/oligarchy-engine package from node_modules.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRules, ledgerFromEntries, partner, ring, TILES } from "@dadado/oligarchy-engine";
import { placeholderCatalog } from "@dadado/oligarchy-engine/placeholder";
import { advance, enemyKey, formatCost, formatDuration, hexFor, ledgerOf, parseEnemy, playTarget, stateKey, terrainFor, tileMarks } from "../src/oligarchy.ts";
import { CATALOG_ENV, catalogModuleSource, catalogPath, catalogProblems } from "./oligarchy-catalog.mjs";

const root = new URL("..", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const rules = createRules(placeholderCatalog);
const zero = ledgerOf(null);
const plainOne = rules.structures.find((s) => s.terrain === "plain" && rules.spanOf(s.id) === 1 && s.cost.rare === 0);
const plainTwo = rules.structures.find((s) => s.terrain === "plain" && rules.spanOf(s.id) === 2 && s.id !== rules.hub);
const tundra = rules.structures.find((s) => s.terrain === "tundra");

/** A catalog with the placeholder's shape and other names, standing in for the game's own. */
function contentCatalog() {
  const c = structuredClone({ structures: placeholderCatalog.structures, threats: placeholderCatalog.threats, twoHex: [...placeholderCatalog.twoHex] });
  for (const s of c.structures) s.name = `Content ${s.name}`;
  return c;
}

test("the engine is pinned at one exact version, and that version is installed", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.dependencies["@dadado/oligarchy-engine"], "0.1.0");
  assert.match(read("pnpm-lock.yaml"), /'@dadado\/oligarchy-engine@0\.1\.0':\n\s+resolution: \{integrity: sha512-/);
  const installed = JSON.parse(read("node_modules/@dadado/oligarchy-engine/package.json"));
  assert.equal(installed.version, "0.1.0");
  assert.equal(installed.license, "Apache-2.0");
});

test("the 0.4 port is gone: no source imports it and the game reads the engine", () => {
  assert.throws(() => read("src/colonygame.ts"));
  const kv = read("src/kitviews.ts");
  assert.doesNotMatch(kv, /colonygame/);
  assert.match(kv, /from "@dadado\/oligarchy-engine"/);
  assert.match(read("src/oligarchycatalog.ts"), /createRules\(catalog\)/);
});

test("state keys are per folder and new: an 0.4 save is left alone, not misread", () => {
  assert.equal(stateKey("/w/a"), "oligarchy-state-v1:/w/a");
  assert.notEqual(stateKey("/w/a"), stateKey("/w/b"));
  assert.notEqual(stateKey("/w/a"), "colony-game-state-v1:/w/a");
  assert.equal(enemyKey("/w/a"), "oligarchy-enemy-v1:/w/a");
  assert.equal(parseEnemy("rare"), "rare");
  assert.equal(parseEnemy("off"), "off");
  assert.equal(parseEnemy("sometimes"), "on");
  assert.equal(parseEnemy(null), "on");
});

test("colony://play opens the folder's game tab, or the game itself with no folder (never a dead end)", () => {
  assert.equal(playTarget(true), "tab");
  assert.equal(playTarget(false), "no-folder");
  const main = read("src/main.ts");
  assert.doesNotMatch(main, /Open a folder first: the game belongs to a folder/);
  assert.match(main, /else showPlayWithoutFolder\(\);/);
});

test("terrain: one engine letter per tile, the same for the same folder, buildable around the hub", () => {
  const t = terrainFor("/w/a");
  assert.equal(t.length, TILES.length);
  assert.equal(t.length, 61);
  assert.deepEqual(terrainFor("/w/a"), t);
  assert.notDeepEqual(terrainFor("/w/b"), t);
  assert.ok(t.every((l) => "vges".includes(l)));
  assert.equal(t[0], "g");
  for (let i = 1; i < TILES.length; i += 1) if (ring(i) === 1) assert.ok(t[i] === "g" || t[i] === "e", `ring 1 tile ${i} is ${t[i]}`);
  // No folder: still a map.
  assert.equal(terrainFor("").length, 61);
});

test("a new colony: the hub stands on hex 0 and its partner, nothing is earned", () => {
  const { state, changed } = advance(rules, null, zero, 1_000, "on");
  assert.equal(changed, true);
  assert.deepEqual(state.built, [{ id: 1, structure: rules.hub, hex: 0 }]);
  assert.equal(zero.total, 0);
  assert.deepEqual(zero.totals, { logic: 0, compute: 0, rare: 0 });
  const marks = tileMarks(rules, state);
  const hubHexes = rules.spanOf(rules.hub) === 2 ? [0, partner(0)] : [0];
  assert.deepEqual([...marks.keys()].sort((a, b) => a - b), hubHexes.sort((a, b) => a - b));
  for (const m of marks.values()) assert.equal(m.mark, "built");
  // Saved and read back: nothing changes.
  assert.equal(advance(rules, JSON.parse(JSON.stringify(state)), zero, 2_000, "on").changed, false);
});

test("hexFor: a selected hex when the structure fits there, else the first legal one, else null", () => {
  const terrain = terrainFor("/w/a");
  const s = rules.newGame();
  for (const row of [plainOne, plainTwo, tundra].filter(Boolean)) {
    const hex = hexFor(rules, s, zero, row.id, terrain);
    assert.notEqual(hex, null, `${row.id} has somewhere to stand on a new colony`);
    assert.ok(rules.canPlace(s, zero, row.id, hex, { terrain }));
  }
  const first = hexFor(rules, s, zero, plainOne.id, terrain);
  const other = [...Array(TILES.length).keys()].find((i) => i !== first && rules.canPlace(s, zero, plainOne.id, i, { terrain }));
  if (other !== undefined) assert.equal(hexFor(rules, s, zero, plainOne.id, terrain, other), other);
  assert.equal(hexFor(rules, s, zero, plainOne.id, terrain, 0), first, "the hub's hex is never chosen");
  assert.equal(hexFor(rules, s, zero, plainOne.id, TILES.map(() => "v")), null);
});

test("a build is paid from the ledger, stands on its hex and settles when its time is up", () => {
  const terrain = terrainFor("/w/a");
  const entries = {};
  for (let i = 0; i < 12; i += 1) entries[`todo:${i}`] = { kind: "todo", at: `2026-11-10T10:${String(i).padStart(2, "0")}:00Z` };
  for (let i = 0; i < 6; i += 1) entries[`ci:${i}`] = { kind: "ci", at: `2026-11-10T11:${String(i).padStart(2, "0")}:00Z` };
  const ledger = ledgerFromEntries(entries);
  let s = advance(rules, null, ledger, 0, "off").state;
  assert.equal(s.turn, 18);
  assert.equal(s.threat, null, "enemy off: no attack");
  const hex = hexFor(rules, s, ledger, plainOne.id, terrain);
  s = rules.queueBuild(s, ledger, plainOne.id, hex, { now: 0, terrain });
  assert.ok(s);
  assert.equal(tileMarks(rules, s).get(hex).mark, "queued");
  const later = advance(rules, JSON.parse(JSON.stringify(s)), ledger, plainOne.build_minutes * 60_000, "off");
  assert.equal(later.changed, true);
  assert.ok(later.state.built.some((b) => b.structure === plainOne.id && b.hex === hex));
  assert.equal(tileMarks(rules, later.state).get(hex).mark, "built");
  assert.equal(rules.buildBlocker(later.state, ledger, rules.hub), "Already on the map");
});

test("the ledger is read from the snapshot's outcomeLedger, and a missing one is empty", () => {
  const l = ledgerOf({ entries: 3, totals: { logic: 2, compute: 1, rare: 0 }, recent: [{ key: "a", kind: "todo", at: "2026-11-10T10:00:00Z" }], flow: { streak: 1 } });
  assert.equal(l.total, 3);
  assert.deepEqual(l.totals, { logic: 2, compute: 1, rare: 0 });
  assert.equal(l.events.length, 1);
  assert.deepEqual(ledgerOf(undefined), zero);
  assert.deepEqual(ledgerOf("nope"), zero);
});

test("formatting", () => {
  assert.equal(formatDuration(30_000), "1 min");
  assert.equal(formatDuration(90 * 60_000), "1 h 30 min");
  assert.equal(formatCost({ logic: 2, compute: 0, rare: 1 }), "2 Logic · 1 Rare");
  assert.equal(formatCost({ logic: 0, compute: 0, rare: 0 }), "Free");
});

test("catalog seam: no COLONY_GAME_CATALOG plays the engine's placeholder", () => {
  assert.equal(CATALOG_ENV, "COLONY_GAME_CATALOG");
  assert.equal(catalogPath({}), null);
  assert.equal(catalogPath({ COLONY_GAME_CATALOG: "  " }), null);
  const src = catalogModuleSource({});
  assert.match(src, /from "@dadado\/oligarchy-engine\/placeholder"/);
  assert.match(src, /export const source = "placeholder"/);
});

test("catalog seam: a valid catalog file is inlined as data and binds to the engine", () => {
  const c = contentCatalog();
  const src = catalogModuleSource({ COLONY_GAME_CATALOG: "/x/catalog.json" }, (p) => {
    assert.equal(p, "/x/catalog.json");
    return JSON.stringify({ ...c, extra: "ignored" });
  });
  assert.match(src, /export const source = "content"/);
  assert.doesNotMatch(src, /import /, "nothing from the file is imported or run");
  const data = JSON.parse(src.slice("export default ".length, src.indexOf(";\n")));
  assert.deepEqual(Object.keys(data), ["structures", "threats", "twoHex"]);
  assert.equal(createRules(data).structures[0].name, c.structures[0].name);
});

test("catalog seam: a missing, malformed or invalid catalog fails the build", () => {
  const env = { COLONY_GAME_CATALOG: "/x/catalog.json" };
  assert.throws(() => catalogModuleSource(env, () => { throw new Error("ENOENT"); }), /cannot read the catalog \(ENOENT\)/);
  assert.throws(() => catalogModuleSource(env, () => "{"), /cannot read the catalog/);
  assert.throws(() => catalogModuleSource(env, () => "[]"), /one JSON object/);
  const noTwo = contentCatalog();
  delete noTwo.twoHex;
  assert.throws(() => catalogModuleSource(env, () => JSON.stringify(noTwo)), /twoHex must be an array/);
  const noHub = contentCatalog();
  for (const s of noHub.structures) if (s.terrain === "centre") s.terrain = "plain";
  assert.throws(() => catalogModuleSource(env, () => JSON.stringify(noHub)), /invalid catalog/);
  assert.deepEqual(catalogProblems(contentCatalog()), []);
});

test("release: the private catalog is fetched only with its token, never persisted, and a token without a catalog fails", () => {
  const wf = read(".github/workflows/release.yml");
  const at = (s) => {
    const i = wf.indexOf(s);
    assert.ok(i >= 0, `release.yml has ${s}`);
    return i;
  };
  assert.ok(at("- name: Install") < at("- name: Game content (is the token set)"));
  assert.ok(at("- name: Game content (use)") < at("- name: Build (direct channel)"));
  assert.match(wf, /repository: agent-kit-startup\/colony-game\n\s+token: \$\{\{ secrets\.COLONY_GAME_TOKEN \}\}/);
  assert.match(wf, /sparse-checkout: content\/catalog\.json/);
  assert.match(wf, /persist-credentials: false/);
  assert.match(wf, /if: steps\.content\.outputs\.fetch == 'true'/);
  assert.match(wf, /echo "COLONY_GAME_CATALOG=\$catalog" >> "\$GITHUB_ENV"/);
  assert.match(wf, /has no content\/catalog\.json"\n\s+exit 1/);
  assert.doesNotMatch(wf, /echo[^\n]*COLONY_GAME_TOKEN\b[^\n]*\$COLONY_GAME_TOKEN/);
  assert.match(read(".gitignore"), /^\.colony-game\/$/m);
});

test("licence: the public tree says the game's content is not under Apache-2.0", () => {
  const notice = read("NOTICE");
  assert.match(notice, /@dadado\/oligarchy-engine/);
  assert.match(notice, /all rights\s+reserved/i);
  assert.match(read("README.md"), /COLONY_GAME_CATALOG/);
});
