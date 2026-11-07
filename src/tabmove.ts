// Moving a terminal tab between the editor area (the centre bar, #tabs) and the panel (the
// drawer bar, #term-tabs), both ways (kit ADR 2026-10-24 amend 2026-11-07): drawer shells
// (`drawer:<n>`) and centre PTYs (`term:<n>`: interactive CLIs, resumed chats, the driver chat,
// the queue runner). Run transcripts, files and views never move. The placement lasts until
// the tab closes. Pure, so scripts/tabmove.test.mjs runs it under Node; keep to erasable syntax.

/** Where a terminal tab sits: the editor area (centre) or the panel (drawer). */
export type Place = "editor" | "panel";

/** Pixels a press must travel before it is a drag (less is a click). */
export const DRAG_THRESHOLD = 5;

/** A tab id that may move: a centre PTY or a drawer shell. */
export function isPtyTab(id: string): boolean {
  return /^(term|drawer):\d+$/.test(id);
}

export function dragStarted(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD;
}

/** The bar under the pointer (anything with `closest`, such as an Element). */
export function dropPlace(el: { closest(sel: string): unknown } | null): Place | null {
  if (!el) return null;
  if (el.closest("#term-tabs")) return "panel";
  if (el.closest("#tabs")) return "editor";
  return null;
}

/** Where a tab from `from` dropped over `over` goes; null when it stays. */
export function moveTarget(from: Place, over: Place | null): Place | null {
  return over && over !== from ? over : null;
}

export function otherPlace(p: Place): Place {
  return p === "editor" ? "panel" : "editor";
}

/** The context-menu row of a tab in `from`. */
export function moveLabel(from: Place): string {
  return from === "editor" ? "Move to panel" : "Move to editor area";
}
