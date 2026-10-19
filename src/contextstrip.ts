// "Context sources" strip of an agent tab (driver run, interactive vendor CLI, queue
// runner): the instruction and memory files that agent loads for its working folder
// (src-tauri/src/context.rs), with existence, size and line count. Claude Code keys its
// auto-memory by the start folder, so this is where a run started in the wrong folder, or
// a memory index about other projects, becomes visible. A row opens the file in the
// operator's editor. Read-only: Colony never edits these files from here.
import { api, type ContextReport, type ContextSource, errText, h } from "./api";

function size(n: number | null): string {
  if (n === null) return "";
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
}

function home(path: string): string {
  const m = /^\/home\/[^/]+|^\/root/.exec(path);
  return m ? `~${path.slice(m[0].length)}` : path;
}

function detail(s: ContextSource): string {
  if (!s.exists) return s.kind === "memory" ? "none for this folder" : "missing";
  const parts = [s.lines !== null ? `${s.lines} line${s.lines === 1 ? "" : "s"}` : "", size(s.bytes)];
  if (s.files !== null) parts.push(`${s.files} ${s.kind === "rules" ? "rule" : "memory"} file${s.files === 1 ? "" : "s"}`);
  return parts.filter(Boolean).join(" · ");
}

export class ContextStrip {
  readonly el: HTMLDetailsElement;
  private summary = h("summary", {});
  private body = h("div", { class: "ctx-body" });
  report: ContextReport | null = null;
  /** Resolves when the first listing arrived (or failed). */
  readonly ready: Promise<void>;

  constructor(
    readonly cwd: string,
    readonly engine: string,
    private open: (path: string) => void,
  ) {
    this.el = h("details", { class: "ctx-strip" }, this.summary, this.body);
    this.el.dataset.cwd = cwd;
    this.el.dataset.engine = engine;
    this.summary.textContent = `Context sources · ${engine} · loading…`;
    this.ready = this.refresh();
  }

  async refresh() {
    try {
      this.report = await api.contextSources(this.cwd, this.engine);
    } catch (e) {
      this.summary.textContent = `Context sources · ${errText(e)}`;
      return;
    }
    this.render(this.report);
  }

  private render(r: ContextReport) {
    const found = r.sources.filter((s) => s.exists);
    const lines = found.reduce((n, s) => n + (s.kind === "rules" ? 0 : (s.lines ?? 0)), 0);
    const mem = r.sources.find((s) => s.kind === "memory");
    const memNote = mem ? (mem.exists ? ` · memory ${mem.lines ?? "?"} lines${mem.files !== null ? ` + ${mem.files} files` : ""}` : " · no project memory") : "";
    this.summary.replaceChildren(
      h("span", { class: "ctx-title" }, "Context sources"),
      h("span", { class: "ctx-meta" }, `\u00a0· ${r.family} · ${found.length} of ${r.sources.length} found · ${lines} lines${memNote} · ${home(r.cwd)}`),
    );
    const rows = r.sources.map((s) => {
      const row = h(
        "div",
        { class: `ctx-row ${s.exists ? "click" : "missing"}`, title: `${s.path}\n${s.note}` },
        h("span", { class: `chip ${s.exists ? "chip-done" : ""}` }, s.exists ? "✓" : "–"),
        h("span", { class: "ctx-label" }, s.label),
        h("span", { class: "ctx-path mono ellipsis grow" }, home(s.path)),
        h("span", { class: "ctx-detail" }, detail(s)),
      );
      row.dataset.path = s.path;
      row.dataset.kind = s.kind;
      row.dataset.exists = String(s.exists);
      if (s.exists && s.kind !== "rules") row.addEventListener("click", () => this.open(s.path));
      return row;
    });
    const again = h("button", { class: "link", title: "List the files again" }, "Refresh");
    again.addEventListener("click", () => void this.refresh());
    const why =
      r.family === "claude"
        ? `Claude Code loads ~/.claude/CLAUDE.md, CLAUDE.md files from this folder up to your home folder, and the auto-memory of ~/.claude/projects/${r.slug ?? "<folder>"} (keyed by the start folder). Click a file to open it in your editor.`
        : r.family === "codex"
          ? "Codex loads ~/.codex/AGENTS.md and AGENTS.md files from the repository root down to this folder. Click a file to open it in your editor."
          : "Cursor's agent loads AGENTS.md, CLAUDE.md and .cursor/rules of this folder. Click a file to open it in your editor.";
    this.body.replaceChildren(...rows, h("div", { class: "hint ctx-why" }, why, " ", again));
  }
}
