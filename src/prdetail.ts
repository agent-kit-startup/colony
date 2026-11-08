// PR detail, one centre tab per PR (plan colony-git-tab-forge-ux r4; git-cicd ADR amend
// 2026-11-08 point 4, operator answer `forge-ux-pr-detail-placement`: centre tab, one per PR).
// Conversation (title, body, author, labels), Checks (a structured list), Files (the PR's diff)
// and, at the bottom, the merge box: the blockers in words, the method the host rule fixes, the
// one action the PR's state allows, and the approval cards about this PR (the typed yes for a
// production base sits on the card). Before a promote the box runs `agent-kit promote rules`
// (advisory); after the promote's card merged it waits with `agent-kit promote wait`.
// Forge text is untrusted: text nodes only, the body through the Markdown renderer that never
// writes markup (src/docpreview.ts), lengths capped.
import { errText, h } from "./api";
import { renderDoc } from "./docpreview";
import { forgeApi } from "./forge";
import { diffLines } from "./gitgraph";
import { type Decision, type HostRequest, hostApi, requestPr } from "./hostreq";
import { isPromote, prMethod } from "./prgate";
import { authorName, checkBadge, checkRows, isBot, mergeBlockers, type PrAction, prAction, prState, stateTone } from "./prlist";
import type { MdLinkHandler } from "./transcript";
import { ago, btn, busy, chip, empty, iconBtn } from "./ui";

type J = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const TONE = { done: "chip-done", failed: "chip-failed", gate: "chip-gate", "": "" } as const;
const MAX_BODY = 40_000;

export interface PrDetailHost {
  status: (msg: string) => void;
  onLink: MdLinkHandler;
  onResolve: (n: number) => void;
  /** A card was filed: reveal it (it lands in this tab's merge box). */
  onCard: (id: string) => void;
  /** This tab's merge box holds the PR's cards while it is open. */
  attachBox: (n: number, box: HTMLElement) => void;
  detachBox: (n: number) => void;
  /** The tab's label, once the title is known. */
  setLabel: (label: string, tip: string) => void;
}

type Section = "conversation" | "checks" | "files";

export class PrDetailView {
  readonly el: HTMLElement;
  private head = h("div", { class: "prd-head" });
  private tabsEl = h("div", { class: "prd-tabs", role: "tablist" });
  private body = h("div", { class: "prd-body" });
  private box = h("section", { class: "card prd-merge" });
  private cardsEl = h("div", { class: "prd-cards" });
  private preflightEl = h("div", { class: "prd-preflight small" });
  private waitEl = h("div", { class: "prd-wait small", hidden: "" });
  private section: Section = "conversation";
  private pr: J | null = null;
  private diff: string | null = null;
  private preflight: "idle" | "running" | "done" = "idle";
  private refreshBtn: HTMLButtonElement;

  constructor(
    readonly n: number,
    private host: PrDetailHost,
  ) {
    this.refreshBtn = iconBtn("refresh", "", () => void this.reload(), { title: "Reload the PR (gh pr view)", "aria-label": "Reload the PR" });
    this.el = h("div", { class: "cv cv-pr" }, h("div", { class: "cv-body prd" }, this.head, this.tabsEl, this.body, this.box));
    this.el.dataset.pr = String(n);
    host.attachBox(n, this.cardsEl);
    this.head.replaceChildren(h("span", { class: "dim" }, `Loading PR #${n} (gh pr view)…`));
  }

  dispose() {
    this.host.detachBox(this.n);
  }

  async reload() {
    await busy(this.refreshBtn, "", async () => {
      try {
        this.pr = await forgeApi.prDetail(this.n);
        this.diff = null;
        this.render();
      } catch (e) {
        this.head.replaceChildren(h("div", { class: "hint warn" }, `PR #${this.n}: ${errText(e)}`), this.refreshBtn);
      }
    });
  }

  /** A card about this PR was decided (main.ts relays the Requests section's callback). */
  decided(r: HostRequest, d: Decision) {
    if (requestPr(r) !== this.n) return;
    void this.reload();
    const p = this.pr;
    if (r.kind === "merge-pr" && d.outcome === "succeeded" && p && isPromote(s(p.headRefName), s(p.baseRefName))) void this.waitPromote();
  }

