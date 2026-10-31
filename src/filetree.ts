// Explorer: lazy file tree of the opened workspace. Clicking a row selects it (the target
// folder of New file / New folder); names for a new item or a rename are typed inline.
import { api, errText, h, type Entry } from "./api";

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
    const row = h("div", { class: `tree-row editing ${kind === "file" ? "file" : "dir"}` }, h("span", { class: "caret" }, kind === "folder" ? "▸" : ""), input);
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
      row.append(caret, h("span", { class: "name" }, entry.name));
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
          } else {
            this.expanded.add(entry.path);
            caret.textContent = "▾";
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
