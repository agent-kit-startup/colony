// Explorer: lazy file tree of the opened workspace.
import { api, errText, h, type Entry } from "./api";

export class FileTree {
  private root = "";
  private expanded = new Set<string>();
  private active = "";

  constructor(
    private el: HTMLElement,
    private onOpen: (path: string) => void,
    private onError: (msg: string) => void,
  ) {}

  async setRoot(root: string) {
    this.root = root;
    this.expanded = new Set([root]);
    await this.refresh();
  }

  async refresh() {
    if (!this.root) return;
    const list = await this.renderDir(this.root, 0);
    this.el.replaceChildren(list);
  }

  setActive(path: string) {
    this.active = path;
    for (const row of this.el.querySelectorAll<HTMLElement>(".tree-row")) {
      row.classList.toggle("active", row.dataset.path === path);
    }
  }

  private async renderDir(path: string, depth: number): Promise<HTMLElement> {
    const box = h("div", { class: "tree-children" });
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
      box.append(row);
      if (entry.isDir) {
        const kids = h("div", { class: "tree-sub" });
        box.append(kids);
        const load = async () => kids.replaceChildren(await this.renderDir(entry.path, depth + 1));
        if (this.expanded.has(entry.path)) await load();
        row.addEventListener("click", async () => {
          if (this.expanded.has(entry.path)) {
            this.expanded.delete(entry.path);
            kids.replaceChildren();
            caret.textContent = "▸";
          } else {
            this.expanded.add(entry.path);
            caret.textContent = "▾";
            await load();
          }
        });
      } else {
        row.addEventListener("click", () => this.onOpen(entry.path));
      }
    }
    return box;
  }
}
