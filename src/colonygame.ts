// Colony, the game: the pure rules over the kit's outcome ledger (snapshot `outcomeLedger`,
// Mission Control data 1.9.0; kit ADR 2026-10-23 colony-game-canon-outcome-ledger-art-policy
// points 1, 4, 6, 8). A port of the kit web page's rules (kit dashboard/dashboard.html, the
// Colony section), so a colony grows the same way in both. Earned totals come only from the
// ledger; what the player spends, queues and builds is Colony's own state (the ADR lets a host
// persist it its own way: src/kitviews.ts keeps it per folder). No timer runs: a build ends at
// startedAt + duration, evaluated whenever the view renders. No DOM here (scripts/colonygame.test.mjs).

export type Resource = "logic" | "compute" | "rare";
export type Purse = Record<Resource, number>;

export interface Structure {
  id: string;
  name: string;
  glyph: string;
  cost: Purse;
  minutes: number;
  greens: number;
  unique: boolean;
  /** File name under assets/art/ (Colony's curated set), or null. */
  art: string | null;
  blurb: string;
}

export interface Build {
  id: number;
  structure: string;
  startedAt: number;
  durationMs: number;
}

export interface Built {
  structure: string;
  completedAt: number;
}

export interface GameState {
  v: 1;
  seq: number;
  queue: Build[];
  built: Built[];
  spent: Purse;
}

export interface Flow {
  plan?: string;
  streak?: number;
  lastClosedAt?: string | null;
  brokenAt?: string | null;
}

export const MAP_RADIUS = 4;
export const MAX_ACTIVE_BUILDS = 3;
export const FLOW_STREAK = 3;
export const FLOW_WINDOW_MS = 2 * 60 * 60 * 1000;
export const OVERCLOCK_FACTOR = 0.75;

export const STRUCTURES: readonly Structure[] = Object.freeze([
  { id: "uplink", name: "IDE-Core Uplink", glyph: "U", cost: { logic: 0, compute: 3, rare: 0 }, minutes: 60, greens: 2, unique: true, art: "uplink-tower-road.webp", blurb: "Central command: links the colony to the work you ship. One per map." },
  { id: "nursery", name: "Sapling Nursery", glyph: "N", cost: { logic: 2, compute: 0, rare: 0 }, minutes: 45, greens: 3, unique: false, art: "seed-tree-crane.webp", blurb: "First green ground around the landing site." },
  { id: "tundra", name: "Tundra Reforestation Node", glyph: "T", cost: { logic: 5, compute: 2, rare: 0 }, minutes: 180, greens: 5, unique: false, art: "rover-frozen-flats.webp", blurb: "Turns frozen flats green." },
  { id: "transit", name: "Levitating Transit Hub", glyph: "H", cost: { logic: 4, compute: 4, rare: 0 }, minutes: 360, greens: 4, unique: false, art: null, blurb: "Connects settlements across the map." },
  { id: "purifier", name: "Atmospheric Purifier", glyph: "P", cost: { logic: 10, compute: 6, rare: 1 }, minutes: 720, greens: 8, unique: false, art: "atmospheric-purifier.webp", blurb: "Vents clean mist and raises the atmosphere meter." },
]);

export const KIND_LABEL: Record<string, string> = {
  todo: "To-do done",
  test: "Tests passed",
  ci: "CI passed",
  releaseCut: "Release cut",
  plan: "Plan closed",
  review: "Clean review",
  releasePublished: "Release published",
};

/** Axial hex coordinates in spiral order from the landing site (center). */
export function hexTiles(radius: number): { q: number; r: number }[] {
  const tiles = [{ q: 0, r: 0 }];
  const dirs = [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
  ];
  for (let k = 1; k <= radius; k += 1) {
    let q = -k;
    let r = k;
    for (let side = 0; side < 6; side += 1) {
      for (let step = 0; step < k; step += 1) {
        tiles.push({ q, r });
        q += dirs[side][0];
        r += dirs[side][1];
      }
    }
  }
  return tiles;
}

const whole = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);

export function emptyState(): GameState {
  return { v: 1, seq: 0, queue: [], built: [], spent: { logic: 0, compute: 0, rare: 0 } };
}

/** Normalized player state from storage (malformed input -> an empty colony). */
// biome-ignore lint: stored JSON is untyped
export function parseState(raw: any): GameState {
  if (!raw || typeof raw !== "object" || raw.v !== 1) return emptyState();
  const ids = new Set(STRUCTURES.map((s) => s.id));
  const fin = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  const queue = (Array.isArray(raw.queue) ? raw.queue : [])
    // biome-ignore lint: stored JSON is untyped
    .filter((b: any) => b && ids.has(b.structure) && fin(b.startedAt) && fin(b.durationMs) && b.durationMs > 0)
    .slice(0, MAX_ACTIVE_BUILDS)
    // biome-ignore lint: stored JSON is untyped
    .map((b: any) => ({ id: whole(b.id), structure: b.structure, startedAt: b.startedAt, durationMs: b.durationMs }));
  const built = (Array.isArray(raw.built) ? raw.built : [])
    // biome-ignore lint: stored JSON is untyped
    .filter((b: any) => b && ids.has(b.structure) && fin(b.completedAt))
    .slice(0, 500)
    // biome-ignore lint: stored JSON is untyped
    .map((b: any) => ({ structure: b.structure, completedAt: b.completedAt }));
  const spent = raw.spent && typeof raw.spent === "object" ? raw.spent : {};
  return { v: 1, seq: whole(raw.seq), queue, built, spent: { logic: whole(spent.logic), compute: whole(spent.compute), rare: whole(spent.rare) } };
}

