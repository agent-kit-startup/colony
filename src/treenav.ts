// Explorer keyboard map, selection model and type-ahead filter (shell ADR amend 2026-11-07,
// point 4), as pure functions over the visible rows so the Node tests need no DOM. The tree
// (src/filetree.ts) reads its rows in document order, asks what a key or a click does, and
// applies the answer. No imports.

/** A visible row: collapsed folders' children are not rows. `depth` 0 is the root's children. */
export type NavRow = { path: string; isDir: boolean; expanded: boolean; depth: number };

export type NavKey = { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean };

/** What a key does. `index` is a row of the list the key was asked about. */
export type NavAction =
  | { kind: "focus"; index: number; extend: boolean; keep?: boolean }
  | { kind: "toggle"; index: number }
  | { kind: "expand"; index: number }
  | { kind: "collapse"; index: number }
  | { kind: "open"; index: number }
  | { kind: "rename"; index: number }
  | { kind: "delete" }
  | { kind: "filter"; query: string };

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** The keys of a focused tree. `focus` is the focused row (-1: none), `query` the filter. Keys
 *  with Alt or Meta are never taken, and with Ctrl only the selection keys: Ctrl+Up and Down
 *  move the focus and keep the selection (`keep`), Ctrl+Space toggles the focused row. Every
 *  other Ctrl key belongs to the window's shortcuts. */
export function navKey(rows: NavRow[], focus: number, ev: NavKey, query: string): NavAction | null {
  if (ev.metaKey || ev.altKey) return null;
  const n = rows.length;
  if (ev.ctrlKey) {
    const at = focus >= 0 && focus < n ? focus : -1;
    if (!n || ev.shiftKey) return null;
    if (ev.key === "ArrowDown") return { kind: "focus", index: at < 0 ? 0 : Math.min(at + 1, n - 1), extend: false, keep: true };
    if (ev.key === "ArrowUp") return { kind: "focus", index: at < 0 ? 0 : Math.max(at - 1, 0), extend: false, keep: true };
    if (ev.key === " " && at >= 0) return { kind: "toggle", index: at };
    return null;
  }
  const extend = !!ev.shiftKey;
  const at = focus >= 0 && focus < n ? focus : -1;
  const row = at >= 0 ? rows[at] : null;
  switch (ev.key) {
    case "ArrowDown":
      return n ? { kind: "focus", index: at < 0 ? 0 : Math.min(at + 1, n - 1), extend } : null;
    case "ArrowUp":
      return n ? { kind: "focus", index: at < 0 ? 0 : Math.max(at - 1, 0), extend } : null;
    case "Home":
      return n ? { kind: "focus", index: 0, extend } : null;
    case "End":
      return n ? { kind: "focus", index: n - 1, extend } : null;
    case "ArrowRight":
      if (!row?.isDir) return null;
      if (!row.expanded) return { kind: "expand", index: at };
      // Expanded: go to its first child, when it has one.
      return at + 1 < n && rows[at + 1].depth > row.depth ? { kind: "focus", index: at + 1, extend: false } : null;
    case "ArrowLeft": {
      if (!row) return null;
      if (row.isDir && row.expanded) return { kind: "collapse", index: at };
      for (let i = at - 1; i >= 0; i--) if (rows[i].depth < row.depth) return { kind: "focus", index: i, extend: false };
      return null;
    }
    case "Enter":
      return row ? { kind: "open", index: at } : null;
    case "F2":
      return row ? { kind: "rename", index: at } : null;
    case "Delete":
      return row ? { kind: "delete" } : null;
    case "Escape":
      return query ? { kind: "filter", query: "" } : null;
    case "Backspace":
      return query ? { kind: "filter", query: query.slice(0, -1) } : null;
  }
  // Type-ahead: a printable character extends the filter (a space only inside a query).
  if (ev.key.length === 1 && (ev.key !== " " || query)) return { kind: "filter", query: query + ev.key };
  return null;
}

