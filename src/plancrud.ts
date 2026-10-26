// The plan CRUD dropdown (Mission card, Plans view rows): which kit command a plan offers
// (kit ADR 2026-10-24 amend 2026-10-26 point 5; Ask colony-plan-crud-delete = Edit, Archive,
// Cancel, Delete). Read is the Open button (the rendered preview). Every action only starts
// the interactive agent with `/<command> <file>` (host.interactive): the kit command asks its
// own confirmation there and Colony never answers it. The active plan offers Edit only: the
// three remove commands stop on it. Pure (no imports): Node runs it in `pnpm test`.

export interface PlanAction {
  id: "edit" | "archive" | "cancel" | "delete";
  label: string;
  /** One allowlisted kit command and the plan file (src-tauri vendor.rs PROMPT_SLASH). */
  prompt: string;
  /** Shown in the confirmation before the agent opens. */
  why: string;
  title: string;
}

/** The one plain token valid_prompt (vendor.rs) accepts as the argument. */
const PLAIN = /^[A-Za-z0-9._:/-]{1,240}$/;

export function planActions(file: string, lifecycle: string, active: boolean): PlanAction[] {
  if (!PLAIN.test(file) || file.startsWith("-") || file.split("/").includes("..")) return [];
  const edit: PlanAction = {
    id: "edit",
    label: "Edit…",
    prompt: `/backlog-edit ${file}`,
    why:
      lifecycle === "backlog"
        ? `/backlog-edit changes the to-dos, overview or phases of ${file} without activating it, and asks before it writes.`
        : `/backlog-edit changes the to-dos, overview or phases of ${file} without activating it. ${file} is not a backlog plan: the command warns once and asks before it edits it.`,
    title: "/backlog-edit in your agent, interactively: change to-dos, overview or phases without activating the plan",
  };
  if (active) return [edit];
  const out = [edit];
  if (lifecycle === "parked")
    out.push({
      id: "archive",
      label: "Archive…",
      prompt: `/archive-plan ${file}`,
      why: `/archive-plan drops ${file} from the HANDOFF parked list and moves the file to .cursor/plans/archive/. It asks before it changes anything.`,
      title: "/archive-plan in your agent: off the parked list, file moved to .cursor/plans/archive/",
    });
  if (lifecycle === "backlog")
    out.push(
      {
        id: "cancel",
        label: "Cancel…",
        prompt: `/backlog-cancel ${file}`,
        why: `/backlog-cancel marks the open to-dos of ${file} cancelled and drops it from the HANDOFF Backlog; the file stays in .cursor/plans/. It asks before it changes anything.`,
        title: "/backlog-cancel in your agent: off the backlog, open to-dos cancelled, the file kept",
      },
      {
        id: "delete",
        label: "Delete…",
        prompt: `/backlog-delete ${file}`,
        why: `/backlog-delete drops ${file} from the HANDOFF Backlog and moves the file to .cursor/plans/archive/. It asks before it changes anything.`,
        title: "/backlog-delete in your agent: off the backlog, file moved to .cursor/plans/archive/",
      },
    );
  return out;
}
