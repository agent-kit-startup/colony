// One xterm.js view over a Rust PTY (src-tauri/src/pty.rs). Used by the bottom terminal
// tabs and by the center tabs that run an interactive vendor CLI or the queue runner.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api, Channel, errText, focusPolicy, type PtyEvent } from "./api";
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

export class TermView {
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
        const sel = this.term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      if (ev.code === "KeyV") {
        navigator.clipboard.readText().then((txt) => this.term.paste(txt)).catch(() => {});
        return false;
      }
      return true;
    });
    return true;
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
