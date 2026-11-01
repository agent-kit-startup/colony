// Merge rules shared by the Git tab's two PR sources (pure, no imports, so scripts/*.test.mjs
// loads it): the snapshot's ship lane PRs (`head`, `base`, `mergeable: "conflicting"`,
// `checks.pending`) and the operator's own `gh pr list` rows (`headRefName`, `baseRefName`,
// `mergeable: "MERGEABLE"`, `statusCheckRollup`). Each caller normalizes to `PrFacts` first.

export type MergeMethod = "squash" | "merge";

export interface PrFacts {
  head: string;
  base: string;
  draft: boolean;
  /** The forge's mergeable word in any case: MERGEABLE, CONFLICTING, UNKNOWN. */
  mergeable: string;
  /** Checks still queued or running. */
  pendingChecks: number;
}

const PROMOTE_BASES = new Set(["main", "master"]);
/** The head of the staging fast-forward sync PR Colony opens (src-tauri/src/hostreq.rs pr_plan). */
const SYNC_HEAD = /^chore\/sync-staging-/;

export const isPromote = (head: string, base: string) => head === "staging" && PROMOTE_BASES.has(base);
export const isStagingSync = (head: string, base: string) => base === "staging" && SYNC_HEAD.test(head);

/**
 * The merge method a PR needs. A merge commit when the base must keep the head's own commits:
 * staging -> main (main stays an ancestor of staging) and the staging sync (a squash would put
 * a new commit on staging, so main would still not be an ancestor and the sync row never
 * clears). Squash for everything else.
 */
export function prMethod(head: string, base: string): MergeMethod {
  return isPromote(head, base) || isStagingSync(head, base) ? "merge" : "squash";
}

/** Why Colony offers no Merge for this PR right now, or null when it can be merged. */
export function mergeBlock(pr: PrFacts): string | null {
  if (pr.draft) return "draft";
  const m = pr.mergeable.toUpperCase();
  if (m === "CONFLICTING") return "conflicts";
  if (m !== "MERGEABLE") return "mergeability not known yet";
  if (pr.pendingChecks > 0) return "checks running";
  return null;
}
