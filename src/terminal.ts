// The terminal drawer: the user's shells (or an editor argv) in the opened folder. The
// interactive vendor CLIs and the queue runners are centre tabs and are not listed here.
import { errText, h } from "./api";
import { TermView } from "./termview";

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
    const view = new TermView(pane);
    const n = ++this.counter;
    const tab = h("button", { class: "tab", title: command ? command.join(" ") : "" }, label ?? `bash ${n}`);
    const close = h("span", { class: "tab-close", title: "Close terminal" }, "×");
    tab.append(close);
    this.tabBar.insertBefore(tab, this.tabBar.querySelector(".tab-add"));
    const t: Tab = { n, view, tab };
    this.tabs.push(t);
    this.show(t);
    view.onExit = () => tab.classList.add("exited");
    tab.addEventListener("click", (ev) => {
      if (ev.target === close) this.close(t);
      else this.show(t);
    });
    try {
      await view.spawn(command);
    } catch (e) {
      this.onError(`Terminal: ${errText(e)}`);
      return;
    }
    this.fitActive();
  }

  private show(t: Tab) {
    this.active = t;
    for (const x of this.tabs) {
      x.view.pane.style.display = x === t ? "block" : "none";
      x.tab.classList.toggle("active", x === t);
    }
    requestAnimationFrame(() => {
      this.fitActive();
      t.view.focus();
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
    t.view.dispose();
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
