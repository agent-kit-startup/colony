// Command palette (Ctrl+Shift+P, More → Commands): the opened folder's slash commands from
// the kit's versioned catalog (`agent-kit commands --json`, read by src-tauri catalog.rs).
// Colony keeps no list: an engine without the catalog shows "Update the engine".
//  - Run: the row's name is in vendor.rs PROMPT_SLASH (decided on the Rust side, `run`);
//    `/<name>` opens the interactive agent after a native confirmation, and term_launch
//    checks it again.
//  - Copy: every other row (factory, project, /git-prod, ...): `/<name>` to the clipboard,
//    to paste in the agent's chat input.
// Below them, a "Claude Code" section lists the vendor's built-in commands from the static,
// cited claude-builtins.ts list: always copy, plus "Open Claude tab" (the unmodified
// `claude`, no prompt). It does not depend on the engine, so it shows under the gate too.
// Names and descriptions are untrusted repo text: built with h() as text nodes only.
import { api, errText, h, type CommandRow, type CommandsCatalog } from "./api";
import { CLAUDE_BUILTINS, SOURCE_TITLE, SOURCE_URL, VERIFIED_AT, type ClaudeBuiltin } from "./claude-builtins";
import { chip, copyText } from "./ui";

export interface PaletteHost {
  status(msg: string): void;
  hasFolder(): boolean;
  /** The vendor CLI in a terminal tab with `/<name>` as its first prompt (confirms first). */
  interactive(prompt: string, why: string): Promise<unknown>;
  showEngine(): void;
  /** The unmodified `claude` in a terminal tab, no prompt (whatever the engine choice). */
  openClaude(): Promise<unknown>;
}

type Entry = { kind: "kit"; row: CommandRow } | { kind: "claude"; row: ClaudeBuiltin };

const LAYER_TIP: Record<string, string> = {
  kit: "Shipped by Agent Kit",
  factory: "Kit maintainers only (never installed in other repos)",
  project: "Added by this folder",
};

const KIND_TIP: Record<string, string> = {
  builtin: "Claude Code built-in command",
  skill: "Skill bundled with Claude Code",
  workflow: "Workflow bundled with Claude Code",
  alias: "Another name for a Claude Code command",
};

/** 0 name prefix, 1 name substring, 2 description match, -1 no match. */
function rank(q: string, name: string, description: string): number {
  return name.startsWith(q) ? 0 : name.includes(q) ? 1 : description.toLowerCase().includes(q) ? 2 : -1;
}

