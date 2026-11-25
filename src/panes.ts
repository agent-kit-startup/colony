// The centre area as a split tree (kit ADR 2026-10-24, amend 2026-11-19 free tiling): a node is
// a split (right: side by side, down: one above the other) with the share of its first child,
// or a leaf pane with its own tab strip. Splitting halves a pane; removing one gives its space
// to its sibling. Every pane holds any document tab kind (a file, a doc preview, a terminal, an
// agent chat, a run); a file may sit in two panes at once (one model, a view state per pane),
// every other tab in exactly one. Pure, so scripts/panes.test.mjs runs it under Node; keep to
// erasable syntax.

export type SplitDir = "right" | "down";
export interface PaneLeaf {
  pane: string;
}
export interface PaneSplit {
  split: SplitDir;
  /** The first child's share of the split, kept inside [MIN_RATIO, MAX_RATIO]. */
  ratio: number;
  a: PaneNode;
  b: PaneNode;
}
export type PaneNode = PaneLeaf | PaneSplit;
/** Which child to take at each split, from the root down to a node. */
export type PanePath = ("a" | "b")[];

export const MIN_RATIO = 0.1;
export const MAX_RATIO = 0.9;
/** More panes than this would leave each one too small to use. */
export const MAX_PANES = 16;

export function isLeaf(n: PaneNode): n is PaneLeaf {
  return "pane" in n;
}

export function clampRatio(r: number): number {
  return Number.isFinite(r) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, r)) : 0.5;
}

/** The pane ids in reading order (left to right, top to bottom). */
export function leaves(n: PaneNode): string[] {
  return isLeaf(n) ? [n.pane] : [...leaves(n.a), ...leaves(n.b)];
}

/** The path to the leaf `id`, or null when the tree has no such pane. */
export function pathTo(n: PaneNode, id: string, at: PanePath = []): PanePath | null {
  if (isLeaf(n)) return n.pane === id ? at : null;
  return pathTo(n.a, id, [...at, "a"]) ?? pathTo(n.b, id, [...at, "b"]);
}

export function nodeAt(n: PaneNode, path: PanePath): PaneNode | null {
  let cur: PaneNode = n;
  for (const step of path) {
    if (isLeaf(cur)) return null;
    cur = cur[step];
  }
  return cur;
}

/** The tree with the node at `path` replaced (the input is never changed). */
function replaceAt(n: PaneNode, path: PanePath, next: PaneNode): PaneNode {
  if (!path.length) return next;
  if (isLeaf(n)) return n;
  const [step, ...rest] = path;
  return { ...n, [step]: replaceAt(n[step], rest, next) };
}

/** Split the pane `id` in two: it keeps the first half (left or top), `fresh` gets the
 *  second. Unchanged when `id` is not in the tree, `fresh` already is, or the tree is full. */
export function splitPane(root: PaneNode, id: string, dir: SplitDir, fresh: string): PaneNode {
  const path = pathTo(root, id);
  const all = leaves(root);
  if (!path || all.includes(fresh) || all.length >= MAX_PANES) return root;
  return replaceAt(root, path, { split: dir, ratio: 0.5, a: { pane: id }, b: { pane: fresh } });
}

/** Remove the pane `id`: its sibling takes the parent split's place. Null when `id` is the
 *  only pane (the last pane never goes); the tree unchanged when `id` is not in it. */
export function removePane(root: PaneNode, id: string): PaneNode | null {
  const path = pathTo(root, id);
  if (!path) return root;
  if (!path.length) return null;
  const parent = path.slice(0, -1);
  const split = nodeAt(root, parent) as PaneSplit;
  const sibling = path[path.length - 1] === "a" ? split.b : split.a;
  return replaceAt(root, parent, sibling);
}

/** The pane that takes the space of `id` when it is removed: the nearest pane of its sibling
 *  (the sibling's first pane when `id` came first, else its last). */
export function heir(root: PaneNode, id: string): string | null {
  const path = pathTo(root, id);
  if (!path?.length) return null;
  const split = nodeAt(root, path.slice(0, -1)) as PaneSplit;
  const first = path[path.length - 1] === "a";
  const ids = leaves(first ? split.b : split.a);
  return first ? ids[0] : ids[ids.length - 1];
}

/** The tree with the split at `path` set to `ratio` (clamped). */
export function setRatio(root: PaneNode, path: PanePath, ratio: number): PaneNode {
  const n = nodeAt(root, path);
  if (!n || isLeaf(n)) return root;
  return replaceAt(root, path, { ...n, ratio: clampRatio(ratio) });
}

// ---- the tabs of each pane ---------------------------------------------------------------

/** A pane's strip: its document tabs in order. */
export interface Strip {
  order: string[];
}

/** `id` added after `after` (at the end when `after` is not in the strip); unchanged when the
 *  strip already holds it. */
export function stripAdd(s: Strip, id: string, after?: string | null): Strip {
  if (s.order.includes(id)) return s;
  const at = after ? s.order.indexOf(after) : -1;
  const order = [...s.order];
  order.splice(at < 0 ? order.length : at + 1, 0, id);
  return { order };
}

export function stripRemove(s: Strip, id: string): Strip {
  return { order: s.order.filter((x) => x !== id) };
}

/** What a pane shows after its shown tab `closed` leaves it: the last place in its history
 *  that still exists (`back`, when the caller found one), else the tab that sat next to the
 *  closed one (the one after it, else the one before), else nothing. */
export function nextShown(before: Strip, closed: string, back: string | null): string | null {
  if (back && back !== closed) return back;
  const i = before.order.indexOf(closed);
  const rest = before.order.filter((x) => x !== closed);
  if (!rest.length) return null;
  return rest[Math.min(Math.max(i, 0), rest.length - 1)];
}

/** Split right / down on a pane whose shown tab is `shown`: what the new pane starts with.
 *  - `copy`: the same file in both panes (one model, a view state per pane), the IDE split.
 *  - `move`: any other document tab moves over, when the pane keeps another tab.
 *  - `empty`: the new pane starts empty (a view, or the pane's only tab, stays where it is). */
export function splitContent(shown: string | null, isFile: boolean, docs: number, isDoc: boolean): "copy" | "move" | "empty" {
  if (!shown || !isDoc) return "empty";
  if (isFile) return "copy";
  return docs > 1 ? "move" : "empty";
}

/** A new pane id not in `taken` (p1, p2, ...). */
export function freshPaneId(taken: Iterable<string>): string {
  const used = new Set(taken);
  let n = 1;
  while (used.has(`p${n}`)) n++;
  return `p${n}`;
}
