// The game data Colony gives the Oligarchy web page loaded inside Colony (kit ADR 2026-11-17,
// points 2 and 6): per outcome only its kind and time, counts per kind and per resource, and the
// flow streak as a number. Nothing else from the kit's `outcomeLedger` snapshot field crosses:
// no labels, event keys, SHAs, run ids, tags, ledger path, plan or to-do names, test commands or
// repository name. The shape is built field by field from constant lists; the input is never
// spread, filtered or echoed, and the only string that crosses (`at`) is re-emitted by Date.
//
// The channel is data only and one way: Colony posts to the page's window with an exact target
// origin, and the only message it reads from the page is a request for that data. No import, no
// DOM access at load: scripts/oligarchyfeed.test.mjs runs this file in node.

/** Contract version, sent in every message. */
export const GAME_DATA_VERSION = 1;
/** The message Colony posts to the page. */
export const GAME_DATA_MESSAGE = "oligarchy:game-data";
/** The only message Colony reads from the page: a request for the current data. */
export const GAME_DATA_REQUEST = "oligarchy:game-data-request";

/**
 * Origins the game page may be loaded from (ADR point 8). The staging origin
 * (https://oligarchy-staging.missionkit.io) joins only behind a Colony Settings switch, which a
 * later change adds; callers pass the list they built from that switch, this one is the default.
 */
export const OLIGARCHY_ORIGINS: readonly string[] = Object.freeze(["https://oligarchy.missionkit.io"]);

/** The game's page on its origin (the site serves the game at /game/). */
export const GAME_PATH = "/game/";

/** The address the game view loads: an allowed origin plus GAME_PATH, else null (no fallback). */
export function gameUrl(origin: string = OLIGARCHY_ORIGINS[0], allowed: readonly string[] = OLIGARCHY_ORIGINS): string | null {
  return isAllowedOrigin(origin, allowed) ? `${origin}${GAME_PATH}` : null;
}

/**
 * The game frame's sandbox (ADR point 6): scripts, and the page's own origin so its storage keeps
 * the save. Nothing else: no top navigation (the page's `colony://play` links stay inert inside
 * Colony), no popups, forms, modals, downloads or pointer lock.
 */
export const FRAME_SANDBOX = "allow-scripts allow-same-origin";

/** What `colony://play` shows: the game tab of the open folder, or the game with no folder. */
export function playTarget(hasFolder: boolean): "tab" | "no-folder" {
  return hasFolder ? "tab" : "no-folder";
}

/** The kit's `OUTCOME_KINDS` (dashboard/lib/outcome-ledger.mjs), in its order. */
export const OUTCOME_KINDS = Object.freeze(["todo", "test", "ci", "releaseCut", "plan", "review", "releasePublished"] as const);
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];
export const RESOURCES = Object.freeze(["logic", "compute", "rare"] as const);
export type Resource = (typeof RESOURCES)[number];

/**
 * Most outcomes copied. The kit's snapshot carries its newest 20 (`MAX_RECENT_ENTRIES`); the cap
 * keeps a message small if a later kit sends more.
 */
export const MAX_OUTCOMES = 20;

export interface GameOutcome {
  kind: OutcomeKind;
  /** ISO 8601 in UTC (`toISOString`), or null when the ledger has no valid time. */
  at: string | null;
}

export interface GameData {
  version: 1;
  /** Newest first, at most MAX_OUTCOMES: a window, not the whole ledger (compare with `byKind`). */
  outcomes: GameOutcome[];
  /** Outcomes per kind over the whole ledger. */
  byKind: Record<OutcomeKind, number>;
  /** Outcomes per resource over the whole ledger. */
  byResource: Record<Resource, number>;
  /** Consecutive to-dos closed in the latest mission; 0 with no flow signal. */
  flowStreak: number;
}

export interface GameDataMessage {
  type: typeof GAME_DATA_MESSAGE;
  version: 1;
  data: GameData;
}

const KIND_SET: ReadonlySet<string> = new Set(OUTCOME_KINDS);

type Rec = Record<string, unknown>;
const record = (v: unknown): Rec | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : null);
/** An own property only: never one inherited from Object.prototype. */
const own = (r: Rec | null, key: string): unknown => (r && Object.prototype.hasOwnProperty.call(r, key) ? r[key] : undefined);

/** A count: a finite number floored to a non-negative safe integer, else 0. */
export function count(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 0;
  return Math.min(Math.floor(v), Number.MAX_SAFE_INTEGER);
}

// A calendar date, or a date and time with an explicit zone (Z or an offset). A time without a
// zone would parse as the machine's local time, so it is refused rather than guessed.
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2}))?$/;