/** The rows a filter keeps: names containing the query (case-insensitive), and the folders
 *  above each match so the match stays in its place. An empty query keeps every row. */
export function filterRows(rows: NavRow[], query: string): boolean[] {
  if (!query) return rows.map(() => true);
  const q = query.toLowerCase();
  const keep = rows.map((r) => baseName(r.path).toLowerCase().includes(q));
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!keep[i]) continue;
    // Walk up: the nearest shallower row before i is its parent, and so on to depth 0.
    let d = rows[i].depth;
    for (let j = i - 1; j >= 0 && d > 0; j--) {
      if (rows[j].depth < d) {
        keep[j] = true;
        d = rows[j].depth;
      }
    }
  }
  return keep;
}

/** The first row whose own name matches the query (where the focus goes as the filter grows). */
export function firstMatch(rows: NavRow[], query: string): number {
  const q = query.toLowerCase();
  return q ? rows.findIndex((r) => baseName(r.path).toLowerCase().includes(q)) : -1;
}

export type Selection = { selected: Set<string>; anchor: string | null };

/** A click or a focus move with modifiers, over the visible paths in order. Plain: that row
 *  alone. Ctrl: toggle it. Shift: the range from the anchor (Ctrl+Shift adds the range). */
export function selectTo(order: string[], cur: Selection, path: string, mods: { shift?: boolean; ctrl?: boolean }): Selection {
  if (mods.shift) {
    const from = cur.anchor !== null && order.includes(cur.anchor) ? order.indexOf(cur.anchor) : order.indexOf(path);
    const to = order.indexOf(path);
    if (to < 0) return { selected: new Set([path]), anchor: path };
    const [a, b] = from <= to ? [from, to] : [to, from];
    const range = order.slice(a, b + 1);
    const selected = mods.ctrl ? new Set([...cur.selected, ...range]) : new Set(range);
    return { selected, anchor: cur.anchor !== null && order.includes(cur.anchor) ? cur.anchor : path };
  }
  if (mods.ctrl) {
    const selected = new Set(cur.selected);
    if (selected.has(path)) selected.delete(path);
    else selected.add(path);
    return { selected, anchor: path };
  }
  return { selected: new Set([path]), anchor: path };
}

/** What a context-menu row acts on: the whole selection when the clicked row is in it, else
 *  the clicked row alone. Listed in tree order. */
export function contextTargets(order: string[], selected: Set<string>, path: string): string[] {
  return selected.has(path) ? order.filter((p) => selected.has(p)) : [path];
}

/** Drop paths inside another listed folder (trashing or moving the folder covers them). */
export function outermost(paths: string[]): string[] {
  return paths.filter((p) => !paths.some((q) => q !== p && p.startsWith(`${q}/`)));
}

/** Pixels a press must travel before it is a drag (less is a click), as for tabs. */
export const DRAG_THRESHOLD = 5;

export type Move = { from: string; to: string };

/** Dropping `sources` on the folder `dest`: one rename per outermost source into `dest`, the
 *  ones already in `dest` left out. Empty (nothing to drop) when `dest` is a source or lies
 *  inside one, or when every source is already there. */
export function movePlan(sources: string[], dest: string): Move[] {
  if (sources.some((s) => dest === s || dest.startsWith(`${s}/`))) return [];
  return outermost(sources)
    .filter((s) => s.slice(0, s.lastIndexOf("/")) !== dest)
    .map((s) => ({ from: s, to: `${dest}/${baseName(s)}` }));
}

/** The folder a drop lands in: a folder row itself, a file row's folder, the tree's empty
 *  space the root. Null outside the tree. */
export function dropDir(row: { path: string; isDir: boolean } | null, inTree: boolean, root: string): string | null {
  if (row) return row.isDir ? row.path : row.path.slice(0, row.path.lastIndexOf("/")) || root;
  return inTree ? root : null;
}
