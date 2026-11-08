// Explorer: lazy file tree of the opened workspace. Clicking a row selects it (the target
// folder of New file / New folder); names for a new item or a rename are typed inline.
// Keyboard, multi-select and the type-ahead filter follow src/treenav.ts while the tree has
// focus; the keys are a keydown handler on the tree, never menu accelerators.
// Each row carries its file-type glyph (src/fileicons.ts) and its git mark (src/gitmarks.ts),
// the mark refreshed in place without a re-render.
import { api, errText, h, type Entry } from "./api";
import { GLYPHS } from "./fileglyphs";
import { classFor, glyphFor } from "./fileicons";
import { buildMarkIndex, debounce, type MarkIndex } from "./gitmarks";
import { contextTargets, filterRows, firstMatch, navKey, type NavRow, outermost, selectTo } from "./treenav";

export type TreeItem = { path: string; isDir: boolean };

/** Right-click on a row (`path` set) or on the empty Explorer (`path` null: the root).
 *  `targets`: what Delete and Copy path act on (the selection when the row is in it). */
export type TreeContext = { path: string | null; isDir: boolean; x: number; y: number; targets: TreeItem[] };

/** What the tree's own keys hand back to the window (F2 and Delete). */
export type TreeKeys = { rename: (path: string, isDir: boolean) => void; trash: (items: TreeItem[]) => void };

const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