/** An ISO time re-emitted in UTC by Date, or null. The input string is never passed on. */
export function isoTime(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 40) return null;
  const m = ISO_RE.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  // Refuse dates Date would roll over (2026-02-30 is not 2026-03-02).
  if (day.getUTCFullYear() !== Number(y) || day.getUTCMonth() !== Number(mo) - 1 || day.getUTCDate() !== Number(d)) return null;
  if (h !== undefined && (Number(h) > 23 || Number(mi) > 59 || (s !== undefined && Number(s) > 59))) return null;
  const ms = Date.parse(v.trim().replace(" ", "T"));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function emptyCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = 0;
  return out;
}

/** The empty shape: no folder, no ledger, an older kit, or `available: false`. A fresh object per call. */
export function emptyGameData(): GameData {
  return { version: GAME_DATA_VERSION, outcomes: [], byKind: emptyCounts(OUTCOME_KINDS), byResource: emptyCounts(RESOURCES), flowStreak: 0 };
}

/**
 * The game data from the snapshot's `outcomeLedger` (any value). Reads only `available`,
 * `recent[].kind`, `recent[].at`, `byKind.<kind>`, `totals.<resource>` and `flow.streak`; an
 * outcome of an unknown kind is dropped.
 */
export function gameDataFromLedger(ledger: unknown): GameData {
  const out = emptyGameData();
  const l = record(ledger);
  if (!l || own(l, "available") === false) return out;
  const recent = own(l, "recent");
  if (Array.isArray(recent)) {
    for (const row of recent) {
      if (out.outcomes.length >= MAX_OUTCOMES) break;
      const r = record(row);
      const kind = own(r, "kind");
      if (typeof kind !== "string" || !KIND_SET.has(kind)) continue;
      out.outcomes.push({ kind: kind as OutcomeKind, at: isoTime(own(r, "at")) });
    }
  }
  const byKind = record(own(l, "byKind"));
  for (const k of OUTCOME_KINDS) out.byKind[k] = count(own(byKind, k));
  const totals = record(own(l, "totals"));
  for (const k of RESOURCES) out.byResource[k] = count(own(totals, k));
  out.flowStreak = count(own(record(own(l, "flow")), "streak"));
  return out;
}

/**
 * Whether `origin` is exactly one of `allowed`: string equality, no parsing, no prefixes. `"*"`
 * (any origin) and `"/"` (Colony's own) are never a target, whatever list a caller passes.
 */
export function isAllowedOrigin(origin: unknown, allowed: readonly string[] = OLIGARCHY_ORIGINS): origin is string {
  return typeof origin === "string" && origin !== "*" && origin !== "/" && allowed.includes(origin);
}

/** The message for a ledger. Takes the ledger, not a GameData, so nothing unfiltered is posted. */
export function gameDataMessage(ledger: unknown): GameDataMessage {
  return { type: GAME_DATA_MESSAGE, version: GAME_DATA_VERSION, data: gameDataFromLedger(ledger) };
}

/** The page's window, as the channel uses it (an iframe's `contentWindow`). */
export interface GameTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

/**
 * Post the game data to the page's window, addressed to `origin` exactly. Refused (false, nothing
 * posted) with no target or an origin outside `allowed`, `"*"` and `"/"` included.
 */
export function postGameData(target: GameTarget | null | undefined, origin: string, ledger: unknown, allowed: readonly string[] = OLIGARCHY_ORIGINS): boolean {
  if (!target || !isAllowedOrigin(origin, allowed)) return false;
  target.postMessage(gameDataMessage(ledger), origin);
  return true;
}

/** The fields of a `message` event the channel reads. */
export interface GameRequestEvent {
  origin: string;
  source: unknown;
  data: unknown;
}

/**
 * A handler for `message` events on Colony's window that answers the page's data request. It
 * answers only when the event comes from `target` itself, from exactly `origin`, and `origin` is
 * allowed; of the event's data it reads `type` and nothing else. Every other message is ignored.
 * The caller adds it with addEventListener("message", ...) and removes it with the frame.
 */
export function gameDataRequestHandler(
  target: () => GameTarget | null | undefined,
  origin: string,
  ledger: () => unknown,
  allowed: readonly string[] = OLIGARCHY_ORIGINS,
): (event: GameRequestEvent) => boolean {
  return (event) => {
    const frame = target();
    if (!frame || event.source !== frame) return false;
    if (event.origin !== origin || !isAllowedOrigin(origin, allowed)) return false;
    if (own(record(event.data), "type") !== GAME_DATA_REQUEST) return false;
    return postGameData(frame, origin, ledger(), allowed);
  };
}
