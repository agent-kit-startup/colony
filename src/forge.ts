// Forge views (src-tauri/src/forge.rs) through the operator's own `gh`: the Git tab's
// "Pull requests" card in the forge style (state and action from src/prlist.ts; Merge, Update
// branch and Close go through the same approval cards and production rule as an agent's
// request) and the CI/CD center tab (workflow runs, rerun failed jobs).
// Colony reads no token: when gh is missing or logged out, the views say so.
import { invoke } from "@tauri-apps/api/core";
import { api, errText, h } from "./api";
import { hostApi } from "./hostreq";
import { authorName, authors, bulkTargets, checkBadge, filterPrs, isBot, NO_FILTER, type PrAction, type PrFilter, type PrWorktree, prAction, prState, stateTone } from "./prlist";
import { ago, btn, busy, card, chip, empty, iconBtn, rerender } from "./ui";

export interface ForgeStatus { provider: string; bin: string | null; authenticated: boolean; detail: string }
type J = Record<string, unknown>;

export const forgeApi = {
  status: () => invoke<ForgeStatus>("forge_status"),
  prs: () => invoke<J[]>("forge_prs"),
  runs: (branch?: string) => invoke<J[]>("forge_runs", { branch: branch ?? null }),
  rerunFailed: (runId: number) => invoke<string>("forge_rerun_failed", { runId }),
  /** Resolve: the PR's worktree with the base merged in (src-tauri/src/prworktree.rs). */
  prWorktree: (number: number) => invoke<PrWorktree>("forge_pr_worktree", { number }),
  /** The PR detail tab (src/prdetail.ts). */
  prDetail: (number: number) => invoke<J>("forge_pr_detail", { number }),
  prDiff: (number: number) => invoke<string>("forge_pr_diff", { number }),
  /** agent-kit promote rules / wait (read-only kit helpers, kit #1417 and #1418). */
  promoteRules: (base: string) => invoke<J>("kit_promote_rules", { base }),
  promoteWait: (number: number) => invoke<J>("kit_promote_wait", { number }),
};

const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const FAILED = new Set(["failure", "cancelled", "timed_out", "startup_failure", "action_required"]);

/** The forge CLI state as a card body, or null when gh is ready. */
function forgeProblem(st: ForgeStatus): HTMLElement | null {
  if (!st.bin) return empty(`${st.detail} (Colony uses your own gh; it never stores a token).`);
  if (!st.authenticated) return h("div", { class: "hint warn", title: st.detail }, "gh is not logged in: run gh auth login in a terminal, then refresh.");
  return null;
}

/** What the PR list asks of the window (main.ts). */
export interface PrListHost {
  status: (msg: string) => void;
  /** A card was filed: scroll the Requests list to it. */
  onCard: (id: string) => void;
  /** Resolve on a conflicting PR: a worktree with the base merged in, then a terminal. */
  onResolve: (n: number) => void;
  /** Open the PR's detail (a centre tab); unset: the number is plain text. */
  onOpen?: (n: number) => void;
}

const ACTION_LABEL: Record<PrAction, string> = { resolve: "Resolve", "update-branch": "Update branch", merge: "Merge" };
const ACTION_TIP: Record<PrAction, string> = {
  resolve: "Conflicts with the base: opens a worktree of this PR beside your checkout with the base merged in, and a terminal there with agent-kit conflicts proposals",
  "update-branch": "Behind the base: files an update-branch card (gh pr update-branch, a merge on the forge)",
  merge: "Ready: files a merge card (method fixed by the host rule; a production base needs a typed yes)",
};

/**
 * Git tab: the open pull requests in the forge style (plan colony-git-tab-forge-ux r3). One row
 * per PR: number, title, author, age, a Bot chip, one check badge and one state chip, and the
 * single action its state allows. Filters: author, bot or human, needs action. Bulk selection
 * files update-branch and close-pr cards, one per PR and one after another; a merge is never
 * a bulk action (git-cicd ADR amend 2026-11-08 point 1). Branch names live in the PR detail.
 */
