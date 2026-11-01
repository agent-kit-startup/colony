// The terminal drawer: the user's shells (or an editor argv) in the opened folder. The
// interactive vendor CLIs and the queue runners are centre tabs and are not listed here.
// Every shell is also a row of the Terminals view (./ttys.ts), closed ones included.
import { api, errText, h } from "./api";
import { TermView } from "./termview";
import { ttys } from "./ttys";

interface Tab {
  n: number;
  view: TermView;
  tab: HTMLElement;
}

export class Terminals {
  private tabs: Tab[] = [];
  private active: Tab | null = null;
  private counter = 0;

  constructor(
    private tabBar: HTMLElement,
    private host: HTMLElement,
    private onError: (msg: string) => void,
    /** The opened folder (where a new shell starts), for the Terminals view's rows. */
    private root: () => string = () => "",
  ) {
    new ResizeObserver(() => this.fitActive()).observe(host);
  }

  get count() {
    return this.tabs.length;
  }

  /** New tab running the user's shell, or `command` (argv) labelled `label`; in `cwd` (a
   *  folder of the workspace) when given, else the workspace root. */
  async create(command?: string[], label?: string, cwd?: string) {
    const pane = h("div", { class: "term-pane" });
    this.host.append(pane);
    const view = new TermView(pane);
    const n = ++this.counter;
    const tab = h("button", { class: "tab", title: command ? command.join(" ") : "" }, label ?? `bash ${n}`);
    const close = h("span", { class: "tab-close", title: "Close terminal" }, "×");
    tab.append(close);
    this.tabBar.insertBefore(tab, this.tabBar.querySelector(".tab-add"));
    const t: Tab = { n, view, tab };
    this.tabs.push(t);
    this.show(t);
    const key = `drawer:${n}`;
    ttys.add({ key, place: "drawer", label: label ?? `bash ${n}`, argv: command ?? null, root: cwd ?? this.root(), startedAt: Date.now() });
    view.onExit = (code) => {
      tab.classList.add("exited");
      ttys.exited(key, code);
    };
    view.term.onTitleChange((title) => ttys.update(key, { title: title.slice(0, 200) }));
    tab.addEventListener("click", (ev) => {
      if (ev.target === close) this.close(t);
      else this.show(t);
    });
    try {
      await view.spawn(command, cwd);
    } catch (e) {
      this.onError(`Terminal: ${errText(e)}`);
      ttys.exited(key, null);
      return;
    }
    ttys.update(key, { ptyId: view.id });
    this.fitActive();
  }

  /** Show the drawer shell numbered `n` (the Terminals view's Focus); false if it is gone. */
  focusShell(n: number): boolean {
    const t = this.tabs.find((x) => x.n === n);
    if (!t) return false;
    this.show(t);
    return true;
  }

  private show(t: Tab) {
    this.active = t;
    for (const x of this.tabs) {
      x.view.pane.style.display = x === t ? "block" : "none";
      x.tab.classList.toggle("active", x === t);
    }
    requestAnimationFrame(() => {
      this.fitActive();
      // A closed drawer keeps its bar: a shell closed there must not focus a hidden pane.
      if (this.host.clientHeight >= 20) t.view.focus();
    });
  }

  /** Write to the active terminal's shell (used by the code-path smoke). */
  async sendToActive(data: string) {
    if (!this.active) throw new Error("no terminal");
    await this.active.view.send(data);
  }

  focus() {
    this.active?.view.focus();
  }

  hasFocus(): boolean {
    return !!document.activeElement && this.host.contains(document.activeElement);
  }

  /** The active terminal's size and what its pane fits (COLONY_SMOKE: fitted after a move). */
  activeSize() {
    return this.active?.view.size() ?? null;
  }

  fitActive() {
    if (!this.active || this.host.clientHeight < 20) return;
    this.active.view.fit();
  }

  close(t: Tab) {
    const key = `drawer:${t.n}`;
    // The last folder the shell was in is read before the process goes; the row then closes
    // and the PTY is killed (the pane is hidden at once).
    const cwd = t.view.exited || t.view.id < 0 ? Promise.resolve(null) : api.ptyCwd(t.view.id).catch(() => null);
    t.view.pane.style.display = "none";
    t.tab.remove();
    this.tabs = this.tabs.filter((x) => x !== t);
    if (this.active === t) {
      this.active = null;
      const next = this.tabs[this.tabs.length - 1];
      if (next) this.show(next);
    }
    void cwd.then((c) => {
      if (c) ttys.update(key, { cwd: c });
      ttys.closed(key);
      t.view.dispose();
    });
  }

  closeAll() {
    for (const t of [...this.tabs]) this.close(t);
  }
}
