// Oligarchy in Colony: the host side of the pinned rules engine (src/oligarchy.ts), the build-time
// catalog seam (scripts/oligarchy-catalog.mjs) and the release step that feeds it. Runs the real
// @dadado/oligarchy-engine package from node_modules.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRules, ledgerFromEntries, partner, ring, TILES } from "@dadado/oligarchy-engine";
import { placeholderCatalog } from "@dadado/oligarchy-engine/placeholder";
import { advance, enemyKey, formatCost, formatDuration, hexFor, ledgerOf, parseEnemy, playTarget, stateKey, terrainFor, tileMarks } from "../src/oligarchy.ts";
import { CATALOG_ENV, catalogModuleSource, catalogPath, catalogProblems, checkCatalogCli } from "./oligarchy-catalog.mjs";

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

/** The `run: |` script of a release.yml step, de-indented. */
function stepScript(wf, name) {
  const start = wf.indexOf(`- name: ${name}\n`);
  assert.ok(start >= 0, `release.yml has the step ${name}`);
  const next = wf.indexOf("\n      - name: ", start + 1);
  const lines = wf.slice(start, next < 0 ? undefined : next).split("\n");
  const at = lines.findIndex((l) => /^\s+run: \|$/.test(l));
  assert.ok(at >= 0, `${name} has a run block`);
  const body = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() && !l.startsWith(" ".repeat(10))) break;
    body.push(l.slice(10));
  }
  return body.join("\n");
}

/** Run a step script the way GitHub runs `run:` (bash -eo pipefail) in a scratch folder. */
function runStep(script, env) {
  const dir = mkdtempSync(join(tmpdir(), "colony-release-"));
  try {
    const out = join(dir, "out");
    writeFileSync(out, "");
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, GITHUB_ENV: out, GITHUB_WORKSPACE: dir, ...(typeof env === "function" ? env(dir) : env) },
    });
    return { status: r.status, stdout: r.stdout, file: readFileSync(out, "utf8"), dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("release: the catalog comes through a read-only deploy key in the game-content Environment, is never persisted, and is checked before the build", () => {
  const wf = read(".github/workflows/release.yml");
  const at = (s) => {
    const i = wf.indexOf(s);
    assert.ok(i >= 0, `release.yml has ${s}`);
    return i;
  };
  assert.match(wf, /\n  linux:\n(?:    [^\n]*\n)*    environment: game-content\n/);
  assert.ok(at("- name: Signing key present") < at("- name: Game content (is the deploy key set)"));
  assert.ok(at("- name: Game content (use)") < at("- name: System libraries"), "a missing key or catalog fails before the slow setup");
  assert.ok(at("- name: Install") < at("- name: Game content (check against the engine)"));
  assert.ok(at("- name: Game content (check against the engine)") < at("- name: Build (direct channel)"));
  assert.match(wf, /repository: agent-kit-startup\/colony-game\n\s+ref: staging\n\s+ssh-key: \$\{\{ secrets\.COLONY_GAME_DEPLOY_KEY \}\}\n/);
  assert.match(wf, /sparse-checkout: content\/catalog\.json/);
  assert.match(wf, /lfs: false\n\s+persist-credentials: false/);
  assert.match(wf, /run: node scripts\/oligarchy-catalog\.mjs\n/);
  assert.equal(wf.match(/if: steps\.content\.outputs\.fetch == 'true'/g).length, 3);
  assert.doesNotMatch(wf, /COLONY_GAME_TOKEN/, "no token: the deploy key replaced it");
  assert.doesNotMatch(wf, /^\s+token:/m);
  assert.doesNotMatch(wf, /echo[^\n]*\$\{?COLONY_GAME_DEPLOY_KEY/, "the key is never printed");
  assert.match(read(".gitignore"), /^\.colony-game\/$/m);
});

test("release: an official release without the deploy key fails, a fork plays the placeholder with a warning", () => {
  const gate = stepScript(read(".github/workflows/release.yml"), "Game content (is the deploy key set)");
  const official = runStep(gate, { GITHUB_REPOSITORY: "agent-kit-startup/colony" });
  assert.equal(official.status, 1);
  assert.match(official.stdout, /::error::secret COLONY_GAME_DEPLOY_KEY \(Environment game-content\) is not set/);
  assert.doesNotMatch(official.file, /fetch=/);
  const officialKey = runStep(gate, { GITHUB_REPOSITORY: "agent-kit-startup/colony", COLONY_GAME_DEPLOY_KEY: "k" });
  assert.equal(officialKey.status, 0);
  assert.equal(officialKey.file, "fetch=true\n");
  assert.doesNotMatch(officialKey.stdout, /k/);
  const fork = runStep(gate, { GITHUB_REPOSITORY: "someone/colony" });
  assert.equal(fork.status, 0);
  assert.equal(fork.file, "fetch=false\n");
  assert.match(fork.stdout, /::warning::secret COLONY_GAME_DEPLOY_KEY is not set: this build of someone\/colony plays the engine's placeholder catalog/);
  const forkKey = runStep(gate, { GITHUB_REPOSITORY: "someone/colony", COLONY_GAME_DEPLOY_KEY: "k" });
  assert.equal(forkKey.file, "fetch=true\n");
});

test("release: a key with a missing or empty catalog fails; a catalog is handed to the build", () => {
  const use = stepScript(read(".github/workflows/release.yml"), "Game content (use)");
  const missing = runStep(use, {});
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /::error::agent-kit-startup\/colony-game has no content\/catalog\.json/);
  const seed = (body) => (dir) => {
    mkdirSync(join(dir, ".colony-game", "content"), { recursive: true });
    writeFileSync(join(dir, ".colony-game", "content", "catalog.json"), body);
    return {};
  };
  assert.equal(runStep(use, seed("")).status, 1);
  const ok = runStep(use, seed("{}"));
  assert.equal(ok.status, 0);
  assert.equal(ok.file, `COLONY_GAME_CATALOG=${ok.dir}/.colony-game/content/catalog.json\n`);
});

test("release: the pre-build check passes a valid catalog and fails a bad or missing one", () => {
  const dir = mkdtempSync(join(tmpdir(), "colony-catalog-"));
  try {
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify(contentCatalog()));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ ...contentCatalog(), twoHex: ["nowhere"] }));
    const lines = [];
    const log = (l) => lines.push(l);
    assert.equal(checkCatalogCli({ COLONY_GAME_CATALOG: good }, log, log), 0);
    assert.match(lines.pop(), /structures, \d+ threats/);
    assert.equal(checkCatalogCli({ COLONY_GAME_CATALOG: bad }, log, log), 1);
    assert.match(lines.pop(), /^::error::.*twoHex: unknown structure nowhere/);
    assert.equal(checkCatalogCli({}, log, log), 1);
    assert.match(lines.pop(), /^::error::COLONY_GAME_CATALOG is not set/);
    const cli = spawnSync(process.execPath, ["scripts/oligarchy-catalog.mjs"], { cwd: new URL(".", root), encoding: "utf8", env: { PATH: process.env.PATH, COLONY_GAME_CATALOG: good } });
    assert.equal(cli.status, 0, cli.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("licence: the public tree says the game's content is not under Apache-2.0", () => {
  const notice = read("NOTICE");
  assert.match(notice, /@dadado\/oligarchy-engine/);
  assert.match(notice, /all rights\s+reserved/i);
  assert.match(read("README.md"), /COLONY_GAME_CATALOG/);
});
