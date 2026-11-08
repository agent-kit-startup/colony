// Explorer: lazy file tree of the opened workspace. Clicking a row selects it (the target
// folder of New file / New folder); names for a new item or a rename are typed inline.
// Each row carries its file-type glyph (src/fileicons.ts) and its git mark (src/gitmarks.ts),
// the mark refreshed in place without a re-render.
import { api, errText, h, type Entry } from "./api";
import { GLYPHS } from "./fileglyphs";
import { classFor, glyphFor } from "./fileicons";
import { buildMarkIndex, debounce, type MarkIndex } from "./gitmarks";

/** Right-click on a row (`path` set) or on the empty Explorer (`path` null: the root). */
export type TreeContext = { path: string | null; isDir: boolean; x: number; y: number };

const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

export class FileTree {
  private root = "";
  private expanded = new Set<string>();
  private active = "";
  private selected: { path: string; isDir: boolean } | null = null;
  /** The rendered children box and depth of each expanded folder (the root included). */
  private dirs = new Map<string, { box: HTMLElement; depth: number }>();
  /** A name is being typed: a refresh (git state moved, a drop) waits until it is done, so
   *  the field never vanishes under the typing. */
  private editing = false;
  private refreshWanted = false;
  /** The last git marks read (empty outside a repository). */
  private marks: MarkIndex = buildMarkIndex([]);
  private marksSeq = 0;
  /** One `git_marks` call per burst of refresh requests (focus, snapshot, save, git panel). */
  readonly refreshMarks = debounce(() => void this.loadMarks(), 400);

  constructor(
    private el: HTMLElement,
    private onOpen: (path: string) => void,
    private onError: (msg: string) => void,
    private onContext?: (ctx: TreeContext) => void,
  ) {
    el.addEventListener("contextmenu", (ev) => {
      // The inline name field keeps its own copy / paste menu.
      if (!this.onContext || !this.root || ev.defaultPrevented || (ev.target as HTMLElement).closest(".tree-input")) return;
      ev.preventDefault();
      this.onContext({ path: null, isDir: true, x: ev.clientX, y: ev.clientY });
    });
  }

  async setRoot(root: string) {
    this.root = root;
    this.expanded = new Set([root]);
    this.selected = null;
    await this.refresh();
  }

  async refresh() {
    if (!this.root) return;
    if (this.editing) {
      this.refreshWanted = true;
      return;
    }
    this.dirs.clear();
    const list = await this.renderDir(this.root, 0);
    this.el.replaceChildren(list);
    this.refreshMarks();
  }

  /** Read the marks (one git status call for the whole repository) and paint every row. */
  private async loadMarks() {
    if (!this.root) return;
    const seq = ++this.marksSeq;
    let next: MarkIndex;
    try {
      const r = await api.gitMarks();
      next = buildMarkIndex(r.isRepo ? r.marks : []);
    } catch {
      next = buildMarkIndex([]); // no git, or git failed: no marks, never an error dialog
    }
    if (seq !== this.marksSeq) return; // a newer read is on its way
    this.marks = next;
    for (const row of this.el.querySelectorAll<HTMLElement>(".tree-row[data-path]")) this.paintMark(row);
  }

  /** The row's letter (coloured by its skin token in CSS), title and ignored dimming. */
  private paintMark(row: HTMLElement) {
    const path = row.dataset.path;
    if (!path) return;
    const m = this.marks.get(path, row.classList.contains("dir"));
    row.classList.toggle("git-ignored", m.ignored);
    let badge = row.querySelector<HTMLElement>(".git-mark");
    if (!m.letter) {
      badge?.remove();
      row.title = m.ignored ? `${path} (ignored)` : path;
      return;
    }
    if (!badge) {
      badge = h("span", { class: "git-mark", "aria-hidden": "true" });
      row.append(badge);
    }
    badge.textContent = m.letter;
    badge.dataset.mark = m.letter;
    row.title = `${path} (${m.title})`;
  }

