// Mission Control host actions. The embedded panel only ever emits copy records
// `{kind:"copy", text, subject, destination}` (kit docs/mission-control-embedding.md)
// and every string in them is untrusted repo or agent text. Colony turns exactly three
// shapes into real host actions and leaves everything else (terminal commands, PIDs,
// /run-plan-all, /git-prod, /kit-prod, prompts) as the clipboard copy:
//   - destination "filePicker" + a plain repo-relative path -> open it in a Colony tab
//     (the Rust side still jails it to the opened folder);
//   - destination "chatInput" + exactly "/run-plan" or "/run-plan <plan basename>" ->
//     start an Agent run of the folder's active plan, after a native confirmation;
//   - destination "terminal" + exactly "gh run rerun <run-id> --failed" (the Ship lane's
//     Tag CI row) -> a `rerun-checks` approval card (src-tauri/src/hostreq.rs); the id is
//     the only value taken from the text, and nothing runs before Approve.

export interface McRecord { kind: string; text: string; subject: string; destination: string }

export type McDecision =
  | { action: "open-file"; path: string }
  | { action: "run-plan"; plan: string | null }
  | { action: "rerun-run"; run: number }
  | { action: "copy"; reason: string };

const RUN_PLAN = /^\/run-plan(?:[ \t]+([A-Za-z0-9][A-Za-z0-9._-]{0,200}))?$/;
const RERUN_RUN = /^gh run rerun ([1-9][0-9]{0,15}) --failed$/;

/** A relative path inside the repo: no absolute, home, parent or control segments. */
export function isSafeRepoPath(p: string): boolean {
  if (!p || p.length > 1024 || p !== p.trim()) return false;
  if (p.startsWith("/") || p.startsWith("~") || p.includes("\\")) return false;
  // biome-ignore lint: control characters are exactly what this rejects
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

export function decide(r: McRecord | null | undefined): McDecision {
  if (!r || r.kind !== "copy" || typeof r.text !== "string") return { action: "copy", reason: "not a copy record" };
  if (r.destination === "filePicker") {
    return isSafeRepoPath(r.text) ? { action: "open-file", path: r.text } : { action: "copy", reason: "not a plain repo path" };
  }
  if (r.destination === "chatInput") {
    const m = RUN_PLAN.exec(r.text);
    if (m) return { action: "run-plan", plan: m[1] ?? null };
    return { action: "copy", reason: "chat prompt (paste it in your agent)" };
  }
  if (r.destination === "terminal") {
    const m = RERUN_RUN.exec(r.text);
    const run = m ? Number(m[1]) : 0;
    if (Number.isSafeInteger(run) && run > 0) return { action: "rerun-run", run };
  }
  return { action: "copy", reason: `${r.destination || "unknown"} destination stays copy` };
}
