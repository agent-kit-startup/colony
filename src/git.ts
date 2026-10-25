// Git panel: status, per-file diff, commit, push. A production branch push needs a typed yes.
import { icon } from "./icons";
import { api, errText, h, type GitStatus } from "./api";
import { obj, snapshot, str } from "./snapshot";
import { type ShipHost, ShipLaneTile } from "./shiplane";
import { btn, busy, card, chip, empty, iconBtn } from "./ui";

const clock = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export class GitPanel {
  private branch = h("strong");
  private header = h("span", { class: "dim" });
  private checked = h("span", { class: "dim small" });
  private refreshBtn: HTMLButtonElement;
  private files = h("div", { class: "git-files" });
  // The clicked file's diff, right under the list; the commit / push result, right under the buttons.
  private diffTitle = h("div", { class: "git-diff-title mono small ellipsis" });
  private diffOut = h("pre", { class: "git-out" });
  private diffBox = h("div", { class: "git-diff", hidden: "" }, this.diffTitle, this.diffOut);
  private msg = h("textarea", { rows: "3", placeholder: "Commit message (Conventional Commits)" });
  private stageAll = h("input", { type: "checkbox", checked: "" });
  private commitBtn = h("button", { class: "primary" }, "Commit");
  private pushBtn = h("button", {}, "Push");
  private prodBox = h("div", { class: "prod-confirm", hidden: "" });
  private yes = h("input", { type: "text", placeholder: "type yes" });
  private resultTitle = h("div", { class: "git-result-title" });
  private out = h("pre", { class: "git-out" });
  private result = h("div", { class: "git-result", hidden: "", role: "status" }, this.resultTitle, this.out);
  private last: GitStatus | null = null;
  private shown = "";
  private selected = "";
  private loading: Promise<void> | null = null;
  private again = false;

  constructor(root: HTMLElement, private status: (msg: string) => void, private onCommitted: () => void) {
    this.refreshBtn = iconBtn("refresh", "", () => void this.refresh(), { title: "Refresh git status", "aria-label": "Refresh git status" });
    this.prodBox.append(h("span", {}, "Production push: "), this.yes);
    root.append(
      h("div", { class: "panel-row" }, this.branch, this.header, h("span", { class: "spacer" }), this.checked, this.refreshBtn),
      this.files,
      this.diffBox,
      this.msg,
      h("label", { class: "check" }, this.stageAll, " Stage all changes (git add -A)"),
      h("div", { class: "panel-row" }, this.commitBtn, this.pushBtn),
      this.prodBox,
      this.result,
    );
    this.commitBtn.addEventListener("click", () => void this.commit());
    this.pushBtn.addEventListener("click", () => void this.push());
  }

  /** Reload git status. Calls made while one runs fold into a single reload after it. */
  refresh(): Promise<void> {
    if (this.loading) {
      this.again = true;
      return this.loading;
    }
    this.loading = busy(this.refreshBtn, "", () => this.load()).finally(() => {
      this.loading = null;
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.loading;
  }

  private async load() {
    try {
      const s = await api.gitStatus();
      this.last = s;
      this.checked.textContent = `checked ${clock()}`;
      if (!s.isRepo) {
        this.branch.textContent = "Not a git repository";
        this.header.textContent = "";
        this.files.replaceChildren();
        this.shown = "";
        return;
      }
      this.branch.textContent = s.branch;
      this.header.textContent = s.header.replace(/^[^.]+(\.\.\.)?/, "").trim();
      this.prodBox.hidden = !s.prodBranch;
      // A push in flight owns its button label (spinner); the next reload sets it.
      if (!this.pushBtn.classList.contains("is-busy")) this.pushBtn.textContent = s.prodBranch ? `Push ${s.branch} (production)` : "Push";
      // Same list as on screen: keep the rows (hover, selection, scroll) instead of rebuilding them.
      const key = JSON.stringify(s.files);
      if (key === this.shown) return;
      this.shown = key;
      const target = (p: string) => (p.includes(" -> ") ? p.split(" -> ")[1] : p);
      if (this.selected && !s.files.some((f) => target(f.path) === this.selected)) this.closeDiff();
      const rows = s.files.map((f) => {
        const path = target(f.path);
        const r = h("div", { class: `git-file${path === this.selected ? " is-selected" : ""}`, title: f.path }, h("code", { class: "xy" }, f.xy.replace(/ /g, "·")), h("span", {}, f.path));
        r.dataset.path = path;
        r.addEventListener("click", () => void this.showDiff(path));
        return r;
      });
      this.files.replaceChildren(...(rows.length ? rows : [h("div", { class: "dim" }, "Working tree clean")]));
    } catch (e) {
      this.show("Could not read git status", errText(e), "err", false);
    }
  }

  private markSelected() {
    for (const r of this.files.querySelectorAll<HTMLElement>(".git-file")) r.classList.toggle("is-selected", r.dataset.path === this.selected);
  }

  private closeDiff() {
    this.selected = "";
    this.diffBox.hidden = true;
    this.markSelected();
  }

  private async showDiff(path: string) {
    if (this.selected === path && !this.diffBox.hidden) return this.closeDiff();
    this.selected = path;
    this.markSelected();
    this.diffTitle.textContent = `${path} · loading diff…`;
    this.diffOut.replaceChildren();
    this.diffBox.hidden = false;
    this.diffBox.scrollIntoView({ block: "nearest" });
    try {
      const diff = await api.gitDiff(path);
      if (this.selected !== path) return;
      this.diffTitle.textContent = `${path} · click the file again to close`;
      this.renderDiff(diff || "(no diff against HEAD: new or untracked file)");
    } catch (e) {
      if (this.selected === path) this.diffOut.textContent = errText(e);
    }
  }

  private renderDiff(text: string) {
    this.diffOut.replaceChildren(
      ...text.split("\n").map((line) => {
        const cls = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : "";
        return h("div", { class: cls }, line);
      }),
    );
  }

  /** The last action's outcome under the buttons, in view: a title line, then git's own output. */
  private show(title: string, text: string, tone: "ok" | "err" | "", scroll = true) {
    this.result.className = `git-result${tone ? ` is-${tone}` : ""}`;
    this.resultTitle.textContent = `${title} · ${clock()}`;
    this.out.textContent = text.trim();
    this.result.hidden = false;
    if (scroll) this.result.scrollIntoView({ block: "nearest" });
  }

  private async commit() {
    const message = this.msg.value.trim();
    if (!message) {
      this.show("Nothing committed", "Write a commit message first.", "err");
      this.msg.focus();
      return;
    }
    this.show("Committing… (hooks run)", "", "");
    await busy(this.commitBtn, "Committing…", async () => {
      try {
        const out = await api.gitCommit(message, this.stageAll.checked);
        this.msg.value = "";
        this.show("Committed", out, "ok");
        this.status("Committed");
        this.onCommitted();
      } catch (e) {
        this.show("Commit failed", errText(e), "err");
        this.status("Commit failed: see the Working tree card");
      }
    });
    await this.refresh();
  }

  private async push() {
    const prod = this.last?.prodBranch ?? false;
    if (prod && this.yes.value.trim() !== "yes") {
      this.show("Not pushed", `Pushing ${this.last?.branch} is a production promotion. Type yes in the box to confirm.`, "err");
      this.yes.focus();
      return;
    }
    const branch = this.last?.branch ?? "";
    this.show(`Pushing ${branch}… (pre-push hooks run)`, "", "");
    await busy(this.pushBtn, prod ? "Pushing (production)…" : "Pushing…", async () => {
      try {
        const out = await api.gitPush(prod ? this.yes.value.trim() : undefined);
        this.show(`Pushed ${branch}`, out || "Pushed.", "ok");
        this.status(`Pushed ${branch}`);
      } catch (e) {
        this.show("Push failed", errText(e), "err");
        this.status("Push failed: see the Working tree card");
      } finally {
        this.yes.value = "";
      }
    });
    await this.refresh();
  }
}

/**
 * Git e CI/CD center tab, one bento grid like the web panel's section of the same name: the
 * Ship lane tile leads (snapshot `shipLane`, with the host-allowlist actions), then Requests,
 * Pull requests, the snapshot's branch flow and graph, the working tree and the production
 * promotion card. Colony never runs /git-prod or any prod promotion: the card only reveals
 * the command after a typed yes, for the operator's own agent session.
 */
export class GitView {
  readonly el: HTMLElement;
  readonly panel: GitPanel;
  readonly ship: ShipLaneTile;
  private repo = h("div", { class: "git-repo bento-tile bento-flow" });
  private grid: HTMLElement;
  private extras: { el: HTMLElement; refresh?: () => void }[] = [];
  private dirty = true;
  visible = false;

  constructor(status: (msg: string) => void, onCommitted: () => void, private copy: (text: string, what: string) => void, ship: ShipHost) {
    const work = h("section", { class: "card git-work bento-tile bento-work" }, h("div", { class: "card-title" }, "Working tree"));
    this.panel = new GitPanel(work, status, onCommitted);
    this.ship = new ShipLaneTile(ship);
    this.grid = h("div", { class: "cv-body git-bento", "aria-label": "Git e CI/CD" }, this.ship.el, this.repo, work, this.prodCard());
    this.el = h("div", { class: "cv cv-git" }, this.grid);
    snapshot.on((why) => {
      if (why !== "data") return;
      this.dirty = true;
      if (this.visible) this.renderRepo();
      // The snapshot carries the repo's git state: when it moved (a commit, a checkout, an
      // edit from a terminal or an agent) the Working tree reloads without a click.
      const sig = this.gitSig();
      if (sig === this.lastSig) return;
      this.lastSig = sig;
      if (this.visible) void this.panel.refresh();
    });
    // Back from another window (an outside terminal or editor): what changed there shows on
    // return. Colony's own terminal is this window; its changes come through the snapshot
    // signature above, which Mission Control recomputes on its periodic refresh (<=15 s).
    window.addEventListener("focus", () => {
      if (this.visible) void this.panel.refresh();
    });
  }

  private lastSig = "";

  private gitSig(): string {
    const g = snapshot.git;
    return JSON.stringify([g.branch, g.dirty, g.dirtyCount, g.lastCommit, g.ahead, g.behind]);
  }

  /** Extra tiles right after the Ship lane (host requests, pull requests), refreshed on show. */
  addSections(...extras: { el: HTMLElement; refresh?: () => void }[]) {
    this.extras.push(...extras);
    for (const x of extras) x.el.classList.add("bento-tile", "bento-side");
    this.ship.el.after(...extras.map((x) => x.el));
  }

  show() {
    this.visible = true;
    if (this.dirty) this.renderRepo();
    void this.panel.refresh();
    for (const x of this.extras) x.refresh?.();
  }

  hide() {
    this.visible = false;
  }

  /** Reload after a git / forge action ran from here (a merged PR leaves the list); a hidden tab reloads on show. */
  reload() {
    if (this.visible) this.show();
  }

  private renderRepo() {
    this.dirty = false;
    this.ship.render();
    const g = snapshot.git;
    if (!snapshot.data) {
      this.repo.replaceChildren(card("Repository", empty("Waiting for Mission Control data…")));
      return;
    }
    const flow = obj(g.flow);
    const ab = (label: string, x: unknown) => {
      const o = obj(x);
      return o.ahead === undefined && o.behind === undefined ? null : h("div", { class: "row" }, h("span", { class: "dim grow" }, label), h("span", { class: "mono" }, `↑${o.ahead ?? 0} ↓${o.behind ?? 0}`));
    };
    const graph: string[] = Array.isArray(g.graph) ? g.graph.map(String) : [];
    const sameCount = (a: unknown, b: unknown) => {
      const x = obj(a);
      const y = obj(b);
      return x.ahead !== undefined && x.ahead === y.ahead && x.behind === y.behind;
    };
    this.repo.replaceChildren(
      card(
        "Repository",
        h("div", { class: "row" }, h("strong", { class: "git-branch" }, icon("git", "btn-icon"), str(g.branch, "?")), chip(g.dirty ? `${g.dirtyCount ?? "?"} changed` : "clean", g.dirty ? "chip-gate" : "chip-done"), h("span", { class: "dim" }, `↑${g.ahead ?? 0} ↓${g.behind ?? 0} upstream`)),
        ...(g.lastCommit ? [h("div", { class: "mono small ellipsis", title: str(g.lastCommit) }, str(g.lastCommit))] : []),
        // On staging, "vs main" and "staging vs main" are the same count: show it once.
        ...[ab("vs staging", flow.vsStaging), ab("vs main", flow.vsMain), sameCount(flow.vsMain, flow.stagingVsMain) ? null : ab("staging vs main", flow.stagingVsMain)].filter((x): x is HTMLDivElement => !!x),
        // One line per graph row, cut by width with the full line in its title (no inner
        // horizontal scroll, no fixed height).
        ...(graph.length ? [h("div", { class: "git-graph" }, ...graph.slice(0, 40).map((l) => h("div", { class: "git-graph-line", title: l }, l)))] : []),
      ),
    );
  }

  private prodCard(): HTMLElement {
    const yes = h("input", { type: "text", placeholder: "type yes", class: "yes" });
    const out = h("div", { class: "hint" });
    const reveal = btn("Show /git-prod", () => {
      if (yes.value.trim() !== "yes") {
        out.textContent = "Production promotion: type yes first. Colony shows the command; it never runs it.";
        return;
      }
      out.replaceChildren(h("code", {}, "/git-prod"), " copied. Paste it in your own agent session (Open interactive in Mission) and answer its gate there.");
      this.copy("/git-prod", "/git-prod");
      yes.value = "";
    });
    return h(
      "section",
      { class: "card prod-card bento-tile bento-prod" },
      h("div", { class: "card-title" }, "Production promotion"),
      h("div", { class: "hint warn" }, "Never run from Colony or from a headless tick. /git-prod stays an operator action in your own agent session."),
      h("div", { class: "prod-confirm" }, yes, reveal),
      out,
    );
  }
}
