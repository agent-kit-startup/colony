// The terminal drawer: the user's shells (or an editor argv) in the opened folder, plus any
// centre terminal tab the operator moved here (kit ADR 2026-10-24 amend 2026-11-07). A shell
// may move to the editor area and back; it keeps its key (`drawer:<n>`) and its process. A
// moved centre PTY keeps its tab id (`term:<n>`), its element (context strip included) and its
// own close. Every shell is also a row of the Terminals view (./ttys.ts), closed ones included.
import { api, errText, h } from "./api";
import { TermView } from "./termview";
import { ttys } from "./ttys";

/** What a centre PTY brings into the drawer: its gate surfaces and its own close. */
export interface AdoptedHooks {
  tip: string;
  /** Extra classes of its drawer tab (`run-gate`: the gate border colour, `exited`). */
  cls: () => string;
  badge: () => { text: string; cls: string } | null;
  icon?: () => Element;
  /** Its close (launches, chats, the Terminals row); the drawer only takes the tab out. */
  close: () => void;
}

/** A terminal leaving the drawer, alive (`release`). */
export interface Released {
  key: string;
  label: string;
  /** The drawer tab's tooltip (a shell's argv). */
  tip?: string;
  view: TermView;
  /** The element that sat in the drawer (the pane of a shell; a centre PTY's own element). */
  el: HTMLElement;
  /** Set for a centre PTY the drawer had adopted. */
  hooks?: AdoptedHooks;
}

interface Tab {
  key: string;
  label: string;
  tip: string;
  view: TermView;
  el: HTMLElement;
  tab: HTMLElement;
  hooks?: AdoptedHooks;
}

export class Terminals {
  private tabs: Tab[] = [];
  private active: Tab | null = null;
  private counter = 0;
  /** A shell exited, wherever it sits (main.ts redraws the centre bar: it may be there). */
  onExit: () => void = () => {};

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

  /** The key of the shell `create` made last (it exists as soon as `create` is called). */
  get newestKey(): string {
    return `drawer:${this.counter}`;
  }

  /** New tab running the user's shell, or `command` (argv) labelled `label`; in `cwd` (a
   *  folder of the workspace) when given, else the workspace root. `o.hostEnv`: the program
   *  starts without the AppImage's environment; `o.onLeave`: called when the tab's terminal
   *  loses the focus and when its program exits (the file manager refreshes the Explorer). */
  async create(command?: string[], label?: string, cwd?: string, o: { hostEnv?: boolean; onLeave?: () => void } = {}) {
    const pane = h("div", { class: "term-pane" });
    this.host.append(pane);
    const view = new TermView(pane);
    const n = ++this.counter;
    const key = `drawer:${n}`;
    const name = label ?? `bash ${n}`;
    this.add({ key, label: name, view, el: pane }, command ? command.join(" ") : "");
    ttys.add({ key, place: "drawer", label: name, argv: command ?? null, root: cwd ?? this.root(), startedAt: Date.now() });
    view.onExit = (code) => {
      ttys.exited(key, code);
      this.refresh();
      this.onExit();
      o.onLeave?.();
    };
    if (o.onLeave) {
      const leave = o.onLeave;
      pane.addEventListener("focusout", (ev) => !pane.contains(ev.relatedTarget as Node | null) && leave());
    }
    view.term.onTitleChange((title) => ttys.update(key, { title: title.slice(0, 200) }));
    try {
      await view.spawn(command, cwd, o.hostEnv);
    } catch (e) {
      this.onError(`Terminal: ${errText(e)}`);
      ttys.exited(key, null);
      return;
    }
    ttys.update(key, { ptyId: view.id });
    this.fitActive();
  }

  /** A terminal moving in, alive: a shell coming back from the editor area (no hooks), or a
   *  centre PTY (its hooks). It becomes the drawer's active tab. */
  adopt(r: Released) {
    r.el.hidden = false;
    this.host.append(r.el);
    this.add(r, r.hooks?.tip ?? r.tip ?? "");
  }

  /** Take a terminal out of the drawer without stopping it (it moves to the editor area). */
  release(key: string): Released | null {
    const t = this.tabs.find((x) => x.key === key);
    if (!t) return null;
    this.drop(t);
    t.el.style.display = "";
    return { key: t.key, label: t.label, tip: t.tip, view: t.view, el: t.el, hooks: t.hooks };
  }

