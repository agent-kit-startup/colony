// Review: per-tick diffs of every agent run in this window. Each tick is the working
// tree change between the previous tick end (or the run start) and its own end
// (src-tauri/src/review.rs); a file opens in a Monaco diff editor.
import * as monaco from "monaco-editor";
import { api, errText, h, type FileChange, type TickReview } from "./api";
import { runLabel, runs } from "./runs";

const STATUS_NAMES: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type changed" };

export class ReviewView {
  private list = h("div", { class: "rv-list" });
  private head = h("div", { class: "rv-head dim" }, "Pick a file of a tick to see its diff.");
  private diffHost = h("div", { class: "rv-diff" });
  private diff: monaco.editor.IStandaloneDiffEditor | null = null;
  private selected: { runId: number; tick: number; path: string } | null = null;
  private expanded = new Set<string>();

  constructor(
    root: HTMLElement,
    private onCount: (n: number) => void,
    private openFile: (absPath: string) => void,
    private status: (msg: string) => void,
  ) {
    root.append(h("div", { class: "rv-side" }, h("div", { class: "side-head" }, h("span", {}, "Ticks")), this.list), h("div", { class: "rv-main" }, this.head, this.diffHost));
    runs.on((c) => {
      if (c.kind === "review") {
        this.expanded.add(key(c.review));
        this.render();
      } else if (c.kind === "state") this.render();
    });
    this.render();
  }

  private all(): TickReview[] {
    return runs
      .list()
      .flatMap((r) => r.reviews)
      .sort((a, b) => b.at.localeCompare(a.at) || b.tick - a.tick);
  }

  count() {
    return this.all().length;
  }

  render() {
    const ticks = this.all();
    this.onCount(ticks.length);
    if (!ticks.length) {
      this.list.replaceChildren(h("div", { class: "dim rv-empty" }, "No ticks yet. Each tick of an Agent run shows up here with the files it changed."));
      return;
    }
    this.list.replaceChildren(...ticks.map((t) => this.tickRow(t)));
  }

  private tickRow(t: TickReview): HTMLElement {
    const run = runs.runs.get(t.runId);
    const k = key(t);
    const open = this.expanded.has(k);
    const title = h(
      "div",
      { class: "rv-tick", title: t.resultLine ?? "" },
      h("span", { class: "caret" }, open ? "▾" : "▸"),
      h("strong", {}, `tick ${t.tick}`),
      h("span", { class: "dim" }, ` ${run ? runLabel(run) : `#${t.runId}`}${run && run.backend === t.backend ? "" : ` · ${t.backend}`}`),
      h("span", { class: "rv-count" }, `${t.files.length}`),
    );
    const box = h("div", { class: "rv-group" }, title);
    if (open) {
      const meta: string[] = [];
      if (!t.finished) meta.push("did not finish");
      if (t.resultLine) meta.push(t.resultLine);
      if (t.headBefore !== t.headAfter) meta.push(`commits: ${short(t.headBefore)} → ${short(t.headAfter)}`);
      if (meta.length) box.append(h("div", { class: "rv-meta" }, meta.join(" · ")));
      const copy = h("button", { class: "rv-copy", title: "Copy this tick's unified patch" }, "Copy patch");
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(await api.reviewPatch(t.runId, t.tick));
          this.status(`Copied the patch of tick ${t.tick}`);
        } catch (e) {
          this.status(`Copy patch: ${errText(e)}`);
        }
      });
      if (t.files.length) box.append(...t.files.map((f) => this.fileRow(t, f)), copy);
      else box.append(h("div", { class: "rv-meta" }, "No working tree change."));
    }
    title.addEventListener("click", () => {
      if (this.expanded.has(k)) this.expanded.delete(k);
      else this.expanded.add(k);
      this.render();
    });
    return box;
  }

  private fileRow(t: TickReview, f: FileChange): HTMLElement {
    const sel = this.selected && this.selected.runId === t.runId && this.selected.tick === t.tick && this.selected.path === f.path;
    const row = h(
      "div",
      { class: `rv-file ${sel ? "sel" : ""}`, title: `${f.path}\n${STATUS_NAMES[f.status] ?? f.status}${f.oldPath ? ` from ${f.oldPath}` : ""}` },
      h("code", { class: `st st-${f.status}` }, f.status),
      h("span", { class: "ellipsis" }, f.path),
    );
    row.dataset.path = f.path;
    row.addEventListener("click", () => void this.show(t, f));
    return row;
  }

  /** Show one file of one tick in the diff editor (also used by the smoke). */
  async show(t: TickReview, f: FileChange): Promise<{ before: string | null; after: string | null }> {
    this.selected = { runId: t.runId, tick: t.tick, path: f.path };
    this.render();
    const v = await api.reviewFile(t.runId, t.tick, f.path, f.oldPath);
    const abs = `${t.toplevel}/${f.path}`;
    const openBtn = h("button", { title: "Open the current file in the editor" }, "Open file");
    openBtn.addEventListener("click", () => this.openFile(abs));
    this.head.className = "rv-head";
    this.head.replaceChildren(
      h("strong", {}, f.path),
      h("span", { class: "dim" }, ` · tick ${t.tick} · ${STATUS_NAMES[f.status] ?? f.status}${v.note ? ` · ${v.note}` : ""}`),
      h("span", { class: "spacer" }),
      ...(f.status === "D" ? [] : [openBtn]),
    );
    if (!this.diff) {
      this.diff = monaco.editor.createDiffEditor(this.diffHost, {
        theme: "colony-dark",
        automaticLayout: true,
        readOnly: true,
        originalEditable: false,
        renderSideBySide: true,
        fontSize: 13,
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mc-font-mono"),
      });
    }
    const old = this.diff.getModel();
    const lang = languageFor(f.path);
    const original = monaco.editor.createModel(v.before ?? "", lang);
    const modified = monaco.editor.createModel(v.after ?? "", lang);
    this.diff.setModel({ original, modified });
    old?.original.dispose();
    old?.modified.dispose();
    return v;
  }

  layout() {
    this.diff?.layout();
  }
}

function languageFor(path: string): string {
  const base = path.split("/").pop() ?? path;
  const ext = base.includes(".") ? `.${base.split(".").pop()}` : "";
  for (const l of monaco.languages.getLanguages()) {
    if (l.filenames?.includes(base) || (ext && l.extensions?.includes(ext))) return l.id;
  }
  return "plaintext";
}

function key(t: TickReview) {
  return `${t.runId}:${t.tick}`;
}

function short(sha: string | null) {
  return sha ? sha.slice(0, 7) : "none";
}