export class PullRequestsSection {
  readonly el: HTMLElement;
  private body = h("div", { class: "hostreq-prs pr-list" });
  private filtersEl = h("div", { class: "pr-filters" });
  private bulkEl = h("div", { class: "pr-bulk", hidden: "" });
  private loading = false;
  private refreshBtn: HTMLButtonElement;
  private prs: J[] = [];
  private filter: PrFilter = { ...NO_FILTER };
  private selected = new Set<number>();

  constructor(private host: PrListHost) {
    this.refreshBtn = iconBtn("refresh", "", () => this.refresh(), { title: "Refresh (gh pr list)", "aria-label": "Refresh pull requests" });
    this.el = card(h("span", { class: "grow" }, "Pull requests"), this.filtersEl, this.bulkEl, this.body);
    this.el.querySelector(".card-title")?.append(h("span", { class: "spacer" }), this.refreshBtn);
    this.el.classList.add("forge-prs");
  }

  refresh() {
    if (this.loading) return;
    this.loading = true;
    void busy(this.refreshBtn, "", () => this.load()).finally(() => (this.loading = false));
  }

  private async load() {
    try {
      const st = await forgeApi.status();
      const problem = forgeProblem(st);
      if (problem) {
        this.prs = [];
        this.filtersEl.replaceChildren();
        return this.body.replaceChildren(problem);
      }
      this.prs = await forgeApi.prs();
      const open = new Set(this.prs.map((p) => Number(p.number)));
      for (const n of [...this.selected]) if (!open.has(n)) this.selected.delete(n);
      if (this.filter.author && !authors(this.prs).includes(this.filter.author)) this.filter.author = "";
      this.render();
    } catch (e) {
      this.body.replaceChildren(h("div", { class: "hint warn" }, errText(e)));
    }
  }

  private render() {
    this.renderFilters();
    this.renderBulk();
    const shown = filterPrs(this.prs, this.filter);
    const none = this.prs.length ? "No pull request matches these filters." : "No open pull requests.";
    rerender(this.el, () => this.body.replaceChildren(...(shown.length ? shown.map((p) => this.row(p)) : [empty(none)])));
  }

  private renderFilters() {
    if (!this.prs.length) return this.filtersEl.replaceChildren();
    const author = h("select", { class: "pr-author", "aria-label": "Author", "data-filter": "author" }, h("option", { value: "" }, "All authors"), ...authors(this.prs).map((a) => h("option", { value: a }, a.slice(0, 60))));
    author.value = this.filter.author;
    author.addEventListener("change", () => {
      this.filter.author = author.value;
      this.render();
    });
    const who = (id: PrFilter["who"], label: string) =>
      btn(label, () => {
        this.filter.who = id;
        this.render();
      }, { class: `pr-filter${this.filter.who === id ? " on" : ""}`, "data-filter": `who-${id}`, "aria-pressed": String(this.filter.who === id) });
    const needs = h("input", { type: "checkbox", "data-filter": "needs-action", ...(this.filter.needsAction ? { checked: "" } : {}) });
    needs.addEventListener("change", () => {
      this.filter.needsAction = needs.checked;
      this.render();
    });
    this.filtersEl.replaceChildren(author, h("span", { class: "pr-who" }, who("all", "All"), who("bot", "Bot"), who("human", "Human")), h("label", { class: "check small" }, needs, " Needs action"));
  }

  private renderBulk() {
    const n = this.selected.size;
    this.bulkEl.hidden = !n;
    if (!n) return this.bulkEl.replaceChildren();
    const upd = bulkTargets(this.prs, this.selected, "update-branch");
    const close = bulkTargets(this.prs, this.selected, "close-pr");
    const ub = btn(`Update branch (${upd.length})`, () => void this.bulk("update-branch", upd, ub), { "data-act": "bulk-update-branch", title: "One update-branch card per selected PR that is behind its base, filed one after another" });
    ub.disabled = !upd.length;
    const cl = btn(`Close (${close.length})`, () => void this.bulk("close-pr", close, cl), { "data-act": "bulk-close", title: "One close-pr card per selected PR (branches kept, so a reopen undoes it)" });
    const clear = btn("Clear", () => {
      this.selected.clear();
      this.render();
    }, { class: "link", "data-act": "bulk-clear" });
    this.bulkEl.replaceChildren(h("span", { class: "grow" }, `${n} selected`), ub, cl, clear, h("span", { class: "dim small" }, "Merges run one PR at a time"));
  }

