// The Git tab's PR list in the forge style (plan colony-git-tab-forge-ux r3; git-cicd ADR amend
// 2026-11-08 point 4). Pure, no imports, so scripts/prlist.test.mjs loads it: one state per PR
// from the operator's own `gh pr list` row, the one action that state allows, the check badge,
// the Bot test and the filters.

type J = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

/** One PR's state, in the order it is decided: the first that applies wins. */
export type PrState = "conflicts" | "behind" | "draft" | "checks running" | "failing" | "blocked" | "checking" | "ready";
/** The row's one primary action. Merge never runs in bulk (ADR amend 2026-11-08 point 1). */
export type PrAction = "resolve" | "update-branch" | "merge";

export interface CheckBadge {
  passed: number;
  total: number;
  pending: number;
  failing: string[];
  /** `passed/total`, or `no checks`. */
  text: string;
  tone: "done" | "failed" | "gate" | "";
}

const OK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const BAD = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

/** statusCheckRollup (CheckRun and StatusContext entries) as one badge. */
export function checkBadge(rollup: unknown): CheckBadge {
  let passed = 0;
  let pending = 0;
  const failing: string[] = [];
  const list = Array.isArray(rollup) ? (rollup as J[]) : [];
  for (const c of list) {
    const state = s(c.conclusion || c.state).toUpperCase();
    if (c.status && s(c.status).toUpperCase() !== "COMPLETED") pending++;
    else if (OK.has(state)) passed++;
    else if (BAD.has(state)) failing.push(s(c.name || c.context).slice(0, 120) || "?");
    else pending++;
  }
  const total = list.length;
  const tone = !total ? "" : failing.length ? "failed" : pending ? "gate" : "done";
  return { passed, total, pending, failing, text: total ? `${passed}/${total}` : "no checks", tone };
}

/** An app or bot author: gh's `is_bot`, an `app/` login, or a `[bot]` suffix. */
export function isBot(author: unknown): boolean {
  const a = (author ?? {}) as J;
  const login = s(a.login);
  return a.is_bot === true || login.startsWith("app/") || login.endsWith("[bot]");
}

/** The author's login as the row shows it (`app/` dropped). */
export function authorName(author: unknown): string {
  const login = s(((author ?? {}) as J).login);
  return (login.startsWith("app/") ? login.slice(4) : login).slice(0, 60) || "?";
}

/** The PR's state from its `gh pr list` row. */
export function prState(p: J): PrState {
  const mergeable = s(p.mergeable).toUpperCase();
  const merge = s(p.mergeStateStatus).toUpperCase();
  if (mergeable === "CONFLICTING" || merge === "DIRTY") return "conflicts";
  if (merge === "BEHIND") return "behind";
  if (p.isDraft === true || merge === "DRAFT") return "draft";
  const c = checkBadge(p.statusCheckRollup);
  if (c.pending) return "checks running";
  if (c.failing.length) return "failing";
  if (merge === "BLOCKED") return "blocked";
  if (mergeable !== "MERGEABLE" || merge === "UNKNOWN") return "checking";
  return "ready";
}

/** The one action a state offers; none while checks run, for a draft, a red or blocked PR. */
export function prAction(state: PrState): PrAction | null {
  if (state === "conflicts") return "resolve";
  if (state === "behind") return "update-branch";
  if (state === "ready") return "merge";
  return null;
}

/** "needs action": something the operator can do from the row, or a red PR to look at. */
export const needsAction = (state: PrState) => prAction(state) !== null || state === "failing";

/** The chip tone of a state. */
export function stateTone(state: PrState): "done" | "failed" | "gate" | "" {
  if (state === "ready") return "done";
  if (state === "conflicts" || state === "failing") return "failed";
  if (state === "behind" || state === "blocked") return "gate";
  return "";
}

export interface PrFilter {
  /** An author login, or "" for every author. */
  author: string;
  who: "all" | "bot" | "human";
  needsAction: boolean;
}

export const NO_FILTER: PrFilter = { author: "", who: "all", needsAction: false };

export function filterPrs(prs: J[], f: PrFilter): J[] {
  return prs.filter((p) => {
    if (f.author && s(((p.author ?? {}) as J).login) !== f.author) return false;
    if (f.who !== "all" && isBot(p.author) !== (f.who === "bot")) return false;
    return !f.needsAction || needsAction(prState(p));
  });
}

/** The authors of a list, for the Author filter (sorted, each once). */
export function authors(prs: J[]): string[] {
  return [...new Set(prs.map((p) => s(((p.author ?? {}) as J).login)).filter(Boolean))].sort();
}

/** Which of the selected PRs a bulk action applies to (ADR amend 2026-11-08 point 1: update
 *  branch and close only; one host request per PR, one after another). */
export function bulkTargets(prs: J[], selected: Set<number>, action: "update-branch" | "close-pr"): number[] {
  return prs
    .filter((p) => selected.has(Number(p.number)))
    .filter((p) => action === "close-pr" || prState(p) === "behind")
    .map((p) => Number(p.number));
}

/** What `forge_pr_worktree` (src-tauri/src/prworktree.rs) prepared for Resolve. */
export interface PrWorktree {
  number: number;
  path: string;
  branch: string | null;
  base: string;
  reused: boolean;
  conflicted: string[];
  /** agent-kit as Colony runs it: program, then its arguments (empty: no engine). */
  kit: string[];
  note: string;
}

/**
 * The Resolve terminal (operator answer `forge-ux-resolve-before-x7`): in the PR's worktree,
 * list the conflicts and run `agent-kit conflicts propose` per conflicted file, then leave an
 * interactive shell there. Every value reaches sh as a positional argument ($1 the worktree,
 * then the kit argv), never inside the script text.
 */
export const RESOLVE_SCRIPT = [
  'cd "$1" || exit 1',
  "shift",
  "set -f",
  "printf '\\nColony Resolve: %s\\n' \"$(pwd)\"",
  "git status --short --branch | head -n 40",
  "IFS='\n'",
  "files=$(git diff --name-only --diff-filter=U)",
  'if [ -z "$files" ]; then echo "No conflicted files: review the merge, then commit and push.";',
  'elif [ "$#" -gt 0 ]; then "$@" conflicts; for f in $files; do printf \'\\n== agent-kit conflicts propose %s\\n\' "$f"; "$@" conflicts propose "$f"; done;',
  'else echo "No agent-kit engine: resolve by hand (git diff), then git add and git commit."; fi',
  "unset IFS",
  "printf '\\nNext: apply the proposals you accept, git add <file>, git commit, then git push (a same-repo PR branch pushes back to the PR).\\n'",
  'exec "${SHELL:-/bin/sh}" -i',
].join("\n");

export function resolveArgv(w: PrWorktree): string[] {
  return ["sh", "-c", RESOLVE_SCRIPT, "colony-resolve", w.path, ...w.kit];
}
