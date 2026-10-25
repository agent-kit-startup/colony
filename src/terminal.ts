// The terminal drawer: the user's shells (or an editor argv) in the opened folder, then a
// link to every centre terminal tab (./termlist.ts).
import { errText, h } from "./api";
import { icon } from "./icons";
import type { LinkedTerm } from "./termlist";
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
  /** Centre terminal tab id -> its link in the drawer's tab strip (kept across renders, so
   *  a click that lands during a re-render still reaches the same button). */
  private linked = new Map<string, HTMLElement>();
  private pick: (id: string) => void = () => {};

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

  /** List the centre terminal tabs after the shells. A link shows its centre tab (`pick`);
   *  the terminal itself stays there. Exited ones stay listed, dimmed, while their tab is open. */
  setLinked(list: LinkedTerm[], pick: (id: string) => void) {
    this.pick = pick;
    const box = this.tabBar.querySelector<HTMLElement>(".term-linked");
    if (!box) return;
    const keep = new Set(list.map((t) => t.id));
    for (const [id, el] of this.linked) {
      if (keep.has(id)) continue;
      el.remove();
      this.linked.delete(id);
    }
    list.forEach((t, i) => {
      let el = this.linked.get(t.id);
      if (!el) {
        el = h("button", { class: "term-link" });
        el.dataset.tab = t.id;
        el.addEventListener("click", () => this.pick(t.id));
        this.linked.set(t.id, el);
      }
      el.classList.toggle("exited", t.exited);
      el.classList.toggle("current", t.current);
      el.setAttribute("aria-current", t.current ? "true" : "false");
      el.title = `${t.label}: a centre tab${t.exited ? ", exited" : t.gate ? ", waiting on a gate" : ""}. Click to show it.${t.tip ? `\n${t.tip}` : ""}`;
      const sig = `${t.icon}|${t.gate}|${t.label}`;
      if (el.dataset.sig !== sig) {
        el.dataset.sig = sig;
        el.replaceChildren(icon(t.icon, "tab-svg"), h("span", { class: "lbl" }, t.label), ...(t.gate ? [h("span", { class: "badge warn" }, "gate")] : []));
      }
      if (box.children[i] !== el) box.insertBefore(el, box.children[i] ?? null);
    });
    box.hidden = !list.length;
  }

  /** The centre tab ids the drawer lists (COLONY_SMOKE). */
  linkedIds(): string[] {
    return [...this.tabBar.querySelectorAll<HTMLElement>(".term-linked .term-link")].map((el) => el.dataset.tab ?? "");
  }

  closeAll() {
    for (const t of [...this.tabs]) this.close(t);
  }
}