  private render() {
    const p = this.pr;
    if (!p) return;
    const title = s(p.title).slice(0, 300);
    this.host.setLabel(`#${this.n} ${title.slice(0, 40)}`, `#${this.n} ${title}\n${s(p.baseRefName)} ← ${s(p.headRefName)}`);
    const state = s(p.state).toUpperCase();
    const st = state === "OPEN" ? prState(p) : state.toLowerCase();
    const fork = p.isCrossRepository !== false;
    const head = `${fork ? `${s((p.headRepositoryOwner as J | undefined)?.login) || "?"}:` : ""}${s(p.headRefName)}`;
    this.head.replaceChildren(
      h("div", { class: "row" }, h("strong", { class: "mono" }, `#${this.n}`), h("strong", { class: "grow prd-title", title }, title), this.refreshBtn),
      h(
        "div",
        { class: "row small" },
        chip(st, state === "OPEN" ? TONE[stateTone(prState(p))] : state === "MERGED" ? "chip-done" : ""),
        h("span", { class: "mono ellipsis", title: `${s(p.baseRefName)} ← ${head}` }, `${s(p.baseRefName)} ← ${head}`),
        ...(fork ? [chip("fork", "chip-failed")] : []),
        h("span", { class: "dim" }, `${authorName(p.author)} · opened ${ago(p.createdAt)}`),
        ...(isBot(p.author) ? [chip("Bot")] : []),
        ...(p.changedFiles !== undefined ? [h("span", { class: "dim mono" }, `${s(p.changedFiles)} files +${s(p.additions)} −${s(p.deletions)}`)] : []),
        ...(s(p.url).startsWith("https://") ? [btn("Open on the forge", () => this.host.onLink(s(p.url), "web"), { class: "link", "data-act": "web" })] : []),
      ),
    );
    this.renderTabs();
    this.renderSection();
    this.renderBox();
  }

  private renderTabs() {
    const p = this.pr;
    const c = checkBadge(p?.statusCheckRollup);
    const t = (id: Section, label: string) =>
      btn(label, () => {
        this.section = id;
        this.renderTabs();
        this.renderSection();
      }, { class: `prd-tab${this.section === id ? " on" : ""}`, role: "tab", "aria-selected": String(this.section === id), "data-section": id });
    this.tabsEl.replaceChildren(t("conversation", "Conversation"), t("checks", `Checks ${c.text}`), t("files", `Files${p?.changedFiles !== undefined ? ` ${s(p.changedFiles)}` : ""}`));
  }

  private renderSection() {
    const p = this.pr;
    if (!p) return;
    if (this.section === "conversation") {
      const labels = Array.isArray(p.labels) ? (p.labels as J[]).map((l) => s(l.name).slice(0, 60)).filter(Boolean) : [];
      const text = s(p.body).slice(0, MAX_BODY);
      this.body.replaceChildren(
        h("div", { class: "row small" }, h("span", { class: "dim" }, `Opened by ${authorName(p.author)}`), ...labels.map((l) => chip(l, "prd-label"))),
        text.trim() ? renderDoc(text, null, this.host.onLink) : empty("No description."),
      );
    } else if (this.section === "checks") {
      const rows = checkRows(p.statusCheckRollup);
      this.body.replaceChildren(
        rows.length
          ? h(
              "div",
              { class: "prd-checks" },
              ...rows.map((r) =>
                h(
                  "div",
                  { class: "row prd-check" },
                  chip(r.state, TONE[r.tone]),
                  h("span", { class: "grow ellipsis", title: r.name }, r.name),
                  h("span", { class: "dim mono small" }, r.duration),
                  ...(r.url ? [btn("Details", () => this.host.onLink(r.url, "web"), { class: "link", "data-act": "check-details", title: r.url })] : []),
                ),
              ),
            )
          : empty("No checks reported for the head commit."),
      );
    } else {
      const out = h("pre", { class: "git-out prd-diff" }, "Loading the diff (gh pr diff)…");
      this.body.replaceChildren(out);
      if (this.diff !== null) out.replaceChildren(...diffLines(this.diff || "(empty diff)"));
      else
        void forgeApi.prDiff(this.n).then(
          (d) => {
            this.diff = d;
            if (this.section === "files") out.replaceChildren(...diffLines(d || "(empty diff)"));
          },
          (e) => (out.textContent = errText(e)),
        );
    }
  }

  private file(kind: "merge-pr" | "update-branch" | "close-pr", what: string) {
    void hostApi.local(kind, { number: this.n }).then(
      (id) => {
        this.host.status(`${what} #${this.n}: approve it on its card in the merge box`);
        this.host.onCard(id);
      },
      (e) => this.host.status(errText(e)),
    );
  }

