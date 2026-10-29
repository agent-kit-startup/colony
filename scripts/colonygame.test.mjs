// Colony, the game: the pure rules (src/colonygame.ts), ported from the kit's web panel
// (dashboard/dashboard.html, the Colony section) so a colony grows the same way in both.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBlocker,
  earned,
  emptyState,
  FLOW_WINDOW_MS,
  formatCost,
  formatDuration,
  greenTiles,
  hexTiles,
  MAP_RADIUS,
  MAX_ACTIVE_BUILDS,
  overclockActive,
  parseState,
  placedGlyphs,
  queueBuild,
  settle,
  stateKey,
  STRUCTURES,
  wallet,
} from "../src/colonygame.ts";

test("the map is a hex spiral of 61 tiles at radius 4, centre first", () => {
  const t = hexTiles(MAP_RADIUS);
  assert.equal(t.length, 61);
  assert.deepEqual(t[0], { q: 0, r: 0 });
  assert.equal(new Set(t.map((x) => `${x.q},${x.r}`)).size, 61);
  assert.equal(hexTiles(1).length, 7);
});

test("parseState refuses malformed input and keeps only known structures", () => {
  assert.deepEqual(parseState(null), emptyState());
  assert.deepEqual(parseState({ v: 2 }), emptyState());
  const s = parseState({
    v: 1,
    seq: 3.7,
    queue: [
      { id: 1, structure: "nursery", startedAt: 10, durationMs: 100 },
      { id: 2, structure: "castle", startedAt: 10, durationMs: 100 },
      { id: 3, structure: "tundra", startedAt: 10, durationMs: 0 },
    ],
    built: [{ structure: "uplink", completedAt: 5 }, { structure: "nope", completedAt: 5 }],
    spent: { logic: -2, compute: 4.9, rare: "x" },
  });
  assert.equal(s.seq, 3);
  assert.deepEqual(s.queue.map((b) => b.structure), ["nursery"]);
  assert.deepEqual(s.built.map((b) => b.structure), ["uplink"]);
  assert.deepEqual(s.spent, { logic: 0, compute: 4, rare: 0 });
});

test("earned reads only ledger totals; the wallet never goes below zero", () => {
  assert.deepEqual(earned(null), { logic: 0, compute: 0, rare: 0 });
  const e = earned({ totals: { logic: 5, compute: 12.8, rare: -1 } });
  assert.deepEqual(e, { logic: 5, compute: 12, rare: 0 });
  const s = { ...emptyState(), spent: { logic: 7, compute: 2, rare: 0 } };
  assert.deepEqual(wallet(e, s), { logic: 0, compute: 10, rare: 0 });
});

test("a build spends its cost, respects unique, queue size and funds", () => {
  const now = 1_000_000;
  const e = { logic: 20, compute: 20, rare: 1 };
  let s = queueBuild(emptyState(), "uplink", e, now);
  assert.ok(s);
  assert.deepEqual(s.spent, { logic: 0, compute: 3, rare: 0 });
  assert.equal(s.queue[0].durationMs, 60 * 60 * 1000);
  assert.equal(queueBuild(s, "uplink", e, now), null, "unique while queued");
  assert.equal(buildBlocker(STRUCTURES[0], s, wallet(e, s)), "Already on the map");
  s = queueBuild(s, "nursery", e, now);
  s = queueBuild(s, "nursery", e, now);
  assert.equal(s.queue.length, MAX_ACTIVE_BUILDS);
  assert.equal(buildBlocker(STRUCTURES[1], s, wallet(e, s)), "Build queue full");
  assert.equal(buildBlocker(STRUCTURES[4], emptyState(), { logic: 10, compute: 6, rare: 0 }), "Not enough resources");
  assert.equal(queueBuild(emptyState(), "castle", e, now), null);
});

test("settle moves finished builds and the overclock shortens them by a quarter", () => {
  const s = { ...emptyState(), queue: [{ id: 1, structure: "nursery", startedAt: 0, durationMs: 1000 }] };
  assert.equal(settle(s, 999, false).changed, false);
  const done = settle(s, 1000, false);
  assert.equal(done.changed, true);
  assert.deepEqual(done.state.built, [{ structure: "nursery", completedAt: 1000 }]);
  assert.equal(settle(s, 750, true).changed, true);
});

test("overclock needs a streak of 3 and a close within 2 h", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  const at = (ms) => new Date(now - ms).toISOString();
  assert.equal(overclockActive({ streak: 3, lastClosedAt: at(60_000) }, now), true);
  assert.equal(overclockActive({ streak: 2, lastClosedAt: at(60_000) }, now), false);
  assert.equal(overclockActive({ streak: 5, lastClosedAt: at(FLOW_WINDOW_MS + 1) }, now), false);
  assert.equal(overclockActive({ streak: 5, lastClosedAt: at(-60_000) }, now), false, "a close in the future");
  assert.equal(overclockActive(null, now), false);
});

test("green tiles: ledger capped at 60% of the map, buildings add the rest", () => {
  assert.equal(greenTiles({ logic: 0, compute: 0, rare: 0 }, emptyState(), 61), 0);
  assert.equal(greenTiles({ logic: 4, compute: 0, rare: 1 }, emptyState(), 61), 5);
  assert.equal(greenTiles({ logic: 10_000, compute: 0, rare: 0 }, emptyState(), 61), 36);
  const built = { ...emptyState(), built: [{ structure: "purifier", completedAt: 1 }] };
  assert.equal(greenTiles({ logic: 10_000, compute: 0, rare: 0 }, built, 61), 44);
  assert.equal(greenTiles({ logic: 10_000, compute: 0, rare: 99 }, { ...emptyState(), built: Array(10).fill({ structure: "purifier", completedAt: 1 }) }, 61), 61);
});

test("glyphs: the Uplink sits at the centre, the rest in build order", () => {
  const s = { ...emptyState(), built: [{ structure: "nursery", completedAt: 1 }, { structure: "uplink", completedAt: 2 }, { structure: "tundra", completedAt: 3 }] };
  const g = placedGlyphs(s, 61);
  assert.equal(g[0], "U");
  assert.equal(g[1], "N");
  assert.equal(g[2], "T");
});

test("labels and the per-folder key", () => {
  assert.equal(formatDuration(30_000), "1 min");
  assert.equal(formatDuration(45 * 60_000), "45 min");
  assert.equal(formatDuration(180 * 60_000), "3 h");
  assert.equal(formatDuration(61 * 60_000), "1 h 1 min");
  assert.equal(formatCost({ logic: 10, compute: 6, rare: 1 }), "10 Logic · 6 Compute · 1 Rare");
  assert.equal(formatCost({ logic: 0, compute: 0, rare: 0 }), "Free");
  assert.notEqual(stateKey("/a"), stateKey("/b"));
});
