// Rendered preview of a plan or HANDOFF file (an editor tab in Preview mode; the Editor mode
// is Monaco). A plan's frontmatter to-dos show as a status table, from the to-dos the
// Mission Control snapshot already parsed; the frontmatter itself stays raw text in a
// collapsed block (never rendered as markdown). The body goes through the transcript
// renderer (./transcript.ts over ./markdown.ts): DOM built with h() only, so the file's
// text never becomes markup.
import { h } from "./api";
import { splitFrontmatter } from "./markdown";
import { inlineMd, type MdLinkHandler, plainMd, prose } from "./transcript";

export interface DocTodo {
  id: string;
  content: string;
  status: string;
}

const STATUS_LABEL: Record<string, string> = { completed: "done", in_progress: "in progress", pending: "pending", cancelled: "cancelled", blocked: "blocked" };

function todoTable(todos: DocTodo[], onLink: MdLinkHandler): HTMLElement {
  const done = todos.filter((t) => t.status === "completed").length;
  return h(
    "section",
    { class: "md-todos" },
    h("div", { class: "md-todos-head" }, h("strong", {}, "To-dos"), h("span", { class: "dim" }, `${done} of ${todos.length} completed`)),
    h(
      "div",
      { class: "md-table-wrap" },
      h(
        "table",
        { class: "md-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Status"), h("th", {}, "To-do"), h("th", {}, "Content"))),
        h(
          "tbody",
          {},
          ...todos.map((t) =>
            h(
              "tr",
              { class: `todo-${t.status.replace(/[^a-z_]/g, "") || "unknown"}` },
              h("td", {}, h("span", { class: `md-status st-${t.status.replace(/[^a-z_]/g, "") || "unknown"}` }, STATUS_LABEL[t.status] ?? (t.status || "unknown"))),
              h("td", {}, h("code", {}, t.id)),
              h("td", {}, h("div", { class: "md-todo-content", title: plainMd(t.content) }, ...inlineMd(t.content, onLink))),
            ),
          ),
        ),
      ),
    ),
  );
}

/** The preview of `text`. `todos`: the plan's to-dos from the snapshot (null: not a known plan). */
export function renderDoc(text: string, todos: DocTodo[] | null, onLink: MdLinkHandler): HTMLElement {
  const { front, body } = splitFrontmatter(text);
  const head: HTMLElement[] = [];
  if (todos?.length) head.push(todoTable(todos, onLink));
  // The raw frontmatter (name, overview, to-do details) stays one click away.
  if (front !== null) head.push(h("details", { class: "md-front" }, h("summary", {}, "Frontmatter"), h("pre", {}, front)));
  return h("article", { class: "md-doc" }, ...head, prose(body, { doc: true, onLink }));
}