  private renderBox() {
    const p = this.pr;
    if (!p) return;
    const open = s(p.state).toUpperCase() === "OPEN";
    const headRef = s(p.headRefName);
    const base = s(p.baseRefName);
    const blockers = mergeBlockers(p);
    const action: PrAction | null = open ? prAction(prState(p)) : null;
    const promote = isPromote(headRef, base);
    const method = prMethod(headRef, base);
    const acts: HTMLElement[] = [];
    if (open) {
      if (action === "resolve") acts.push(btn("Resolve", () => this.host.onResolve(this.n), { "data-act": "resolve", title: "A worktree of this PR with the base merged in, and a terminal there with agent-kit conflicts proposals" }));
      if (action === "update-branch") acts.push(btn("Update branch", () => this.file("update-branch", "Update branch"), { "data-act": "update-branch" }));
      const merge = btn(promote ? "Merge (promote)…" : "Merge…", () => this.file("merge-pr", "Merge"), { class: "primary", "data-act": "merge", title: "Files a merge card here; a production base needs your typed yes on it" });
      // Merge only when nothing blocks it; a promote also waits for its ruleset preflight.
      merge.disabled = action !== "merge" || blockers.length > 0 || (promote && this.preflight !== "done");
      acts.push(merge, btn("Close PR", () => this.file("close-pr", "Close"), { "data-act": "close", title: "Files a close-pr card (the branch is kept, so a reopen undoes it)" }));
    }
    const methodWhy = method === "merge" ? (promote ? "the promote keeps main an ancestor of staging" : "the staging sync keeps main an ancestor of staging") : "every PR other than the promote and the staging sync is squashed";
    this.box.replaceChildren(
      h("div", { class: "card-title" }, "Merge"),
      blockers.length ? h("ul", { class: "prd-blockers" }, ...blockers.map((b) => h("li", {}, b))) : h("div", { class: "hint" }, open ? "Nothing blocks the merge." : ""),
      h("div", { class: "row small" }, h("span", { class: "dim" }, "Method"), chip(method === "merge" ? "merge commit" : "squash"), h("span", { class: "dim" }, `fixed by the host rule: ${methodWhy}`)),
      ...(["main", "master", "production", "prod", "release"].includes(base) ? [h("div", { class: "hint warn small" }, `${base} is production: the merge card asks for your typed yes.`)] : []),
      ...(promote && open ? [this.preflightEl] : []),
      this.waitEl,
      h("div", { class: "actions" }, ...acts),
      this.cardsEl,
    );
    this.el.dataset.blockers = String(blockers.length);
    if (promote && open && this.preflight === "idle") void this.runPreflight(base);
  }

  /** `agent-kit promote rules`: the base branch rules the kit does not model (advisory). */
  private async runPreflight(base: string) {
    this.preflight = "running";
    this.preflightEl.replaceChildren(h("span", { class: "dim" }, `Ruleset preflight: agent-kit promote rules --base ${base}…`));
    try {
      const r = (await forgeApi.promoteRules(base)) as J;
      const unmodeled = Array.isArray(r.unmodeled) ? (r.unmodeled as unknown[]) : [];
      const line = (x: unknown) => {
        const u = (x ?? {}) as J;
        return `${s(u.name)}${u.value === undefined ? "" : ` = ${JSON.stringify(u.value)}`}${u.rulesetId === undefined ? "" : ` (ruleset ${s(u.rulesetId)})`}`.slice(0, 200);
      };
      this.preflightEl.replaceChildren(
        r.ok === false
          ? h("div", { class: "hint warn" }, `Ruleset preflight could not read the rules of ${base}: ${s(r.note).slice(0, 300)}. Check them on the forge before you merge.`)
          : unmodeled.length
            ? h("div", { class: "hint warn" }, h("div", {}, `${base} has ${unmodeled.length} rule parameter(s) the kit does not model; the forge may refuse the merge:`), h("ul", {}, ...unmodeled.map((u) => h("li", { class: "mono" }, line(u)))))
            : h("div", { class: "hint" }, `Ruleset preflight: every rule on ${base} is one the kit models.`),
      );
    } catch (e) {
      this.preflightEl.replaceChildren(h("div", { class: "hint warn" }, `Ruleset preflight: ${errText(e)}`));
    }
    this.preflight = "done";
    this.renderBox();
  }

  /** After the promote's card merged: `agent-kit promote wait` until the forge says merged. */
  private async waitPromote() {
    this.waitEl.hidden = false;
    this.waitEl.replaceChildren(h("span", { class: "dim" }, `Waiting for the forge to report #${this.n} merged (agent-kit promote wait, up to 10 min)…`));
    try {
      const r = (await forgeApi.promoteWait(this.n)) as J;
      const outcome = s(r.outcome);
      this.waitEl.replaceChildren(h("div", { class: outcome === "merged" ? "hint" : "hint warn" }, outcome === "merged" ? `#${this.n} is merged on the forge. Next: the tag and the staging sync (Ship lane).` : `agent-kit promote wait: ${outcome || "no answer"}${r.lastError ? ` (${s(r.lastError).slice(0, 200)})` : ""}${outcome === "timeout" ? ": the forge has not reported the merge yet; check the PR" : ""}.`));
    } catch (e) {
      this.waitEl.replaceChildren(h("div", { class: "hint warn" }, `agent-kit promote wait: ${errText(e)}`));
    }
    void this.reload();
  }
}