  /** One card per PR, one after another (never a loop of merges). */
  private async bulk(kind: "update-branch" | "close-pr", numbers: number[], b: HTMLButtonElement) {
    await busy(b, "Filing…", async () => {
      let filed = 0;
      let last = "";
      for (const n of numbers) {
        try {
          last = await hostApi.local(kind, { number: n });
          filed++;
        } catch (e) {
          this.host.status(`#${n}: ${errText(e)}`);
        }
      }
      if (filed) {
        this.host.status(`${filed} ${kind} card(s) filed: approve each under Requests`);
        this.host.onCard(last);
      }
      this.selected.clear();
    });
    this.render();
  }

  private act(p: J, a: PrAction) {
    const n = Number(p.number);
    if (a === "resolve") return this.host.onResolve(n);
    void hostApi.local(a === "merge" ? "merge-pr" : "update-branch", { number: n }).then(
      (id) => {
        this.host.status(`${ACTION_LABEL[a]} #${n}: approve it on its card under Requests`);
        this.host.onCard(id);
      },
      (e) => this.host.status(errText(e)),
    );
  }

  private row(p: J): HTMLElement {
    const n = Number(p.number);
    const state = prState(p);
    const action = prAction(state);
    const checks = checkBadge(p.statusCheckRollup);
    const bot = isBot(p.author);
    const title = s(p.title).slice(0, 200);
    const sel = h("input", { type: "checkbox", class: "pr-select", "aria-label": `Select #${n}`, ...(this.selected.has(n) ? { checked: "" } : {}) });
    sel.addEventListener("change", () => {
      if (sel.checked) this.selected.add(n);
      else this.selected.delete(n);
      el.classList.toggle("is-selected", sel.checked);
      this.renderBulk();
    });
    const num = this.host.onOpen ? btn(`#${n}`, () => this.host.onOpen?.(n), { class: "link mono pr-num", "data-act": "open", title: "Open the PR" }) : h("strong", { class: "mono pr-num" }, `#${n}`);
    const badge = chip(checks.text, checks.tone ? `chip-${checks.tone}` : "");
    badge.classList.add("pr-checks");
    badge.title = checks.failing.length ? `failing: ${checks.failing.join(", ")}` : checks.pending ? `${checks.pending} running` : checks.total ? "all checks passed" : "no checks reported";
    const stateChip = chip(state, ({ done: "chip-done", failed: "chip-failed", gate: "chip-gate", "": "" } as const)[stateTone(state)]);
    stateChip.classList.add("pr-state");
    const acts = action ? [btn(ACTION_LABEL[action], () => this.act(p, action), { class: action === "merge" ? "primary" : "", "data-act": action, title: ACTION_TIP[action] })] : [];
    const el = h(
      "div",
      { class: `pr-row${this.selected.has(n) ? " is-selected" : ""}`, tabindex: "-1" },
      sel,
      num,
      h("span", { class: "pr-title ellipsis", title }, title),
      h("span", { class: "pr-meta dim small ellipsis", title: s((p.author as J | undefined)?.login) }, `${authorName(p.author)} · ${ago(p.createdAt)}`),
      ...(bot ? [chip("Bot", "pr-bot")] : []),
      badge,
      stateChip,
      h("span", { class: "pr-act" }, ...acts),
    );
    el.dataset.pr = String(n);
    el.dataset.state = state;
    return el;
  }
}