  private add(r: Released, tip: string): Tab {
    const tab = h("button", { class: "tab", title: tip });
    tab.dataset.key = r.key;
    const t: Tab = { key: r.key, label: r.label, tip, view: r.view, el: r.el, tab, hooks: r.hooks };
    this.renderTab(t);
    this.tabBar.insertBefore(tab, this.tabBar.querySelector(".tab-add"));
    tab.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest(".tab-close")) this.close(t);
      else this.show(t);
    });
    this.tabs.push(t);
    this.show(t);
    return t;
  }

  /** A tab's label, badge and close; an adopted PTY's classes come from its hooks. */
  private renderTab(t: Tab) {
    const hk = t.hooks;
    const extra = hk ? hk.cls() : t.view.exited ? "exited" : "";
    const cls = `tab${this.active === t ? " active" : ""}${extra ? ` ${extra}` : ""}`;
    const b = hk?.badge() ?? null;
    const sig = `${cls}|${b ? `${b.cls}:${b.text}` : ""}`;
    if (t.tab.dataset.sig === sig) return;
    t.tab.dataset.sig = sig;
    t.tab.className = cls;
    const close = h("span", { class: "tab-close", title: "Close terminal" }, "×");
    t.tab.replaceChildren(
      ...(hk?.icon ? [h("span", { class: "tab-icon" }, hk.icon())] : []),
      h("span", { class: "lbl" }, t.label),
      ...(b ? [h("span", { class: `badge ${b.cls}` }, b.text)] : []),
      close,
    );
  }

  /** Bring the gate badges and borders of the tabs up to date (main.ts renderTabs). */
  refresh() {
    for (const t of this.tabs) this.renderTab(t);
  }

  has(key: string): boolean {
    return this.tabs.some((x) => x.key === key);
  }

  /** The view of the terminal `key`, if the drawer holds it. */
  view(key: string): TermView | undefined {
    return this.tabs.find((x) => x.key === key)?.view;
  }

  /** The active tab's key ("" when the drawer is empty). */
  activeKey(): string {
    return this.active?.key ?? "";
  }

  /** Show the terminal `key` (the Terminals view's Focus, a focus by tab id); false if gone. */
  focusKey(key: string): boolean {
    const t = this.tabs.find((x) => x.key === key);
    if (!t) return false;
    this.show(t);
    return true;
  }

  private show(t: Tab) {
    this.active = t;
    // "" for the shown one: a pane is a block, a moved centre PTY's element keeps its flex.
    for (const x of this.tabs) x.el.style.display = x === t ? "" : "none";
    this.refresh();
    requestAnimationFrame(() => {
      this.fitActive();
      // A closed drawer keeps its bar: a shell closed there must not focus a hidden pane.
      if (this.host.clientHeight >= 20 && this.active === t) t.view.focus();
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

  /** Take `t` out of the bar and the list; the next tab becomes active. */
  private drop(t: Tab) {
    t.tab.remove();
    this.tabs = this.tabs.filter((x) => x !== t);
    if (this.active === t) {
      this.active = null;
      const next = this.tabs[this.tabs.length - 1];
      if (next) this.show(next);
    }
  }

  close(t: Tab) {
    t.el.style.display = "none";
    this.drop(t);
    if (t.hooks) {
      t.hooks.close();
      t.el.remove();
      return;
    }
    retireShell(t.key, t.view);
  }

  closeAll() {
    for (const t of [...this.tabs]) this.close(t);
  }
}

/** A drawer shell closes, wherever it sits: the last folder it was in is read before the
 *  process goes, then its Terminals row closes (Reopen starts a new drawer shell there) and
 *  the PTY is killed. */
export function retireShell(key: string, view: TermView) {
  const cwd = view.exited || view.id < 0 ? Promise.resolve(null) : api.ptyCwd(view.id).catch(() => null);
  void cwd.then((c) => {
    ttys.update(key, { place: "drawer", ...(c ? { cwd: c } : {}) });
    ttys.closed(key);
    view.dispose();
  });
}
