// Command palette (Ctrl+Shift+P, More → Commands): the opened folder's slash commands from
// the kit's versioned catalog (`agent-kit commands --json`, read by src-tauri catalog.rs).
// Colony keeps no list: an engine without the catalog shows "Update the engine".
//  - Run: the row's name is in vendor.rs PROMPT_SLASH (decided on the Rust side, `run`);
//    `/<name>` opens the interactive agent after a native confirmation, and term_launch
//    checks it again.
//  - Copy: every other row (factory, project, /git-prod, ...): `/<name>` to the clipboard,
//    to paste in the agent's chat input.
// Names and descriptions are untrusted repo text: built with h() as text nodes only.
import { api, errText, h, type CommandRow, type CommandsCatalog } from "./api";
import { chip, copyText } from "./ui";

export interface PaletteHost {
  status(msg: string): void;
  hasFolder(): boolean;
  /** The vendor CLI in a terminal tab with `/<name>` as its first prompt (confirms first). */
  interactive(prompt: string, why: string): Promise<unknown>;
  showEngine(): void;
}

const LAYER_TIP: Record<string, string> = {
  kit: "Shipped by Agent Kit",
  factory: "Kit maintainers only (never installed in other repos)",
  project: "Added by this folder",
};

export class CommandPalette {
  readonly el = h("div", { id: "palette" });
  private input = h("input", { id: "palette-input", placeholder: "Type a command or a word from its description", autocomplete: "off", spellcheck: "false" });
  private head = h("div", { class: "palette-head dim small" });
  private list = h("div", { id: "palette-list" });
  private catalog: CommandsCatalog | null = null;
  /** The last load error (the engine gate), shown instead of rows. */
  error = "";
  private sel = 0;
  private loading: Promise<void> | null = null;

  constructor(private host: PaletteHost) {
    this.el.hidden = true;
    this.el.append(h("div", { class: "quick-box palette-box" }, this.input, this.head, this.list));
    this.el.addEventListener("mousedown", (ev) => ev.target === this.el && this.hide());
    this.input.addEventListener("input", () => {
      this.sel = 0;
      this.render();
    });
    this.input.addEventListener("keydown", (ev) => {
      const rows = this.matches();
      if (ev.key === "ArrowDown") this.sel = Math.min(this.sel + 1, rows.length - 1);
      else if (ev.key === "ArrowUp") this.sel = Math.max(this.sel - 1, 0);
      else if (ev.key === "Enter") return rows[this.sel] && this.pick(rows[this.sel]);
      else if (ev.key === "Escape") return this.hide();
      else return;
      ev.preventDefault();
      this.render();
    });
  }

  get open() {
    return !this.el.hidden;
  }

  /** Open with a fresh catalog (it follows engine updates and the folder's command files). */
  show(): Promise<void> {
    if (!this.host.hasFolder()) {
      this.host.status("Open a folder first");
      return Promise.resolve();
    }
    this.el.hidden = false;
    this.input.value = "";
    this.sel = 0;
    this.input.focus();
    this.render();
    this.loading ??= api.commandsCatalog().then(
      (c) => {
        this.catalog = c;
        this.error = "";
      },
      (e) => {
        this.catalog = null;
        this.error = errText(e);
      },
    ).finally(() => {
      this.loading = null;
      this.render();
    });
    return this.loading;
  }

  hide() {
    this.el.hidden = true;
  }

  /** The folder changed: drop the old folder's rows. */
  reset() {
    this.catalog = null;
    this.error = "";
    this.hide();
  }

  rows(): CommandRow[] {
    return this.catalog?.commands ?? [];
  }

  private matches(): CommandRow[] {
    const q = this.input.value.trim().replace(/^\//, "").toLowerCase();
    const all = this.rows();
    if (!q) return all;
    const scored: [number, CommandRow][] = [];
    for (const r of all) {
      const rank = r.name.startsWith(q) ? 0 : r.name.includes(q) ? 1 : r.description.toLowerCase().includes(q) ? 2 : -1;
      if (rank >= 0) scored.push([rank, r]);
    }
    return scored.sort((a, b) => a[0] - b[0]).map((s) => s[1]);
  }

  private pick(r: CommandRow) {
    this.hide();
    const slash = `/${r.name}`;
    if (r.run) {
      void this.host.interactive(slash, `Command palette: ${r.description}`);
      return;
    }
    void copyText(slash).then((ok) => this.host.status(ok ? `Copied ${slash}: paste it in your agent's chat input` : `Could not copy ${slash}`));
  }

  private render() {
    const c = this.catalog;
    if (this.error) {
      const engine = h("button", { class: "link" }, "Engine…");
      engine.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        this.hide();
        this.host.showEngine();
      });
      this.head.replaceChildren(this.error, " ", engine);
      this.list.replaceChildren();
      return;
    }
    if (!c) {
      this.head.replaceChildren("Loading the commands catalog…");
      this.list.replaceChildren();
      return;
    }
    this.head.replaceChildren(`Agent Kit ${c.kitVersion} · catalog ${c.catalogVersion} · Run opens your agent with it; Copy is for your agent's chat input`);
    const rows = this.matches();
    this.sel = Math.min(this.sel, Math.max(0, rows.length - 1));
    if (!rows.length) {
      this.list.replaceChildren(h("div", { class: "quick-item dim" }, c.commands.length ? "No command matches" : "This folder has no slash commands (.cursor/commands/)"));
      return;
    }
    this.list.replaceChildren(
      ...rows.map((r, i) => {
        const el = h(
          "div",
          { class: `quick-item palette-item ${i === this.sel ? "sel" : ""}`, title: r.run ? `Run /${r.name} in your agent (asks first)` : `Copy /${r.name}` },
          h("div", { class: "row" }, h("span", { class: "mono grow" }, `/${r.name}`), chip(r.layer, `palette-layer layer-${r.layer}`), h("span", { class: `palette-act ${r.run ? "run" : ""}` }, r.run ? "Run" : "Copy")),
          ...(r.description ? [h("div", { class: "dim small ellipsis" }, r.description)] : []),
        );
        el.querySelector(".palette-layer")?.setAttribute("title", LAYER_TIP[r.layer] ?? r.layer);
        el.dataset.name = r.name;
        el.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          this.pick(r);
        });
        return el;
      }),
    );
    this.list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }
}
