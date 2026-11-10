// Oligarchy in Colony: the host side of the public rules engine (@dadado/oligarchy-engine, pinned
// at an exact version in package.json). The engine holds the rules and takes the catalog as input;
// this module holds what the engine leaves to its host: where the state is kept, the terrain of the
// map, which hex a build goes to, and the labels. No DOM (scripts/oligarchy.test.mjs runs it).
//
// Kit ADRs: 2026-10-23 colony-game-canon-outcome-ledger-art-policy (resources come only from the
// outcome ledger), 2026-11-06 game-content-canon-one-way-flow amend 2026-11-07 (public engine,
// private content in release builds only), 2026-11-06 oligarchy-game-handoff-colony-scheme
// (`colony://play` opens this game).
import { type EnemyPreference, type GameState, type Ledger, type Purse, type Rules, ledgerFromSnapshot, roll, ring, settle, TILES } from "@dadado/oligarchy-engine";

export const ENEMY_PREFERENCES: readonly EnemyPreference[] = ["on", "rare", "off"];

export const KIND_LABEL: Record<string, string> = {
  todo: "To-do done",
  test: "Tests passed",
  ci: "CI passed",
  releaseCut: "Release cut",
  plan: "Plan closed",
  review: "Clean review",
  releasePublished: "Release published",
};

/** The per-folder storage key of the player's state. A new key: the 0.4 port's saves have no hexes. */
export function stateKey(root: string): string {
  return `oligarchy-state-v1:${root}`;
}

/** The per-folder storage key of the enemy preference. */
export function enemyKey(root: string): string {
  return `oligarchy-enemy-v1:${root}`;
}

export function parseEnemy(raw: unknown): EnemyPreference {
  return ENEMY_PREFERENCES.includes(raw as EnemyPreference) ? (raw as EnemyPreference) : "on";
}

/** What `colony://play` shows: the game tab of the open folder, or the game with no folder. */
export function playTarget(hasFolder: boolean): "tab" | "no-folder" {
  return hasFolder ? "tab" : "no-folder";
}

/** The ledger the engine reads from the snapshot's `outcomeLedger`; empty with no folder or no data. */
export function ledgerOf(summary: unknown): Ledger {
  return ledgerFromSnapshot(summary && typeof summary === "object" ? summary : null);
}

/**
 * The terrain of a colony, one letter per tile (the engine's letters: v trees or scrub, g open
 * ground, e edge of the green, s slate, rock or water). The engine leaves its source to the host;
 * Colony derives it from the folder with the engine's own hash, so a folder always has the same
 * map. The hub's tile is open ground and the first ring has only buildable ground, so a new colony
 * can always place its first plain and tundra structures.
 */
export function terrainFor(seed: string): string[] {
  return TILES.map((_, index) => {
    if (index === 0) return "g";
    const x = roll(seed, `terrain:${index}`);
    if (ring(index) === 1) return x < 0.6 ? "g" : "e";
    if (x < 0.35) return "g";
    if (x < 0.6) return "e";
    if (x < 0.8) return "s";
    return "v";
  });
}

/**
 * The hex a build goes on: `preferred` when the structure can stand there, else the first legal
 * hex from the hub outwards; null when none is free.
 */
export function hexFor(rules: Rules, state: GameState, ledger: Ledger, structureId: string, terrain: readonly string[], preferred: number | null = null): number | null {
  const opts = { terrain };
  if (preferred !== null && rules.canPlace(state, ledger, structureId, preferred, opts)) return preferred;
  for (let hex = 1; hex < TILES.length; hex += 1) if (rules.canPlace(state, ledger, structureId, hex, opts)) return hex;
  return null;
}

/**
 * Bring a stored state up to now: parse it, settle the builds that ended and fold the ledger
 * events it has not counted. Call it only while the game is on screen (the engine's host
 * contract: an attack never lands unseen). `changed` says whether to save.
 */
export function advance(rules: Rules, raw: unknown, ledger: Ledger, now: number, enemy: EnemyPreference): { state: GameState; changed: boolean } {
  const parsed = rules.parseState(raw);
  const next = rules.foldLedger(settle(parsed, now, ledger.flow), ledger, { enemy });
  return { state: next, changed: JSON.stringify(next) !== JSON.stringify(raw) };
}

/** What stands on each hex: built, under construction, or offline after an attack. */
export function tileMarks(rules: Rules, state: GameState): Map<number, { glyph: string; mark: "built" | "queued" | "offline"; name: string }> {
  const marks = new Map<number, { glyph: string; mark: "built" | "queued" | "offline"; name: string }>();
  const row = (id: string) => rules.structures.find((s) => s.id === id);
  for (const b of state.queue) {
    if (b.rebuildOf !== undefined) continue;
    const s = row(b.structure);
    for (const hex of rules.footprint(b.structure, b.hex)) marks.set(hex, { glyph: s?.glyph ?? "?", mark: "queued", name: s?.name ?? b.structure });
  }
  for (const b of state.built) {
    const s = row(b.structure);
    const mark = state.offline.includes(b.id) ? "offline" : "built";
    for (const hex of rules.footprint(b.structure, b.hex)) marks.set(hex, { glyph: s?.glyph ?? "?", mark, name: s?.name ?? b.structure });
  }
  return marks;
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hh = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${hh} h ${m} min` : `${hh} h`;
}

export function formatCost(c: Purse): string {
  const parts: string[] = [];
  if (c.logic) parts.push(`${c.logic} Logic`);
  if (c.compute) parts.push(`${c.compute} Compute`);
  if (c.rare) parts.push(`${c.rare} Rare`);
  return parts.join(" · ") || "Free";
}
