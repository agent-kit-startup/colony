// Conflict window model (plan colony-explorer-git-workbench x7). Pure: the kit's listing in,
// the resolved file text out. No DOM, so node --test runs it (scripts/conflictmerge.test.mjs).
//
// The hunks come from `agent-kit conflicts --json` (kit packages/cli/src/conflicts): each has
// the 1-based lines of its opening and closing markers in the working file and the ours /
// base / theirs text with line endings kept. Colony splices the operator's choice for each
// hunk between those lines; every byte outside the hunks stays as it is.

export interface ConflictHunk {
  index: number;
  startLine: number;
  endLine: number;
  ours: string;
  base: string | null;
  theirs: string;
  oursLabel: string;
  baseLabel: string | null;
  theirsLabel: string;
  contextBefore?: string;
  contextAfter?: string;
}

export interface ConflictFile {
  path: string;
  xy: string;
  kind: "text" | "deleted" | "binary" | "unparsable";
  baseSource: "markers" | "index" | "none" | null;
  hunks: ConflictHunk[];
  reason?: string;
}

export interface ConflictSide {
  ref: string;
  sha: string;
  subject: string;
  message: string;
}

export interface ConflictsListing {
  schema: number;
  root: string;
  operation: string | null;
  ours: ConflictSide | null;
  theirs: ConflictSide | null;
  files: ConflictFile[];
}

export interface Proposal {
  hunk: number;
  status: "accepted" | "refused";
  text: string;
  rationale: string;
  reason?: string;
}

export interface ProposeResult {
  schema: number;
  path: string;
  backend: string;
  proposals: Proposal[];
  unresolvedHunks: number[];
  resolvedText: string | null;
  verification: { status: "passed" | "failed" | "skipped" | "not-run"; reason?: string; commands: { command: string; exitCode: number; tail: string }[]; notes: string[] };
  replyRefused?: string;
}

/** How the operator resolved one hunk. `text` is what goes into the file. */
export type ChoiceKind = "ours" | "theirs" | "both" | "proposal" | "manual";
export interface Choice {
  kind: ChoiceKind;
  text: string;
}

/** Lines with their line endings (the kit's splitLinesKeep). */
export function splitLinesKeep(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** The text a pick puts into the file. `both` is ours then theirs, with a line break kept between. */
export function pick(h: ConflictHunk, kind: "ours" | "theirs" | "both"): string {
  if (kind === "ours") return h.ours;
  if (kind === "theirs") return h.theirs;
  if (!h.ours || /\n$/.test(h.ours) || !h.theirs) return h.ours + h.theirs;
  return `${h.ours}${h.ours.includes("\r\n") ? "\r\n" : "\n"}${h.theirs}`;
}

/** A conflict-marker line as git writes it (size 7), the same rule as the kit's parser. */
export function isMarkerLine(line: string): boolean {
  const l = line.replace(/\r?\n$/, "").replace(/\r$/, "");
  for (const m of ["<<<<<<<", "|||||||", ">>>>>>>"]) {
    if (l.startsWith(m)) {
      const rest = l.slice(7);
      if (rest === "" || rest.startsWith(" ")) return true;
    }
  }
  return l.startsWith("=======") && l.slice(7).trim() === "";
}

export function hasMarkers(text: string): boolean {
  return splitLinesKeep(text).some(isMarkerLine);
}

/**
 * The working file with each chosen hunk spliced in place of its marker block. Hunks without
 * a choice keep their markers. Throws when the file no longer has the listed markers at the
 * listed lines (edited since the listing: reload).
 */
export function applyChoices(text: string, hunks: readonly ConflictHunk[], choices: ReadonlyMap<number, Choice>): string {
  const lines = splitLinesKeep(text);
  for (const h of hunks) {
    const open = lines[h.startLine - 1] ?? "";
    const close = lines[h.endLine - 1] ?? "";
    if (!open.startsWith("<<<<<<<") || !close.startsWith(">>>>>>>") || h.endLine < h.startLine) {
      throw new Error(`Hunk ${h.index} is not at lines ${h.startLine}-${h.endLine} any more: the file changed, reload the conflicts`);
    }
  }
  const sorted = [...hunks].sort((a, b) => b.startLine - a.startLine);
  for (const h of sorted) {
    const c = choices.get(h.index);
    if (!c) continue;
    lines.splice(h.startLine - 1, h.endLine - h.startLine + 1, c.text);
  }
  return lines.join("");
}

/** Hunks still without a choice, in file order. */
export function unresolved(hunks: readonly ConflictHunk[], choices: ReadonlyMap<number, Choice>): number[] {
  return hunks.filter((h) => !choices.has(h.index)).map((h) => h.index);
}

/** Unmerged XY codes of `git status` (porcelain v1 and v2). */
export const UNMERGED_XY = new Set(["UU", "AA", "DD", "AU", "UA", "DU", "UD"]);
