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
 *  second (`before`: the first). Unchanged when `id` is not in the tree, `fresh` already is,
 *  or the tree is full. */
export function splitPane(root: PaneNode, id: string, dir: SplitDir, fresh: string, before = false): PaneNode {
  const path = pathTo(root, id);
  const all = leaves(root);
  if (!path || all.includes(fresh) || all.length >= MAX_PANES) return root;
  const [a, b] = before ? [fresh, id] : [id, fresh];
  return replaceAt(root, path, { split: dir, ratio: 0.5, a: { pane: a }, b: { pane: b } });
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

// ---- keyboard: direction, swap, move, resize, equalize (plan to-do t3) -------------------

/** A direction on screen. Left and right cross a `right` split, up and down a `down` split. */
export type Dir = "left" | "right" | "up" | "down";
export const DIRS: readonly Dir[] = ["left", "right", "up", "down"];
const axis = (d: Dir): SplitDir => (d === "left" || d === "right" ? "right" : "down");
/** Toward the second child (right, down) or the first (left, up). */
const forward = (d: Dir): boolean => d === "right" || d === "down";

/** Each pane's box in the unit square (x, y, w, h), from the ratios alone. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export function boxes(n: PaneNode, at: Box = { x: 0, y: 0, w: 1, h: 1 }, out = new Map<string, Box>()): Map<string, Box> {
  if (isLeaf(n)) return out.set(n.pane, at);
  if (n.split === "right") {
    const w = at.w * n.ratio;
    boxes(n.a, { ...at, w }, out);
    boxes(n.b, { ...at, x: at.x + w, w: at.w - w }, out);
  } else {
    const h = at.h * n.ratio;
    boxes(n.a, { ...at, h }, out);
    boxes(n.b, { ...at, y: at.y + h, h: at.h - h }, out);
  }
  return out;
}

const EPS = 1e-9;

/** The pane next to `id` in direction `d`: among the panes whose facing edge touches `id`'s
 *  edge on that side, the one sharing the longest stretch of it, ties to the one nearest
 *  `id`'s centre line (then reading order). Null at the edge of the tree. */
export function neighbour(root: PaneNode, id: string, d: Dir): string | null {
  const all = boxes(root);
  const me = all.get(id);
  if (!me) return null;
  const horizontal = axis(d) === "right";
  const edge = horizontal ? (forward(d) ? me.x + me.w : me.x) : forward(d) ? me.y + me.h : me.y;
  let best: { id: string; overlap: number; dist: number } | null = null;
  for (const [other, b] of all) {
    if (other === id) continue;
    const facing = horizontal ? (forward(d) ? b.x : b.x + b.w) : forward(d) ? b.y : b.y + b.h;
    if (Math.abs(facing - edge) > EPS) continue;
    const [lo, hi, olo, ohi] = horizontal ? [me.y, me.y + me.h, b.y, b.y + b.h] : [me.x, me.x + me.w, b.x, b.x + b.w];
    const overlap = Math.min(hi, ohi) - Math.max(lo, olo);
    if (overlap <= EPS) continue;
    const dist = Math.abs((lo + hi) / 2 - (olo + ohi) / 2);
    if (!best || overlap > best.overlap + EPS || (Math.abs(overlap - best.overlap) <= EPS && dist < best.dist - EPS)) best = { id: other, overlap, dist };
  }
  return best?.id ?? null;
}

/** The pane after (`step` 1) or before (-1) `id` in reading order, wrapping around. */
export function cycle(root: PaneNode, id: string, step: 1 | -1): string | null {
  const ids = leaves(root);
  const i = ids.indexOf(id);
  if (i < 0 || ids.length < 2) return null;
  return ids[(i + step + ids.length) % ids.length];
}

/** The tree with the panes `a` and `b` trading places (unchanged unless both are in it). */
export function swapPanes(root: PaneNode, a: string, b: string): PaneNode {
  const all = leaves(root);
  if (a === b || !all.includes(a) || !all.includes(b)) return root;
  const swap = (n: PaneNode): PaneNode => (isLeaf(n) ? { pane: n.pane === a ? b : n.pane === b ? a : n.pane } : { ...n, a: swap(n.a), b: swap(n.b) });
  return swap(root);
}

/** Move pane `id` past its neighbour in direction `d`: it leaves its place (its sibling takes
 *  the space) and halves the neighbour, on the far side of it. Unchanged at the edge. */
export function movePane(root: PaneNode, id: string, d: Dir): PaneNode {
  const target = neighbour(root, id, d);
  if (!target) return root;
  const rest = removePane(root, id);
  if (!rest) return root;
  return splitPane(rest, target, axis(d), id, !forward(d));
}

/** Move the border of pane `id` that lies in direction `d` by `step` (a share of the split it
 *  divides): the nearest enclosing split across that axis where `id` sits on the near side of
 *  the border. Right / down grow the first child, left / up shrink it. Unchanged when the pane
 *  has no border on that side. */
export function resizeToward(root: PaneNode, id: string, d: Dir, step: number): PaneNode {
  const path = pathTo(root, id);
  if (!path) return root;
  const want = axis(d);
  // The border on the right (down) side belongs to a split where the pane is in `a`; on the
  // left (up) side, to a split where it is in `b`.
  const side = forward(d) ? "a" : "b";
  for (let i = path.length - 1; i >= 0; i--) {
    const at = path.slice(0, i);
    const n = nodeAt(root, at) as PaneSplit;
    if (n.split === want && path[i] === side) return setRatio(root, at, n.ratio + (forward(d) ? step : -step));
  }
  return root;
}

/** Every split's ratio set so the panes along each axis get equal room: a split's share
 *  follows how many panes each side lines up across that axis. */
export function equalize(root: PaneNode): PaneNode {
  const span = (n: PaneNode, dir: SplitDir): number => (isLeaf(n) ? 1 : n.split === dir ? span(n.a, dir) + span(n.b, dir) : Math.max(span(n.a, dir), span(n.b, dir)));
  const walk = (n: PaneNode): PaneNode => {
    if (isLeaf(n)) return n;
    const a = span(n.a, n.split);
    const b = span(n.b, n.split);
    return { ...n, ratio: clampRatio(a / (a + b)), a: walk(n.a), b: walk(n.b) };
  };
  return walk(root);
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
