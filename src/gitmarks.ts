// Explorer git marks (plan colony-explorer-git-workbench x2; shell ADR amend 2026-11-07,
// Explorer git workbench, point 3). Pure: the marks from `git_marks` in, a lookup out. Node
// runs it directly in scripts/gitmarks.test.mjs, so it keeps to erasable TypeScript syntax.

/** M modified, A added, U untracked, D deleted, R renamed, ! conflicted. */
export type MarkLetter = "M" | "A" | "U" | "D" | "R" | "!";
/** What `git_marks` returns per path: a letter, or I for ignored. */
export type RawMark = MarkLetter | "I";

export interface GitMarkEntry { path: string; mark: RawMark }

export interface RowMark {
  /** The letter shown on the row, or null. A folder shows its strongest descendant's. */
  letter: MarkLetter | null;
  /** Ignored by git: the row is dimmed. */
  ignored: boolean;
  /** The row's own status (a file), or the strongest inside it (a folder). */
  title: string;
}

/** Strongest first: a folder takes the strongest status among its descendants. */
const RANK: Record<MarkLetter, number> = { "!": 6, M: 5, D: 4, R: 3, A: 2, U: 1 };

export const MARK_NAMES: Record<MarkLetter, string> = {
  "!": "conflicted",
  M: "modified",
  D: "deleted",
  R: "renamed",
  A: "added",
  U: "untracked",
};

/** The skin token each letter is drawn in (the seven semantic tokens; amend point 2). */
export const MARK_TOKENS: Record<MarkLetter, string> = {
  "!": "--red",
  M: "--yellow",
  D: "--orange",
  R: "--blue",
  A: "--green",
  U: "--cyan",
};

const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/"));

export interface MarkIndex { get(path: string, isDir: boolean): RowMark }

const NONE: RowMark = { letter: null, ignored: false, title: "" };

export function stronger(a: MarkLetter | null, b: MarkLetter | null): MarkLetter | null {
  if (!a) return b;
  if (!b) return a;
  return RANK[b] > RANK[a] ? b : a;
}

/** Build the lookup. Paths are absolute; a path ending in `/` is a folder git collapsed
 *  (untracked or ignored), whose contents take its mark. */
export function buildMarkIndex(entries: readonly GitMarkEntry[]): MarkIndex {
  const own = new Map<string, MarkLetter>();
  const collapsed = new Map<string, RawMark>(); // folder path without the slash -> mark
  const ignored = new Set<string>();
  const inside = new Map<string, MarkLetter>(); // folder -> strongest mark below it
  for (const e of entries) {
    const dir = e.path.endsWith("/");
    const path = dir ? e.path.slice(0, -1) : e.path;
    if (!path) continue;
    if (e.mark === "I") {
      if (dir) collapsed.set(path, "I");
      else ignored.add(path);
      continue; // ignored paths never colour their parents
    }
    if (dir) collapsed.set(path, e.mark);
    else own.set(path, stronger(own.get(path) ?? null, e.mark) ?? e.mark);
    for (let p = parentOf(path); p; p = parentOf(p)) {
      const cur = inside.get(p) ?? null;
      const next = stronger(cur, e.mark);
      if (next === cur) break; // every ancestor above already holds this or stronger
      inside.set(p, next as MarkLetter);
    }
  }
  const fromCollapsed = (path: string): RawMark | null => {
    for (let p = path; p; p = parentOf(p)) {
      const m = collapsed.get(p);
      if (m) return m;
    }
    return null;
  };
  return {
    get(path: string, isDir: boolean): RowMark {
      const c = fromCollapsed(path);
      if (c === "I" || ignored.has(path)) return { letter: null, ignored: true, title: "ignored" };
      if (c) return { letter: c, ignored: false, title: MARK_NAMES[c] };
      const mine = own.get(path) ?? null;
      const below = isDir ? (inside.get(path) ?? null) : null;
      const letter = stronger(mine, below);
      if (!letter) return NONE;
      return { letter, ignored: false, title: isDir && !mine ? `contains ${MARK_NAMES[letter]} files` : MARK_NAMES[letter] };
    },
  };
}

/** Run `fn` once, `ms` after the last call (a burst of focus and snapshot events). */
export function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn();
    }, ms);
  };
}