  setActive(path: string) {
    this.active = path;
    for (const row of this.el.querySelectorAll<HTMLElement>(".tree-row")) {
      row.classList.toggle("active", row.dataset.path === path);
    }
  }

  /** The folder New file / New folder create in: the selected folder, the selected file's
   *  folder, else the workspace root. */
  targetDir(): string {
    if (!this.selected || !this.selected.path.startsWith(`${this.root}/`)) return this.root;
    return this.selected.isDir ? this.selected.path : parentOf(this.selected.path);
  }

  private select(path: string | null, isDir = false) {
    this.selected = path ? { path, isDir } : null;
    for (const row of this.el.querySelectorAll<HTMLElement>(".tree-row")) {
      row.classList.toggle("selected", row.dataset.path === path);
    }
  }

  /** Expand `path`'s folders down from the root, re-render and select it. */
  async reveal(path: string, isDir: boolean) {
    for (let d = isDir ? path : parentOf(path); d.startsWith(this.root) && d !== this.root; d = parentOf(d)) this.expanded.add(d);
    await this.refresh();
    this.select(path, isDir);
  }

  /** Type a new item's name in a row at the top of `dir` (expanded first): the trimmed name on
   *  Enter, null on Escape, an empty name or when the field loses focus. */
  async askName(dir: string, kind: "file" | "folder"): Promise<string | null> {
    if (dir !== this.root || !this.dirs.has(dir)) await this.reveal(dir, true);
    const d = this.dirs.get(dir);
    if (!d) return null;
    const input = h("input", { class: "tree-input", spellcheck: "false", autocomplete: "off", "aria-label": kind === "file" ? "New file name" : "New folder name", placeholder: kind === "file" ? "name.md" : "folder" }) as HTMLInputElement;
    const row = h("div", { class: `tree-row editing ${kind === "file" ? "file" : "dir"}` }, h("span", { class: "caret" }, kind === "folder" ? "▸" : ""), fileIcon("", kind === "folder"), input);
    row.style.paddingLeft = `${8 + d.depth * 12}px`;
    d.box.prepend(row);
    const name = await this.edit(() => typed(input, ""));
    row.remove();
    return name;
  }

  /** Type a new name for `path` in place of its row's label (same rules as askName). */
  async askRename(path: string): Promise<string | null> {
    const row = [...this.el.querySelectorAll<HTMLElement>(".tree-row")].find((r) => r.dataset.path === path);
    const label = row?.querySelector<HTMLElement>(".name");
    if (!row || !label) return null;
    const old = path.slice(path.lastIndexOf("/") + 1);
    const input = h("input", { class: "tree-input", spellcheck: "false", autocomplete: "off", "aria-label": `New name for ${old}` }) as HTMLInputElement;
    row.classList.add("editing");
    label.replaceWith(input);
    const dot = old.lastIndexOf(".");
    const name = await this.edit(() => typed(input, old, dot > 0 && !row.classList.contains("dir") ? dot : old.length));
    input.replaceWith(label);
    row.classList.remove("editing");
    return name;
  }

  private async edit(run: () => Promise<string | null>): Promise<string | null> {
    this.editing = true;
    try {
      return await run();
    } finally {
      this.editing = false;
      if (this.refreshWanted) {
        this.refreshWanted = false;
        void this.refresh();
      }
    }
  }