export class FileTree {
  private root = "";
  private expanded = new Set<string>();
  private active = "";
  /** Selected paths, the Shift anchor and the focused row (the keyboard cursor). */
  private selected = new Set<string>();
  private anchor: string | null = null;
  private focused: string | null = null;
  /** The type-ahead filter over the visible rows (Esc clears it). */
  private query = "";
  private filterEl = h("div", { class: "tree-filter", role: "status", "aria-live": "polite", hidden: "" });
  /** Expand or collapse a rendered folder row (the same path as a click). */
  private togglers = new Map<string, (open: boolean) => Promise<void>>();
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
    private keys?: TreeKeys,
  ) {
    el.tabIndex = 0;
    el.setAttribute("role", "tree");
    el.setAttribute("aria-multiselectable", "true");
    el.addEventListener("contextmenu", (ev) => {
      // The inline name field keeps its own copy / paste menu.
      if (!this.onContext || !this.root || ev.defaultPrevented || (ev.target as HTMLElement).closest(".tree-input")) return;
      ev.preventDefault();
      this.onContext({ path: null, isDir: true, x: ev.clientX, y: ev.clientY, targets: [] });
    });
    el.addEventListener("keydown", (ev) => void this.onKey(ev));
    el.addEventListener("focus", () => {
      if (!this.focused || !this.rowOf(this.focused)) this.setFocus(this.visibleRows()[0]?.dataset.path ?? null);
    });
  }

  async setRoot(root: string) {
    this.root = root;
    this.expanded = new Set([root]);
    this.selected = new Set();
    this.anchor = this.focused = null;
    this.query = "";
    await this.refresh();
  }

  async refresh() {
    if (!this.root) return;
    if (this.editing) {
      this.refreshWanted = true;
      return;
    }
    this.dirs.clear();
    this.togglers.clear();
    const list = await this.renderDir(this.root, 0);
    this.el.replaceChildren(this.filterEl, list);
    this.applyFilter();
    this.refreshMarks();
  }

  /** View → Collapse all folders: only the root stays open. */
  async collapseAll() {
    this.expanded = new Set([this.root]);
    await this.refresh();
  }

  /** View → Reveal active file: open its folders, select and focus it, scroll it into view. */
  async revealActive(): Promise<boolean> {
    if (!this.active.startsWith(`${this.root}/`)) return false;
    this.query = "";
    await this.reveal(this.active, false);
    this.rowOf(this.active)?.scrollIntoView({ block: "nearest" });
    return true;
  }

  /** The selected items in tree order (the focused row alone when nothing is selected). */
  selection(): TreeItem[] {
    return this.visibleRows()
      .filter((r) => this.selected.has(r.dataset.path ?? ""))
      .map((r) => ({ path: r.dataset.path ?? "", isDir: r.classList.contains("dir") }));
  }

  private rowOf(path: string): HTMLElement | undefined {
    return [...this.el.querySelectorAll<HTMLElement>(".tree-row[data-path]")].find((r) => r.dataset.path === path);
  }

  /** Rendered rows in document order, without the ones the filter hides. */
  private visibleRows(): HTMLElement[] {
    return [...this.el.querySelectorAll<HTMLElement>(".tree-row[data-path]")].filter((r) => !r.hidden);
  }

  private navRows(rows: HTMLElement[]): NavRow[] {
    return rows.map((r) => ({ path: r.dataset.path ?? "", isDir: r.classList.contains("dir"), expanded: this.expanded.has(r.dataset.path ?? ""), depth: Number(r.dataset.depth ?? 0) }));
  }

  /** Hide the rows the type-ahead filter drops and show the query (1px border field). */
  private applyFilter() {
    const all = [...this.el.querySelectorAll<HTMLElement>(".tree-row[data-path]")];
    const keep = filterRows(this.navRows(all), this.query);
    all.forEach((r, i) => (r.hidden = !keep[i]));
    this.filterEl.hidden = !this.query;
    this.filterEl.textContent = this.query;
    this.filterEl.title = this.query ? `Filter: ${this.query} (Esc clears)` : "";
  }

  private paintSelection() {
    for (const row of this.el.querySelectorAll<HTMLElement>(".tree-row[data-path]")) {
      const p = row.dataset.path ?? "";
      row.classList.toggle("selected", this.selected.has(p));
      row.classList.toggle("focused", p === this.focused);
      row.setAttribute("aria-selected", String(this.selected.has(p)));
    }
  }

  private setFocus(path: string | null) {
    this.focused = path;
    this.paintSelection();
    if (path) this.rowOf(path)?.scrollIntoView({ block: "nearest" });
  }

  /** A click on a row: modifiers change the selection only; a plain click selects the row
   *  alone and then opens the file or toggles the folder. Returns true for a plain click. */
  private clickSelect(path: string, ev: MouseEvent): boolean {
    const order = this.visibleRows().map((r) => r.dataset.path ?? "");
    const next = selectTo(order, { selected: this.selected, anchor: this.anchor }, path, { shift: ev.shiftKey, ctrl: ev.ctrlKey || ev.metaKey });
    this.selected = next.selected;
    this.anchor = next.anchor;
    this.focused = path;
    this.paintSelection();
    if (document.activeElement !== this.el) this.el.focus({ preventScroll: true });
    return !(ev.shiftKey || ev.ctrlKey || ev.metaKey);
  }

  private async onKey(ev: KeyboardEvent) {
    if (ev.defaultPrevented || (ev.target as HTMLElement).closest(".tree-input") || !this.root) return;
    const rows = this.visibleRows();
    const nav = this.navRows(rows);
    const focus = rows.findIndex((r) => r.dataset.path === this.focused);
    const act = navKey(nav, focus, ev, this.query);
    if (!act) return;
    ev.preventDefault();
    ev.stopPropagation();
    switch (act.kind) {
      case "focus": {
        const path = nav[act.index].path;
        if (act.keep) {
          this.setFocus(path); // Ctrl+Up/Down: the cursor moves, the selection stays
          return;
        }
        const order = nav.map((r) => r.path);
        const next = selectTo(order, { selected: this.selected, anchor: this.anchor }, path, { shift: act.extend });
        this.selected = next.selected;
        this.anchor = next.anchor;
        this.setFocus(path);
        return;
      }
      case "toggle": {
        const path = nav[act.index].path;
        const next = selectTo(nav.map((r) => r.path), { selected: this.selected, anchor: this.anchor }, path, { ctrl: true });
        this.selected = next.selected;
        this.anchor = next.anchor;
        this.setFocus(path);
        return;
      }
      case "expand":
      case "collapse":
        await this.togglers.get(nav[act.index].path)?.(act.kind === "expand");
        return;
      case "open": {
        const r = nav[act.index];
        if (r.isDir) await this.togglers.get(r.path)?.(!r.expanded);
        else this.onOpen(r.path);
        return;
      }
      case "rename": {
        const r = nav[act.index];
        this.keys?.rename(r.path, r.isDir);
        return;
      }
      case "delete": {
        const items = this.selection();
        const list = items.length ? items : nav[focus] ? [{ path: nav[focus].path, isDir: nav[focus].isDir }] : [];
        const keep = new Set(outermost(list.map((i) => i.path)));
        if (list.length) this.keys?.trash(list.filter((i) => keep.has(i.path)));
        return;
      }
      case "filter": {
        this.query = act.query;
        this.applyFilter();
        const after = this.visibleRows();
        const hit = firstMatch(this.navRows(after), this.query);
        const keepFocus = after.some((r) => r.dataset.path === this.focused);
        if (hit >= 0) this.setFocus(after[hit].dataset.path ?? null);
        else if (!keepFocus) this.setFocus(after[0]?.dataset.path ?? null);
        return;
      }
    }
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

  /** The folder New file / New folder create in: the focused selected row (else the first
   *  selected one) when it is a folder, a file's folder, else the workspace root. */
  targetDir(): string {
    const items = this.selection();
    const pick = items.find((i) => i.path === this.focused) ?? items[0];
    if (!pick || !pick.path.startsWith(`${this.root}/`)) return this.root;
    return pick.isDir ? pick.path : parentOf(pick.path);
  }

  /** Select `path` alone (null: nothing) and focus it. */
  private select(path: string | null) {
    this.selected = path ? new Set([path]) : new Set();
    this.anchor = path;
    this.focused = path;
    this.paintSelection();
  }

  /** Expand `path`'s folders down from the root, re-render and select it. */
  async reveal(path: string, isDir: boolean) {
    for (let d = isDir ? path : parentOf(path); d.startsWith(this.root) && d !== this.root; d = parentOf(d)) this.expanded.add(d);
    await this.refresh();
    this.select(path);
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
      row.dataset.depth = String(depth);
      row.setAttribute("role", "treeitem");
      row.style.paddingLeft = `${8 + depth * 12}px`;
      const caret = h("span", { class: "caret" }, entry.isDir ? (this.expanded.has(entry.path) ? "▾" : "▸") : "");
      const glyph = fileIcon(entry.name, entry.isDir, entry.isDir && this.expanded.has(entry.path));
      row.append(caret, glyph, h("span", { class: "name" }, entry.name));
      this.paintMark(row);
      if (entry.path === this.active) row.classList.add("active");
      if (this.selected.has(entry.path)) row.classList.add("selected");
      if (entry.path === this.focused) row.classList.add("focused");
      row.setAttribute("aria-selected", String(this.selected.has(entry.path)));
      if (entry.isDir) row.setAttribute("aria-expanded", String(this.expanded.has(entry.path)));
      row.addEventListener("contextmenu", (ev) => {
        if (!this.onContext || (ev.target as HTMLElement).closest(".tree-input")) return;
        ev.preventDefault();
        // A row outside the selection becomes the selection; inside, the selection stays.
        if (!this.selected.has(entry.path)) this.select(entry.path);
        else this.setFocus(entry.path);
        const rows = this.visibleRows();
        const order = rows.map((r) => r.dataset.path ?? "");
        const targets = contextTargets(order, this.selected, entry.path).map((p) => ({ path: p, isDir: !!this.rowOf(p)?.classList.contains("dir") }));
        this.onContext({ path: entry.path, isDir: entry.isDir, x: ev.clientX, y: ev.clientY, targets });
      });
      box.append(row);
      if (entry.isDir) {
        const kids = h("div", { class: "tree-sub" });
        box.append(kids);
        const load = async () => kids.replaceChildren(await this.renderDir(entry.path, depth + 1));
        if (this.expanded.has(entry.path)) await load();
        const toggle = async (open: boolean) => {
          if (open === this.expanded.has(entry.path)) return;
          row.setAttribute("aria-expanded", String(open));
          if (!open) {
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
            this.applyFilter();
          }
        };
        this.togglers.set(entry.path, toggle);
        row.addEventListener("click", async (ev) => {
          if (row.classList.contains("editing")) return;
          if (!this.clickSelect(entry.path, ev)) return;
          await toggle(!this.expanded.has(entry.path));
        });
      } else {
        row.addEventListener("click", (ev) => {
          if (row.classList.contains("editing")) return;
          if (this.clickSelect(entry.path, ev)) this.onOpen(entry.path);
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
