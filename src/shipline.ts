// The Ship lane as one status line (plan colony-git-tab-forge-ux r5; git-cicd ADR amend
// 2026-11-08 point 4). Pure, no imports, so scripts/shipline.test.mjs loads it. Staging vs main
// comes from the snapshot's `shipLane.compare` (Mission Control data 1.11.0: the forge's
// Ref.compare, else local refs marked local, with release-worthy commits counted apart). An
// older engine has no `compare`: the line then says the count is local and may include merges,
// instead of showing a number that reads as "commits to release".

type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : {});
const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/** The staging vs main comparison the lane reads, or null when the engine predates it. */
export function laneCompare(lane: J): J | null {
  const c = o(lane.compare);
  return c.source === "forge" || c.source === "local" ? c : null;
}

/** Is the default branch an ancestor of staging (no sync needed)? null: not known. */
export function mainInStaging(lane: J): boolean | null {
  const c = laneCompare(lane);
  if (c && n(c.behind) !== null) return n(c.behind) === 0;
  const local = o(lane.local).mainInStaging;
  return typeof local === "boolean" ? local : null;
}

/** How many commits staging is ahead of main: the forge's count, else the local one. */
export function stagingAhead(lane: J): number | null {
  const c = laneCompare(lane);
  return c ? n(c.ahead) : n(o(lane.local).stagingAheadOfMain);
}

export interface ShipLine {
  text: string;
  tone: "green" | "yellow" | "red" | "gray";
  /** A row is pending or red: the rows show without a click. */
  open: boolean;
}

/** `09:41` from an ISO time (local clock), or "". */
function clock(iso: unknown): string {
  const t = Date.parse(s(iso));
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The one line: last tag shipped, staging vs main, then the forge read time. */
export function shipLine(lane: J): ShipLine {
  const rows: J[] = Array.isArray(lane.rows) ? lane.rows.map(o) : [];
  const red = rows.filter((r) => r.state === "red").length;
  const pending = rows.filter((r) => r.state === "pending").length;
  const local = o(lane.local);
  const remote = o(lane.remote);
  const parts: string[] = [];
  const tag = s(local.latestTag) || s(o(remote.tag).name);
  parts.push(tag ? `${tag} shipped` : "nothing shipped yet");
  const c = laneCompare(lane);
  if (c) {
    const ahead = n(c.ahead) ?? 0;
    const release = n(c.release) ?? 0;
    const mark = c.source === "local" ? " (local refs, not fetched)" : "";
    if (release > 0) parts.push(`release pending: ${release}${c.truncated === true ? "+" : ""} commit${release === 1 ? "" : "s"}${mark}`);
    else if (ahead > 0) parts.push(`staging +${ahead} (nothing to ship)${mark}`);
    else parts.push(`staging = main${mark}`);
    const behind = n(c.behind) ?? 0;
    if (behind > 0) parts.push(`main +${behind} (staging sync due)`);
  } else {
    const ahead = n(local.stagingAheadOfMain);
    if (ahead !== null) parts.push(ahead > 0 ? `staging +${ahead} (local count, may include merges; update the engine for the forge count)` : "staging = main (local)");
  }
  if (red) parts.push(`${red} blocked`);
  else if (pending) parts.push(`${pending} pending`);
  const read = clock(remote.fetchedAt);
  if (read) parts.push(`forge read ${read}`);
  else if (remote.available === false) parts.push(`forge not read${remote.reason ? ` (${s(remote.reason).slice(0, 40)})` : ""}`);
  const tone = red ? "red" : pending ? "yellow" : rows.length ? "green" : "gray";
  return { text: parts.join(" · "), tone, open: red + pending > 0 };
}
