// Integrated terminals: xterm.js views over Rust PTYs (src-tauri/src/pty.rs).
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api, Channel, errText, focusPolicy, h, type PtyEvent } from "./api";

interface Tab {
  id: number;
  n: number;
  term: Terminal;
  fit: FitAddon;
  pane: HTMLElement;
  tab: HTMLElement;
  exited: boolean;
}

export class Terminals {
  private tabs: Tab[] = [];
  private active: Tab | null = null;
  private counter = 0;

  constructor(
    private tabBar: HTMLElement,
    private host: HTMLElement,
    private onError: (msg: string) => void,
  ) {
    new ResizeObserver(() => this.fitActive()).observe(host);
  }

  get count() {
    return this.tabs.length;
  }

  /** New tab running the user's shell, or `command` (argv) labelled `label`. */
  async create(command?: string[], label?: string) {
    const pane = h("div", { class: "term-pane" });
    this.host.append(pane);
    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono"),
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10000,
      theme: { background: "#101216", foreground: "#d7dae0", selectionBackground: "#3a4a8a" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(pane);
    const n = ++this.counter;
    const tab = h("button", { class: "tab", title: command ? command.join(" ") : "" }, label ?? `bash ${n}`);
    const close = h("span", { class: "tab-close", title: "Close terminal" }, "×");
    tab.append(close);
    this.tabBar.insertBefore(tab, this.tabBar.querySelector(".tab-add"));
    const t: Tab = { id: -1, n, term, fit, pane, tab, exited: false };
    this.tabs.push(t);
    this.show(t);

    const channel = new Channel<PtyEvent>();
    channel.onmessage = (m) => {
      if (m.kind === "data") term.write(m.data);
      else {
        t.exited = true;
        term.write(`\r\n\x1b[2m[process exited${m.code === null ? "" : ` with code ${m.code}`}]\x1b[0m\r\n`);
        tab.classList.add("exited");
      }
    };
    try {
      t.id = await api.ptySpawn(term.cols, term.rows, channel, command);
    } catch (e) {
      this.onError(`Terminal: ${errText(e)}`);
      term.write(`\x1b[31m${errText(e)}\x1b[0m\r\n`);
      return;
    }
    term.onData((d) => {
      if (!t.exited) api.ptyWrite(t.id, d).catch(() => {});
    });
    term.onResize(({ cols, rows }) => {
      if (!t.exited) api.ptyResize(t.id, cols, rows).catch(() => {});
    });
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown" || !ev.ctrlKey || !ev.shiftKey) return true;
      if (ev.code === "KeyC") {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      if (ev.code === "KeyV") {
        navigator.clipboard.readText().then((txt) => term.paste(txt)).catch(() => {});
        return false;
      }
      return true;
    });
    tab.addEventListener("click", (ev) => {
      if (ev.target === close) this.close(t);
      else this.show(t);
    });
    this.fitActive();
  }

  private show(t: Tab) {
    this.active = t;
    for (const x of this.tabs) {
      x.pane.style.display = x === t ? "block" : "none";
      x.tab.classList.toggle("active", x === t);
    }
    requestAnimationFrame(() => {
      this.fitActive();
      if (focusPolicy.enabled) t.term.focus();
    });
  }

  /** Write to the active terminal's shell (used by the code-path smoke). */
  async sendToActive(data: string) {
    if (!this.active || this.active.id < 0) throw new Error("no terminal");
    await api.ptyWrite(this.active.id, data);
  }

  focus() {
    if (this.active && focusPolicy.enabled) this.active.term.focus();
  }

  hasFocus(): boolean {
    return !!document.activeElement && this.host.contains(document.activeElement);
  }

  fitActive() {
    if (!this.active || this.host.clientHeight < 20) return;
    try {
      this.active.fit.fit();
    } catch {
      /* not laid out yet */
    }
  }

  close(t: Tab) {
    if (t.id >= 0 && !t.exited) api.ptyKill(t.id).catch(() => {});
    t.term.dispose();
    t.pane.remove();
    t.tab.remove();
    this.tabs = this.tabs.filter((x) => x !== t);
    if (this.active === t) {
      this.active = null;
      const next = this.tabs[this.tabs.length - 1];
      if (next) this.show(next);
    }
  }

  closeAll() {
    for (const t of [...this.tabs]) this.close(t);
  }
}