  private async renderDir(path: string, depth: number): Promise<HTMLElement> {
    const box = h("div", { class: "tree-children" });
    this.dirs.set(path, { box, depth });
    let entries: Entry[] = [];
    try {
      entries = await api.listDir(path);
    } catch (e) {
      this.onError(errText(e));
    }
    for (const entry of entries) {
      const row = h("div", { class: `tree-row ${entry.isDir ? "dir" : "file"}`, title: entry.path });
      row.dataset.path = entry.path;
      row.style.paddingLeft = `${8 + depth * 12}px`;
      const caret = h("span", { class: "caret" }, entry.isDir ? (this.expanded.has(entry.path) ? "▾" : "▸") : "");
      const glyph = fileIcon(entry.name, entry.isDir, entry.isDir && this.expanded.has(entry.path));
      row.append(caret, glyph, h("span", { class: "name" }, entry.name));
      this.paintMark(row);
      if (entry.path === this.active) row.classList.add("active");
      if (entry.path === this.selected?.path) row.classList.add("selected");
      row.addEventListener("contextmenu", (ev) => {
        if (!this.onContext || (ev.target as HTMLElement).closest(".tree-input")) return;
        ev.preventDefault();
        this.select(entry.path, entry.isDir);
        this.onContext({ path: entry.path, isDir: entry.isDir, x: ev.clientX, y: ev.clientY });
      });
      box.append(row);
      if (entry.isDir) {
        const kids = h("div", { class: "tree-sub" });
        box.append(kids);
        const load = async () => kids.replaceChildren(await this.renderDir(entry.path, depth + 1));
        if (this.expanded.has(entry.path)) await load();
        row.addEventListener("click", async () => {
          if (row.classList.contains("editing")) return;
          this.select(entry.path, true);
          if (this.expanded.has(entry.path)) {
            this.expanded.delete(entry.path);
            this.dirs.delete(entry.path);
            kids.replaceChildren();
            caret.textContent = "▸";
            setGlyph(glyph, "folder");
          } else {
            this.expanded.add(entry.path);
            caret.textContent = "▾";
            setGlyph(glyph, "folder-open");
            await load();
          }
        });
      } else {
        row.addEventListener("click", () => {
          if (row.classList.contains("editing")) return;
          this.select(entry.path, false);
          this.onOpen(entry.path);
        });
      }
    }
    return box;
  }
}

/** Resolve an inline name field: the trimmed value on Enter (null when empty), null on
 *  Escape or blur. `selEnd`: the end of the initial selection (a rename keeps the extension). */
function typed(input: HTMLInputElement, value: string, selEnd = value.length): Promise<string | null> {
  input.value = value;
  input.focus();
  input.setSelectionRange(0, selEnd);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      resolve(v?.trim() || null);
    };
    input.addEventListener("click", (ev) => ev.stopPropagation());
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") {
        ev.preventDefault();
        finish(input.value);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        finish(null);
      }
    });
    // A native menu (File → New file) or the closing context menu can take focus back just
    // after the field opened: refocus then, and only cancel on a later blur.
    const opened = performance.now();
    input.addEventListener("blur", () =>
      setTimeout(() => {
        if (done || document.activeElement === input) return;
        if (performance.now() - opened < 600) input.focus();
        else finish(null);
      }, 100),
    );
  });
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** A row's 16px file-type glyph, coloured by its class in CSS (`.file-icon[data-class]`). Built
 *  from the bundled path data with createElementNS: no markup string is parsed, and the file
 *  name only picks a table entry. */
function fileIcon(name: string, isDir: boolean, expanded = false): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "file-icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "currentColor");
  setGlyph(svg, glyphFor(name, isDir, expanded));
  return svg;
}

/** Swap an icon's glyph in place (a folder opening or closing). */
function setGlyph(svg: SVGSVGElement, id: string) {
  const g = GLYPHS[id] ?? GLYPHS.file;
  svg.setAttribute("viewBox", g.vb);
  svg.dataset.glyph = id;
  svg.dataset.class = classFor(id);
  svg.replaceChildren(
    ...g.d.map((p) => {
      const el = document.createElementNS(SVG_NS, "path");
      el.setAttribute("d", typeof p === "string" ? p : p[0]);
      if (typeof p !== "string") el.setAttribute("opacity", String(p[1]));
      return el;
    }),
  );
}
