// Moving a terminal tab between the editor area (the centre bar, #tabs) and the panel (the
// drawer bar, #term-tabs), both ways (kit ADR 2026-10-24 amend 2026-11-07): drawer shells
// (`drawer:<n>`) and centre PTYs (`term:<n>`: interactive CLIs, resumed chats, the driver chat,
// the queue runner). Run transcripts, files and views never move. A moved tab stays where it
// was moved until it closes; new tabs open where their kind was last moved (settings.json
// ui.layout.terminalPlacement, amend 2026-11-07 tab placement memory, the VS Code
// terminal.integrated.defaultLocation pattern). Pure, so scripts/tabmove.test.mjs runs it
// under Node; keep to erasable syntax.

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

// ---- remembered placement per kind --------------------------------------------------------

/** The three kinds that remember a place: drawer shells, interactive centre PTYs (Open
 *  interactive, resumed chats, the driver chat) and the queue runner. */
export type TermKind = "shell" | "interactive" | "queue";
/** settings.json ui.layout.terminalPlacement: an unset kind opens in its default place. */
export type Placement = Partial<Record<TermKind, Place>>;

export const TERM_KINDS: readonly TermKind[] = ["shell", "interactive", "queue"];
/** Today's placement: shells in the panel, agent PTYs in the editor area. */
export const DEFAULT_PLACE: Readonly<Record<TermKind, Place>> = { shell: "panel", interactive: "editor", queue: "editor" };

/** The placement read from settings.json, unknown kinds and values dropped (the file may be
 *  hand-edited; a bad value falls back to the kind's default). */
export function readPlacement(v: unknown): Placement {
  const out: Placement = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const k of TERM_KINDS) {
    const p = (v as Record<string, unknown>)[k];
    if (p === "editor" || p === "panel") out[k] = p;
  }
  return out;
}

/** Where a new tab of `kind` opens. */
export function openPlace(kind: TermKind, memory: Placement): Place {
  return memory[kind] ?? DEFAULT_PLACE[kind];
}

/** The settings patch for an operator's move of a `kind` tab to `to`: that place, or null
 *  (clear the kind) when it is the default, so settings.json holds only real choices. */
export function placementPatch(kind: TermKind, to: Place): { terminalPlacement: Partial<Record<TermKind, Place | null>> } {
  return { terminalPlacement: { [kind]: to === DEFAULT_PLACE[kind] ? null : to } };
}

/** The in-memory placement after the same move (what the patch writes). */
export function recordMove(memory: Placement, kind: TermKind, to: Place): Placement {
  const next = { ...memory };
  if (to === DEFAULT_PLACE[kind]) delete next[kind];
  else next[kind] = to;
  return next;
}

/** The kind of a terminal tab: a drawer shell by its id, a centre PTY by the agent kind it
 *  opened with; null for anything that has no remembered place. */
export function tabKind(id: string, agentKind?: string): TermKind | null {
  if (/^drawer:\d+$/.test(id)) return "shell";
  if (!/^term:\d+$/.test(id)) return null;
  return agentKind === "interactive" || agentKind === "queue" ? agentKind : null;
}
