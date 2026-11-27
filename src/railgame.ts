// The rail's game item (kit ADR 2026-10-24 amend 2026-11-19, point 4): settings.json
// `ui.layout.railGame` and View → Show or hide Oligarchy on the rail (`rail-game`) take the
// Oligarchy item off the rail or put it back. Hidden, it is off the rail only: `colony://play`,
// `view:colony` and the palette still open the view, and RAIL itself (so Ctrl+1..9) never
// changes. No imports, so scripts/*.test.mjs loads it.

/** The rail item id of the game. */
export const RAIL_GAME = "colony";

/** Unset or true shows the item (Ask r0-oligarchy-default: Shown by default); only false hides it. */
export function railGameShown(l: { railGame?: boolean } | null | undefined): boolean {
  return l?.railGame !== false;
}

/** The rail items on screen, in rail order: all of them, or all but the game item. */
export function railOnScreen<T extends { id: string }>(items: readonly T[], gameShown: boolean): T[] {
  return items.filter((r) => gameShown || r.id !== RAIL_GAME);
}

/** Where a key moves the focus among `count` on-screen rail items from index `at` (arrows step,
 *  Home / End jump, clamped at the ends); undefined for any other key. */
export function railKeyTarget(key: string, at: number, count: number): number | undefined {
  const next = ({ ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: count - 1 } as Record<string, number>)[key];
  return next === undefined ? undefined : Math.max(0, Math.min(count - 1, next));
}
