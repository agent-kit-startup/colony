// Run with context (kit ADR 2026-10-22 commands-catalog contract, amend 2026-11-16, Accepted
// 2026-11-20): a kit command launches as `/name` plus the context its catalog row declares
// (`context`: none, goal, plan, branch, pr, sha). Pure: Node runs it with its types stripped.
// Rust (vendor.rs `valid_prompt_in`) is the gate; these checks mirror it so a value Rust would
// refuse gets a status line at the click instead of a silent refusal after it.
//  - goal: free text, newlines allowed, no NUL / other control character / bidi or zero-width
//    mark, at most 4096 UTF-8 bytes (vendor.rs `valid_context`, `MAX_CONTEXT`).
//  - plan, branch, pr, sha (and a project row's argument): one plain token (`valid_token`).
//  - An empty value launches the bare `/name`: the command then asks for what it needs.
// Native confirm (decision 3, "Só em produção"): only `/git-prod` and `/kit-prod`, whoever
// calls, plus project-layer rows (agent-inferred in c4: repository text defines what those
// run, so the click on a row the folder added shows what it is before it starts).

export type LaunchContext = "none" | "goal" | "plan" | "branch" | "pr" | "sha";

/** Interactive only, behind the native confirm; the session's own gate is the yes. */
export const PROD_ONLY: readonly string[] = ["git-prod", "kit-prod"];

/** vendor.rs `GOAL_CONTEXT`: the compiled goal commands (used when the catalog is unavailable). */
export const GOAL_COMMANDS: readonly string[] = ["backlog-add", "dogfood", "hotfix", "qa", "start-project"];

export const MAX_GOAL = 4096;
const MAX_TOKEN = 240;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Cc (control) except newline, and the bidi / zero-width marks vendor.rs `invisible` names.
const BAD_GOAL_CHAR = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;
const TOKEN = /^[A-Za-z0-9._:/-]+$/;

const CONTEXTS: readonly string[] = ["none", "goal", "plan", "branch", "pr", "sha"];

/** A catalog `context` value, `none` for anything else (an older catalog has no field). */
export function contextOf(v: unknown): LaunchContext {
  return typeof v === "string" && CONTEXTS.includes(v) ? (v as LaunchContext) : "none";
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** vendor.rs `valid_context`, or the reason it fails. */
export function goalError(goal: string): string {
  if (!goal.trim()) return "the goal is empty";
  if (bytes(goal) > MAX_GOAL) return `the goal is longer than ${MAX_GOAL} bytes`;
  if (BAD_GOAL_CHAR.test(goal)) return "the goal has a control or invisible character";
  return "";
}

/** vendor.rs `valid_token`, or the reason it fails. */
export function tokenError(t: string): string {
  if (!t) return "the value is empty";
  if (bytes(t) > MAX_TOKEN) return `the value is longer than ${MAX_TOKEN} bytes`;
  if (t.startsWith("-")) return "the value starts with -";
  if (t.split("/").some((s) => s === "..")) return "the value has a .. segment";
  if (!TOKEN.test(t)) return "the value must be one word of letters, digits and . _ : / -";
  return "";
}

export type Composed = { prompt: string } | { error: string };

/** The first prompt for `/name` with `value` as its `context`. Goals keep inner newlines;
 *  surrounding blanks are trimmed. A project row (`project`) takes one token whatever it declares. */
export function composePrompt(name: string, context: LaunchContext, value: string, project = false): Composed {
  if (!NAME.test(name)) return { error: `/${name} is not a command name` };
  const v = value.trim();
  if (!v || context === "none") return { prompt: `/${name}` };
  const err = context === "goal" && !project ? goalError(v) : tokenError(v);
  return err ? { error: `/${name}: ${err}` } : { prompt: `/${name} ${v}` };
}

/** The slash name of a prompt (`/name ...` → `name`). */
export function promptName(prompt: string): string {
  return prompt.replace(/^\//, "").split(/\s/, 1)[0] ?? "";
}

/** Whether a launch shows the native confirm first: production always, project rows too. */
export function needsConfirm(prompt: string, project = false): boolean {
  return PROD_ONLY.includes(promptName(prompt)) || project;
}

/** The composer's label for a context ("" = no composer, launch on the click). */
export function contextLabel(name: string, context: LaunchContext): string {
  switch (context) {
    case "goal":
      return `/${name}: what is it about? (Enter launches; empty = the command asks)`;
    case "plan":
      return `/${name}: which plan? (Enter launches; empty = the command asks)`;
    case "branch":
      return `/${name}: which branch? (Enter launches; empty = the command asks)`;
    case "pr":
      return `/${name}: which PR number? (Enter launches; empty = the command asks)`;
    case "sha":
      return `/${name}: which commit SHA? (Enter launches; empty = the command decides)`;
    default:
      return "";
  }
}