function ranked<T extends { name: string; description: string }>(q: string, all: readonly T[]): T[] {
  if (!q) return [...all];
  const scored: [number, T][] = [];
  for (const r of all) {
    const n = rank(q, r.name, r.description);
    if (n >= 0) scored.push([n, r]);
  }
  return scored.sort((a, b) => a[0] - b[0]).map((s) => s[1]);
}

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

  /** The kit catalog's rows (the Claude Code section is builtins()). */
  rows(): CommandRow[] {
    return this.catalog?.commands ?? [];
  }

  builtins(): readonly ClaudeBuiltin[] {
    return CLAUDE_BUILTINS;
  }

  /** Kit rows first, then Claude Code built-ins, each ranked by the query. */
  private matches(): Entry[] {
    const q = this.input.value.trim().replace(/^\//, "").toLowerCase();
    return [
      ...ranked(q, this.rows()).map((row): Entry => ({ kind: "kit", row })),
      ...ranked(q, this.builtins()).map((row): Entry => ({ kind: "claude", row })),
    ];
  }

  private pick(e: Entry) {
    this.hide();
    const slash = `/${e.row.name}`;
    if (e.kind === "kit" && e.row.run) {
      void this.host.interactive(slash, `Command palette: ${e.row.description}`);
      return;
    }
    const where = e.kind === "claude" ? "Claude's chat input (a Claude Code built-in)" : "your agent's chat input";
    void copyText(slash).then((ok) => this.host.status(ok ? `Copied ${slash}: paste it in ${where}` : `Could not copy ${slash}`));
  }

  private button(label: string, title: string, act: () => void): HTMLElement {
    const b = h("button", { class: "link", title }, label);
    b.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      act();
    });
    return b;
  }

  /** The Claude Code section head: the cited source, Open Claude tab, Copy docs link. */
  private claudeHead(shown: number): HTMLElement {
    const open = this.button("Open Claude tab", "Start the claude CLI, unmodified, in a terminal tab (no prompt)", () => {
      this.hide();
      void this.host.openClaude();
    });
    const link = this.button("Copy docs link", SOURCE_URL, () => {
      void copyText(SOURCE_URL).then((ok) => this.host.status(ok ? `Copied ${SOURCE_URL}: open it in your browser` : `Could not copy ${SOURCE_URL}`));
    });
    return h(
      "div",
      { class: "palette-section" },
      h("div", { class: "row" }, h("span", { class: "grow" }, `Claude Code · ${shown} of ${CLAUDE_BUILTINS.length} · Copy for Claude's chat input`), open, " ", link),
      h("div", { class: "dim small ellipsis", title: `${SOURCE_TITLE}, checked ${VERIFIED_AT}` }, `${SOURCE_TITLE} · ${SOURCE_URL} · checked ${VERIFIED_AT}`),
    );
  }

  private item(e: Entry, sel: boolean): HTMLElement {
    const slash = `/${e.row.name}`;
    const kit = e.kind === "kit";
    const run = kit && e.row.run;
    const tag = kit ? e.row.layer : e.row.kind;
    const el = h(
      "div",
      { class: `quick-item ${kit ? "palette-item" : "palette-builtin"} ${sel ? "sel" : ""}`, title: run ? `Run ${slash} in your agent (asks first)` : `Copy ${slash}` },
      h(
        "div",
        { class: "row" },
        h("span", { class: "mono" }, slash),
        h("span", { class: "dim mono small grow ellipsis" }, kit ? "" : (e.row.args ?? "")),
        chip(tag, kit ? `palette-layer layer-${tag}` : `palette-layer kind-${tag}`),
        h("span", { class: `palette-act ${run ? "run" : ""}` }, run ? "Run" : "Copy"),
      ),
      ...(e.row.description ? [h("div", { class: "dim small ellipsis" }, e.row.description)] : []),
    );
    el.querySelector(".palette-layer")?.setAttribute("title", (kit ? LAYER_TIP : KIND_TIP)[tag] ?? tag);
    el.dataset.name = e.row.name;
    el.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      this.pick(e);
    });
    return el;
  }

  private render() {
    const c = this.catalog;
    const entries = this.matches();
    const kitShown = entries.filter((e) => e.kind === "kit").length;
    this.sel = Math.min(this.sel, Math.max(0, entries.length - 1));
    const kitList: HTMLElement[] = [];
    if (this.error) {
      const engine = this.button("Engine…", "Update the engine", () => {
        this.hide();
        this.host.showEngine();
      });
      this.head.replaceChildren(this.error, " ", engine);
    } else if (!c) {
      this.head.replaceChildren("Loading the commands catalog…");
    } else {
      this.head.replaceChildren(`Agent Kit ${c.kitVersion} · catalog ${c.catalogVersion} · Run opens your agent with it; Copy is for your agent's chat input`);
      if (!kitShown) kitList.push(h("div", { class: "quick-item dim" }, c.commands.length ? "No command matches" : "This folder has no slash commands (.cursor/commands/)"));
    }
    const items = entries.map((e, i) => this.item(e, i === this.sel));
    this.list.replaceChildren(...kitList, ...items.slice(0, kitShown), this.claudeHead(entries.length - kitShown), ...items.slice(kitShown));
    this.list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }
}
