// One xterm.js view over a Rust PTY (src-tauri/src/pty.rs). Used by the bottom terminal
// tabs and by the center tabs that run an interactive vendor CLI or the queue runner.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api, Channel, errText, focusPolicy, h, type PtyEvent } from "./api";
import { onSkin, termFont, token } from "./skin";

// The skin's surfaces and semantic colors (src/tokens.css); bright variants stay xterm's.
const termTheme = () => ({
  background: token("--bg-primary"),
  foreground: token("--text-primary"),
  cursor: token("--text-primary"),
  cursorAccent: token("--bg-primary"),
  selectionBackground: token("--mc-selection"),
  red: token("--red"),
  green: token("--green"),
  yellow: token("--yellow"),
  blue: token("--blue"),
  magenta: token("--purple"),
  cyan: token("--cyan"),
  brightBlack: token("--text-muted"),
});

/** Where a terminal reports a clipboard failure (main.ts points it at the status bar). */
export const termStatus = { show: (_msg: string): void => {} };

export class TermView {
  private static byPane = new WeakMap<Element, TermView>();
  /** The terminal that `el` sits in (a drop target, a right-click), if any. */
  static at(el: Element | null): TermView | undefined {
    const pane = el?.closest(".term-pane");
    return pane ? TermView.byPane.get(pane) : undefined;
  }
  readonly term: Terminal;
  private fitAddon = new FitAddon();
  id = -1;
  exited = false;
  exitCode: number | null = null;
  /** Everything the process printed (capped), for the code-path smoke. */
  output = "";
  onExit: (code: number | null) => void = () => {};
  /** Every chunk the process printed, and every chunk the operator typed (./launches.ts). */
  onOutput: (data: string) => void = () => {};
  onInput: (data: string) => void = () => {};

  constructor(readonly pane: HTMLElement) {
    this.term = new Terminal({
      // Omarchy's monospace font on that skin, then the Nerd Font prompt themes need,
      // then the shared monospace stack.
      fontFamily: termFont(),
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10000,
      theme: termTheme(),
    });
    this.term.loadAddon(this.fitAddon);
    this.term.open(pane);
    TermView.byPane.set(pane, this);
    this.offSkin = onSkin(() => {
      this.term.options.theme = termTheme();
      const font = termFont();
      if (this.term.options.fontFamily !== font) {
        this.term.options.fontFamily = font;
        this.fit();
      }
    });
  }
  private offSkin: () => void;

  /** Spawn the shell, or `command` (argv), in the opened folder. */
  async spawn(command?: string[]): Promise<boolean> {
    const channel = new Channel<PtyEvent>();
    channel.onmessage = (m) => {
      if (m.kind === "data") {
        this.term.write(m.data);
        if (this.output.length < 64 * 1024) this.output += m.data;
        this.onOutput(m.data);
      } else {
        this.exited = true;
        this.exitCode = m.code;
        this.term.write(`\r\n\x1b[2m[process exited${m.code === null ? "" : ` with code ${m.code}`}]\x1b[0m\r\n`);
        this.onExit(m.code);
      }
    };
    this.fit();
    try {
      this.id = await api.ptySpawn(this.term.cols, this.term.rows, channel, command);
    } catch (e) {
      this.term.write(`\x1b[31m${errText(e)}\x1b[0m\r\n`);
      this.exited = true;
      throw e;
    }
    this.term.onData((d) => {
      this.onInput(d);
      if (!this.exited) api.ptyWrite(this.id, d).catch(() => {});
    });
    this.term.onResize(({ cols, rows }) => {
      if (!this.exited) api.ptyResize(this.id, cols, rows).catch(() => {});
    });
    this.term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown" || !ev.ctrlKey || !ev.shiftKey) return true;
      if (ev.code === "KeyC") {
        void this.copySelection();
        return false;
      }
      if (ev.code === "KeyV") {
        void this.pasteClipboard();
        return false;
      }
      return true;
    });
    return true;
  }

  /** Ctrl+Shift+C and the menu's Copy: the selection to the clipboard. */
  async copySelection(): Promise<void> {
    const sel = this.term.getSelection();
    if (!sel) return;
    try {
      await navigator.clipboard.writeText(sel);
    } catch (e) {
      termStatus.show(`Copy failed: ${errText(e)}`);
    }
  }

  /** Ctrl+Shift+V and the menu's Paste: the clipboard's text into the shell (bracketed
   *  when the program asked for it). A refused read is shown, never swallowed. */
  async pasteClipboard(): Promise<void> {
    let txt: string;
    try {
      txt = await navigator.clipboard.readText();
    } catch (e) {
      termStatus.show(`Paste failed: the clipboard read was refused (${errText(e)})`);
      return;
    }
    if (txt) this.term.paste(txt);
    else termStatus.show("Paste: the clipboard holds no text");
  }

  async send(data: string) {
    if (this.id < 0 || this.exited) throw new Error("terminal is closed");
    await api.ptyWrite(this.id, data);
  }

  fit() {
    if (this.pane.clientHeight < 20) return;
    try {
      this.fitAddon.fit();
    } catch {
      /* not laid out yet */
    }
  }

  /** Columns and rows now, and what the pane fits (equal once fit() ran after a resize). */
  size(): { cols: number; rows: number; fits: { cols: number; rows: number } | null } {
    const d = this.fitAddon.proposeDimensions();
    return { cols: this.term.cols, rows: this.term.rows, fits: d && Number.isFinite(d.cols) && Number.isFinite(d.rows) ? { cols: d.cols, rows: d.rows } : null };
  }

  focus() {
    if (focusPolicy.enabled) this.term.focus();
  }

  hasFocus(): boolean {
    return !!document.activeElement && this.pane.contains(document.activeElement);
  }

  dispose() {
    this.offSkin();
    if (this.id >= 0 && !this.exited) api.ptyKill(this.id).catch(() => {});
    this.term.dispose();
    this.pane.remove();
  }
}

// ---- right-click menu ---------------------------------------------------------------
// WebKit's own menu stays cancelled over a terminal (main.ts contextmenu: it offers Back /
// Reload); a right-click there opens this Copy / Paste menu instead.
let termMenu: HTMLElement | null = null;
let menuView: TermView | null = null;

function closeTermMenu() {
  if (termMenu) termMenu.hidden = true;
}

export function openTermMenu(view: TermView, x: number, y: number) {
  if (!termMenu) {
    const m = h("div", { id: "term-menu", class: "menu", role: "menu", "aria-label": "Terminal", hidden: "" });
    for (const ev of ["click", "resize", "blur"]) window.addEventListener(ev, closeTermMenu);
    window.addEventListener("colony:popover", (ev) => (ev as CustomEvent).detail !== "terminal" && closeTermMenu());
    window.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape" || m.hidden) return;
      ev.preventDefault();
      closeTermMenu();
      menuView?.focus();
    });
    document.body.append(m);
    termMenu = m;
  }
  // One popover at a time (main.ts, planmenu.ts).
  window.dispatchEvent(new CustomEvent("colony:popover", { detail: "terminal" }));
  menuView = view;
  const copy = h("button", { role: "menuitem", "data-act": "term-copy" }, "Copy");
  copy.disabled = !view.term.getSelection();
  copy.addEventListener("click", () => void view.copySelection().then(() => view.focus()));
  const paste = h("button", { role: "menuitem", "data-act": "term-paste" }, "Paste");
  paste.addEventListener("click", () => void view.pasteClipboard().then(() => view.focus()));
  termMenu.replaceChildren(copy, paste);
  termMenu.hidden = false;
  const r = termMenu.getBoundingClientRect();
  termMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  termMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
}