/** CI/CD center tab: recent workflow runs (this branch, open PR branches, or all). */
export class CicdView {
  readonly el = h("div", { class: "cv cv-cicd" });
  private body = h("div", { class: "cv-body" });
  private mode: "branch" | "prs" | "all" = "branch";
  private filters = h("div", { class: "filters" });
  private list = h("div", { class: "cicd-runs" });
  private note = h("div", { class: "hint" });
  visible = false;

  constructor(private status: (msg: string) => void) {
    const refresh: HTMLButtonElement = iconBtn("refresh", "Refresh", () => void busy(refresh, "", () => this.load()), { title: "gh run list" });
    this.el.append(this.body);
    this.body.append(card(h("span", { class: "grow" }, "Workflow runs"), h("div", { class: "row" }, this.filters, h("span", { class: "spacer" }), refresh), this.note, this.list));
    this.renderFilters();
  }

  show() {
    this.visible = true;
    void this.load();
  }

  hide() {
    this.visible = false;
  }

  private renderFilters() {
    const f = (id: typeof this.mode, label: string) => {
      const b = btn(label, () => {
        this.mode = id;
        this.renderFilters();
        void this.load();
      }, { class: `filter ${this.mode === id ? "on" : ""}`, "data-filter": id });
      return b;
    };
    this.filters.replaceChildren(f("branch", "This branch"), f("prs", "Open PRs"), f("all", "All"));
  }

  async load() {
    try {
      const st = await forgeApi.status();
      const problem = forgeProblem(st);
      if (problem) {
        this.note.textContent = "";
        return this.list.replaceChildren(problem);
      }
      let runs: J[];
      if (this.mode === "branch") {
        const branch = (await api.gitStatus().catch(() => null))?.branch;
        this.note.textContent = branch ? `Runs of ${branch}` : "Runs (no branch checked out)";
        runs = await forgeApi.runs(branch && branch !== "HEAD" ? branch : undefined);
      } else if (this.mode === "prs") {
        const heads = new Set((await forgeApi.prs()).map((p) => s(p.headRefName)));
        runs = (await forgeApi.runs()).filter((r) => heads.has(s(r.headBranch)));
        this.note.textContent = `Runs of the ${heads.size} open pull request branches`;
      } else {
        runs = await forgeApi.runs();
        this.note.textContent = "Recent runs, every branch";
      }
      rerender(this.el, () => this.list.replaceChildren(...(runs.length ? runs.map((r) => this.row(r)) : [empty("No workflow runs.")])));
    } catch (e) {
      this.list.replaceChildren(h("div", { class: "hint warn" }, errText(e)));
    }
  }

  private row(r: J): HTMLElement {
    const id = Number(r.databaseId);
    const concl = s(r.conclusion);
    const state = concl || s(r.status);
    const cls = concl === "success" ? "chip-done" : FAILED.has(concl) ? "chip-failed" : concl ? "" : "chip-running";
    const acts: HTMLElement[] = [];
    if (FAILED.has(concl)) {
      const b = btn(
        "Rerun failed",
        () => {
          b.disabled = true;
          void forgeApi.rerunFailed(id).then(
            (out) => {
              this.status(`Run ${id}: rerun of the failed jobs requested`);
              b.textContent = "Rerun requested";
              b.title = out;
            },
            (e) => {
              b.disabled = false;
              this.status(errText(e));
            },
          );
        },
        { "data-act": "rerun", title: "gh run rerun <id> --failed" },
      );
      acts.push(b);
    }
    const el = h(
      "div",
      { class: "row cicd-run" },
      chip(state.replace(/_/g, " ") || "?", cls),
      h("span", { class: "ellipsis grow", title: `${s(r.workflowName)} · ${s(r.displayTitle)}` }, h("strong", {}, s(r.workflowName)), ` · ${s(r.displayTitle)}`),
      h("span", { class: "mono dim small ellipsis", title: s(r.headSha) }, `${s(r.headBranch)} · ${s(r.event)}`),
      h("span", { class: "dim small" }, ago(r.createdAt)),
      ...acts,
    );
    el.dataset.run = String(id);
    return el;
  }
}
