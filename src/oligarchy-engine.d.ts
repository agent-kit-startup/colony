// Types for @dadado/oligarchy-engine 0.1.0 (the package ships JavaScript only), written from its
// src/rules.mjs, src/world.mjs and placeholder/index.mjs. A new engine version is checked against
// these by `pnpm typecheck` and by scripts/oligarchy.test.mjs, which runs the real package.

declare module "@dadado/oligarchy-engine" {
  export type Resource = "logic" | "compute" | "rare";
  export type Purse = Record<Resource, number>;
  export type Terrain = "centre" | "plain" | "tundra";
  export type EnemyPreference = "on" | "rare" | "off";

  export interface StructureRow {
    id: string;
    name: string;
    glyph: string;
    blurb: string;
    cost: Purse;
    build_minutes: number;
    greens: number;
    unique: boolean;
    terrain: Terrain;
    countermeasure_for: string | null;
    aliases?: string[];
    art?: string | null;
    placeholder?: string | null;
    status?: string;
  }

  export interface ThreatRow {
    id: string;
    name: string;
    tier: 1 | 2 | 3;
    family: string;
    vector: string;
    countermeasure: string;
    capture: { name: string; effect: string };
    art?: string | null;
    placeholder?: string | null;
    status?: string;
  }

  export interface Catalog {
    structures: readonly StructureRow[];
    threats: readonly ThreatRow[];
    twoHex?: readonly string[];
  }

  export interface LedgerEvent {
    key: string;
    kind: string;
    at: string | null;
  }

  export interface Flow {
    plan?: string;
    streak?: number;
    lastClosedAt?: string | null;
    brokenAt?: string | null;
  }

  export interface Ledger {
    total: number;
    totals: Purse;
    events: LedgerEvent[];
    flow: Flow | null;
  }

  export interface Placed {
    id: number;
    structure: string;
    hex: number;
  }

  export interface Build extends Placed {
    startedAt: number;
    durationMs: number;
    rebuildOf?: number;
  }

  export interface ThreatInFlight {
    id: string;
    target: number;
    arrivesAt: number;
    picked: string | null;
  }

  export interface Resolution {
    threat: string;
    picked: string | null;
    outcome: "capture" | "half" | "full";
    turn: number;
  }

  export interface GameState {
    v: 1;
    seq: number;
    turn: number;
    seen: string[];
    queue: Build[];
    built: Placed[];
    spent: Purse;
    offline: number[];
    barren: number[];
    captured: string[];
    threat: ThreatInFlight | null;
    nextAttackTurn: number;
    lastResolution: Resolution | null;
  }

  export interface PlaceOptions {
    terrain: string | readonly string[];
    minRing?: number;
  }

  export interface Rules {
    readonly structures: readonly StructureRow[];
    readonly threats: readonly ThreatRow[];
    readonly hub: string;
    spanOf(structureId: string): 1 | 2;
    footprint(structureId: string, hex: number): number[];
    newGame(): GameState;
    parseState(raw: unknown): GameState;
    greenTiles(ledger: Ledger, state: GameState): number;
    revealedRing(ledger: Ledger, state: GameState, minRing?: number): number;
    canPlace(state: GameState, ledger: Ledger, structureId: string, hex: number, options: PlaceOptions): boolean;
    buildBlocker(state: GameState, ledger: Ledger, structureId: string): string | null;
    queueBuild(state: GameState, ledger: Ledger, structureId: string, hex: number, options: PlaceOptions & { now: number }): GameState | null;
    queueRepair(state: GameState, ledger: Ledger, builtId: number, options: { now: number }): GameState | null;
    unlockedTier(ledger: Ledger, state: GameState): 1 | 2 | 3;
    foldLedger(state: GameState, ledger: Ledger, options?: { enemy?: EnemyPreference }): GameState;
    countermeasures(): { id: string; name: string; family: string }[];
    countermeasureCost(threatId: string): Purse;
    pickCountermeasure(state: GameState, ledger: Ledger, countermeasureId: string): GameState | null;
  }

  export const OUTCOME_RESOURCE: Readonly<Record<string, Resource>>;
  export const TUNING: Readonly<{
    maxBuilds: number;
    flowStreak: number;
    flowWindowMs: number;
    overclock: number;
    quietTurns: number;
    [key: string]: unknown;
  }>;
  export const MAP_RADIUS: number;
  export const TILES: readonly { q: number; r: number }[];

  export function createRules(catalog: Catalog): Rules;
  export function validateRulesCatalog(catalog: unknown): string[];
  export function ledgerFromEntries(entries: unknown, flow?: Flow | null): Ledger;
  export function ledgerFromSnapshot(summary: unknown): Ledger;
  export function wallet(ledger: Ledger, state: GameState): Purse;
  export function overclockActive(flow: Flow | null | undefined, now: number): boolean;
  export function buildEndsAt(build: Build, overclock: boolean): number;
  export function settle(state: GameState, now: number, flow?: Flow | null): GameState;
  export function roll(key: string, salt: string): number;
  export function turnsLeft(state: GameState): number | null;
  export function hexTiles(radius?: number): { q: number; r: number }[];
  export function ring(index: number): number;
  export function partner(index: number): number;
  export function fitsTerrain(letter: string, structureTerrain: Terrain): boolean;
}

declare module "@dadado/oligarchy-engine/placeholder" {
  import type { Catalog, StructureRow, ThreatRow } from "@dadado/oligarchy-engine";
  export const placeholderCatalog: Catalog;
  export const twoHex: readonly string[];
  export const structures: StructureRow[];
  export const threats: ThreatRow[];
}

/** The catalog this build plays (vite.config.ts, scripts/oligarchy-catalog.mjs). */
declare module "virtual:oligarchy-catalog" {
  import type { Catalog } from "@dadado/oligarchy-engine";
  const catalog: Catalog;
  export default catalog;
  /** `placeholder`: the engine's generic catalog; `content`: the game's own, from a release build. */
  export const source: "placeholder" | "content";
}