/** Earned totals from the ledger (zeros when absent). */
// biome-ignore lint: the snapshot is open JSON
export function earned(ledger: any): Purse {
  const t = ledger && ledger.totals && typeof ledger.totals === "object" ? ledger.totals : {};
  return { logic: whole(t.logic), compute: whole(t.compute), rare: whole(t.rare) };
}

/** Spendable = earned - spent, never below zero. */
export function wallet(e: Purse, s: GameState): Purse {
  return { logic: Math.max(0, e.logic - s.spent.logic), compute: Math.max(0, e.compute - s.spent.compute), rare: Math.max(0, e.rare - s.spent.rare) };
}

/** Flow overclock (ADR point 6): FLOW_STREAK closed to-dos in a row, the last within FLOW_WINDOW_MS. */
export function overclockActive(flow: Flow | null | undefined, nowMs: number): boolean {
  if (!flow || typeof flow.streak !== "number" || !Number.isFinite(flow.streak) || flow.streak < FLOW_STREAK) return false;
  const last = Date.parse(flow.lastClosedAt || "");
  return Number.isFinite(last) && nowMs - last >= 0 && nowMs - last <= FLOW_WINDOW_MS;
}

export function buildEndsAt(b: Build, overclock: boolean): number {
  return b.startedAt + b.durationMs * (overclock ? OVERCLOCK_FACTOR : 1);
}

/** Lazy settle: finished builds move to `built`; `changed` says whether to persist. */
export function settle(s: GameState, nowMs: number, overclock: boolean): { state: GameState; changed: boolean } {
  const done: Built[] = [];
  const queue: Build[] = [];
  for (const b of s.queue) {
    const endsAt = buildEndsAt(b, overclock);
    if (nowMs >= endsAt) done.push({ structure: b.structure, completedAt: Math.round(endsAt) });
    else queue.push(b);
  }
  if (!done.length) return { state: s, changed: false };
  return { state: { ...s, queue, built: [...s.built, ...done] }, changed: true };
}

/** Why a structure cannot be queued now, or null when it can. */
export function buildBlocker(st: Structure | undefined, s: GameState, w: Purse): string | null {
  if (!st) return "Unknown structure";
  if (st.unique && (s.built.some((b) => b.structure === st.id) || s.queue.some((b) => b.structure === st.id))) return "Already on the map";
  if (s.queue.length >= MAX_ACTIVE_BUILDS) return "Build queue full";
  const c = st.cost;
  if (w.logic < c.logic || w.compute < c.compute || w.rare < c.rare) return "Not enough resources";
  return null;
}

/** Queue a build: spend its cost and start its timer. Null when it cannot be queued. */
export function queueBuild(s: GameState, structureId: string, e: Purse, nowMs: number): GameState | null {
  const st = STRUCTURES.find((x) => x.id === structureId);
  if (!st || buildBlocker(st, s, wallet(e, s))) return null;
  const seq = s.seq + 1;
  return {
    ...s,
    seq,
    queue: [...s.queue, { id: seq, structure: st.id, startedAt: nowMs, durationMs: st.minutes * 60 * 1000 }],
    spent: { logic: s.spent.logic + st.cost.logic, compute: s.spent.compute + st.cost.compute, rare: s.spent.rare + st.cost.rare },
  };
}

/** Green tiles: the ledger clears ground slowly (square root) up to 60% of the map; buildings green the rest. */
export function greenTiles(e: Purse, s: GameState, tileCount: number): number {
  const points = e.logic + e.compute / 4;
  const fromLedger = Math.floor(Math.sqrt(points) * 2) + e.rare;
  let green = Math.min(Math.floor(tileCount * 0.6), fromLedger);
  for (const b of s.built) {
    const st = STRUCTURES.find((x) => x.id === b.structure);
    if (st) green += st.greens;
  }
  return Math.max(0, Math.min(tileCount, green));
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

/** The glyph on each map tile (index into hexTiles): the Uplink at the centre, then built order. */
export function placedGlyphs(s: GameState, tileCount: number): string[] {
  const placed: string[] = [];
  if (s.built.some((b) => b.structure === "uplink")) placed[0] = "U";
  let slot = 1;
  for (const b of s.built) {
    if (b.structure === "uplink") continue;
    const st = STRUCTURES.find((x) => x.id === b.structure);
    if (st && slot < tileCount) placed[slot++] = st.glyph;
  }
  return placed;
}

/** The per-folder storage key of the player's state. */
export function stateKey(root: string): string {
  return `colony-game-state-v1:${root}`;
}
