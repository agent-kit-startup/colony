// Commit graph lane layout (plan colony-explorer-git-workbench x6). Pure: commits in, one row
// per commit out, each with its lane and the line segments drawn inside that row. No DOM, so
// node --test runs it (scripts/gitgraph.test.mjs).
//
// Input order is git's `--date-order` (children always before their parents). The layout is
// online: row i depends only on commits 0..i, so appending a page never changes the rows
// already drawn, and a parent not loaded yet just leaves its lane open at the bottom.

export interface LayoutCommit {
  hash: string;
  parents: string[];
}

/** Number of lane colours (src/styles.css `.gg-c0` to `.gg-c6`, the seven semantic tokens). */
export const LANE_COLOURS = 7;

/**
 * One line inside a row. Vertical positions: `top` runs from the row's top edge (lane
 * `from`) to the commit dot (lane `to`); `bottom` from the dot (lane `from`) to the bottom
 * edge (lane `to`); `pass` is a lane that crosses the row untouched (`from` === `to`).
 */
export interface Seg {
  part: "top" | "bottom" | "pass";
  from: number;
  to: number;
  colour: number;
}

export interface GraphRow {
  lane: number;
  colour: number;
  merge: boolean;
  segs: Seg[];
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Widest lane count over all rows (the column width of every row's graph cell). */
  lanes: number;
}

interface Lane {
  hash: string;
  colour: number;
}

export function layoutGraph(commits: readonly LayoutCommit[]): GraphLayout {
  let lanes: (Lane | null)[] = [];
  let next = 0;
  let width = 0;
  const colour = () => next++ % LANE_COLOURS;
  const free = (except = -1) => {
    const i = lanes.findIndex((l, j) => l === null && j !== except);
    return i === -1 ? Math.max(lanes.length, except + 1) : i;
  };
  const rows: GraphRow[] = [];
  for (const c of commits) {
    const before = lanes;
    let lane = before.findIndex((l) => l?.hash === c.hash);
    let tint: number;
    if (lane === -1) {
      // A tip nothing below it has led to yet (a branch head, a tag or the first row).
      lane = free();
      tint = colour();
    } else {
      tint = before[lane]!.colour;
    }
    const segs: Seg[] = [];
    lanes = before.slice();
    for (let j = 0; j < before.length; j++) {
      const l = before[j];
      if (!l) continue;
      if (l.hash === c.hash) {
        // Every lane waiting for this commit ends at its dot (branches joining their fork point).
        segs.push({ part: "top", from: j, to: lane, colour: l.colour });
        lanes[j] = null;
      } else {
        segs.push({ part: "pass", from: j, to: j, colour: l.colour });
      }
    }
    while (lanes.length <= lane) lanes.push(null);
    const [first, ...others] = c.parents;
    lanes[lane] = first ? { hash: first, colour: tint } : null;
    if (first) segs.push({ part: "bottom", from: lane, to: lane, colour: tint });
    for (const p of others) {
      // A merge: an edge to the lane already waiting for that parent, or a new lane for it.
      let k = lanes.findIndex((l) => l?.hash === p);
      if (k === -1) {
        k = free(lane);
        while (lanes.length <= k) lanes.push(null);
        lanes[k] = { hash: p, colour: colour() };
      }
      segs.push({ part: "bottom", from: lane, to: k, colour: lanes[k]!.colour });
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    width = Math.max(width, before.length, lanes.length, lane + 1);
    rows.push({ lane, colour: tint, merge: c.parents.length > 1, segs });
  }
  return { rows, lanes: width };
}

/** Short object name for display. */
export const shortHash = (h: string) => h.slice(0, 7);
