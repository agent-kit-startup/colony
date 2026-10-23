// Forge views (src-tauri/src/forge.rs) through the operator's own `gh`: the Git tab's
// "Pull requests" card (Merge goes through the same approval card and production rule as
// an agent's request) and the CI/CD center tab (workflow runs, rerun failed jobs).
// Colony reads no token: when gh is missing or logged out, the views say so.
import { invoke } from "@tauri-apps/api/core";
import { api, errText, h } from "./api";
import { hostApi } from "./hostreq";
import { ago, btn, card, chip, empty, iconBtn, rerender } from "./ui";

export interface ForgeStatus { provider: string; bin: string | null; authenticated: boolean; detail: string }
type J = Record<string, unknown>;

export const forgeApi = {
  status: () => invoke<ForgeStatus>("forge_status"),
  prs: () => invoke<J[]>("forge_prs"),
  runs: (branch?: string) => invoke<J[]>("forge_runs", { branch: branch ?? null }),
  rerunFailed: (runId: number) => invoke<string>("forge_rerun_failed", { runId }),
};

const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const FAILED = new Set(["failure", "cancelled", "timed_out", "startup_failure", "action_required"]);

/** The forge CLI state as a card body, or null when gh is ready. */
function forgeProblem(st: ForgeStatus): HTMLElement | null {
  if (!st.bin) return empty(`${st.detail} (Colony uses your own gh; it never stores a token).`);
  if (!st.authenticated) return h("div", { class: "hint warn", title: st.detail }, "gh is not logged in: run gh auth login in a terminal, then refresh.");
  return null;
}

/** statusCheckRollup → pass / fail / pending counts. */
export function checksSummary(rollup: unknown): { pass: number; fail: number; pending: number } {
  const out = { pass: 0, fail: 0, pending: 0 };
  for (const c of Array.isArray(rollup) ? (rollup as J[]) : []) {
    const state = s(c.conclusion || c.state).toUpperCase();
    if (c.status && s(c.status).toUpperCase() !== "COMPLETED") out.pending++;
    else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state)) out.pass++;
    else if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(state)) out.fail++;
    else out.pending++;
  }
  return out;
}

function checksChip(rollup: unknown): HTMLElement {
  const c = checksSummary(rollup);
  const total = c.pass + c.fail + c.pending;
  if (!total) return chip("no checks");
  const cls = c.fail ? "chip-failed" : c.pending ? "chip-gate" : "chip-done";
  return chip(`checks ${c.pass}✓ ${c.fail}✗ ${c.pending}…`, cls);
}

/** Git tab: open pull requests of the opened folder's repository. */
export class PullRequestsSection {
  readonly el: HTMLElement;
  private body = h("div", { class: "hostreq-prs" });
  private loading = false;

  constructor(
    private status: (msg: string) => void,
    private onCard: (id: string) => void,
  ) {
    const refresh = iconBtn("refresh", "", () => this.refresh(), { title: "Refresh (gh pr list)", "aria-label": "Refresh pull requests" });
    this.el = card(h("span", { class: "grow" }, "Pull requests"), this.body);
    this.el.querySelector(".card-title")?.append(h("span", { class: "spacer" }), refresh);
    this.el.classList.add("forge-prs");
  }

  refresh() {
    if (this.loading) return;
    this.loading = true;
    void this.load().finally(() => (this.loading = false));
  }

  private async load() {
    try {
      const st = await forgeApi.status();
      const problem = forgeProblem(st);
      if (problem) return this.body.replaceChildren(problem);
      const prs = await forgeApi.prs();
      this.body.replaceChildren(...(prs.length ? prs.map((p) => this.row(p)) : [empty("No open pull requests.")]));
    } catch (e) {
      this.body.replaceChildren(h("div", { class: "hint warn" }, errText(e)));
    }
  }

  private row(p: J): HTMLElement {
    const n = Number(p.number);
    const method = h("select", { title: "Merge method" }, ...["squash", "merge", "rebase"].map((m) => h("option", { value: m }, m)));
    const merge = btn(
      "Merge…",
      () => {
        void hostApi.local("merge-pr", { number: n, method: method.value }).then(
          (id) => {
            this.status(`Merge #${n}: approve it on its card under Requests`);
            this.onCard(id);
          },
          (e) => this.status(errText(e)),
        );
      },
      { title: "Opens an approval card (a production base needs a typed yes)", "data-act": "merge" },
    );
    const el = h(
      "div",
      { class: "pr-row" },
      h("div", { class: "row" }, h("strong", { class: "mono" }, `#${n}`), h("span", { class: "grow ellipsis", title: s(p.title) }, s(p.title)), ...(p.isDraft ? [chip("draft")] : [])),
      h(
        "div",
        { class: "row small" },
        h("span", { class: "mono dim ellipsis grow", title: `${s(p.baseRefName)} ← ${s(p.headRefName)}` }, `${s(p.baseRefName)} ← ${s(p.headRefName)}`),
        checksChip(p.statusCheckRollup),
        chip(s(p.mergeable).toLowerCase() || "?", p.mergeable === "MERGEABLE" ? "chip-done" : p.mergeable === "CONFLICTING" ? "chip-failed" : ""),
        ...(p.reviewDecision ? [chip(s(p.reviewDecision).toLowerCase().replace(/_/g, " "))] : []),
        method,
        merge,
      ),
    );
    el.dataset.pr = String(n);
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
    const refresh = iconBtn("refresh", "Refresh", () => void this.load(), { title: "gh run list" });
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
