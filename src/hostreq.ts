// Host requests (src-tauri/src/hostreq.rs): an agent inside Colony files
// `"$COLONY_HOST_CLI" request merge-pr|rerun-checks|push-branch|open-pr ...`; each request is an
// approval card here (Git tab, Requests). Colony runs the action with the operator's own
// git / gh login only after Approve is clicked; a production base or branch needs a typed
// yes. Deny takes an optional reason that goes back to the agent.
import { Channel, invoke } from "@tauri-apps/api/core";
import { errText, h } from "./api";
import "./hostreq.css";
import { ago, btn, card, chip, empty } from "./ui";

export interface HostRequest {
  id: string;
  kind: "merge-pr" | "rerun-checks" | "push-branch" | "open-pr";
  args: Record<string, unknown>;
  summary: string;
  reason: string;
  cwd: string;
  pid: number;
  createdAt: string;
  /** `agent`: filed with `colony request` (a CLI waits); `colony`: started in Colony. */
  origin: "agent" | "colony";
  running: boolean;
}
type HostEvent = { kind: "requests"; items: HostRequest[]; spool: string | null };
export interface Decision { outcome: "succeeded" | "failed" | "denied"; output: string }
type J = Record<string, unknown>;
interface RequestContext {
  /** Why a typed yes is needed (production base or branch), else null. */
  production: string | null;
  /** Why Colony will not run it at all, else null. */
  refused: string | null;
  error?: string;
  pr?: J;
  checks?: string;
  run?: J;
  branch?: string;
  upstream?: string | null;
  log?: string;
  /** open-pr: what Colony will open (branches, title and body are Colony's own). */
  prPlan?: { shape: string; base: string; head: string; pushSha: string | null; title: string; body: string; log: string };
}

export const hostApi = {
  subscribe: (onEvent: Channel<HostEvent>) => invoke<void>("host_requests_subscribe", { onEvent }),
  context: (id: string) => invoke<RequestContext>("host_request_context", { id }),
  diff: (id: string) => invoke<string>("host_request_diff", { id }),
  open: (id: string) => invoke<void>("host_request_open", { id }),
  approve: (id: string, typedConfirm?: string) => invoke<Decision>("host_request_approve", { id, typedConfirm: typedConfirm ?? null }),
  deny: (id: string, reason?: string) => invoke<void>("host_request_deny", { id, reason: reason || null }),
  local: (kind: HostRequest["kind"], args: J) => invoke<string>("host_request_local", { kind, args }),
};

/** The pending requests of this Colony instance (one spool per window). */
class HostRequestStore {
  items: HostRequest[] = [];
  spool: string | null = null;
  private subs = new Set<(fresh: HostRequest[]) => void>();

  start() {
    const ch = new Channel<HostEvent>();
    ch.onmessage = (ev) => {
      const known = new Set(this.items.map((i) => i.id));
      this.items = ev.items;
      this.spool = ev.spool;
      const fresh = ev.items.filter((i) => !known.has(i.id));
      for (const f of this.subs) f(fresh);
    };
    return hostApi.subscribe(ch);
  }

  on(cb: (fresh: HostRequest[]) => void) {
    this.subs.add(cb);
  }

  get count() {
    return this.items.length;
  }
}
export const hostRequests = new HostRequestStore();

function diffLines(text: string): HTMLElement[] {
  return text.split("\n").map((line) => {
    const cls = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : "";
    return h("div", { class: cls }, line);
  });
}

const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

/** One approval card. Kept across re-renders so a typed yes or deny reason survives. */
class RequestCard {
  readonly el = h("div", { class: "gate hostreq-card" });
  private ctxEl = h("div", { class: "hostreq-ctx dim" }, "Loading context…");
  private yes = h("input", { type: "text", placeholder: "type yes", class: "yes" });
  private yesRow = h("div", { class: "prod-confirm", hidden: "" });
  private why = h("input", { type: "text", placeholder: "Reason for the agent (optional)", class: "deny-reason" });
  private approveBtn: HTMLButtonElement;
  private denyBtn: HTMLButtonElement;
  private runningChip = chip("running", "chip-running");
  private out = h("pre", { class: "git-out hostreq-out", hidden: "" });
  private ctx: RequestContext | null = null;
  private busy = false;

  constructor(
    private r: HostRequest,
    private done: (r: HostRequest, d: Decision) => void,
    private status: (msg: string) => void,
  ) {
    this.approveBtn = btn("Approve", () => void this.approve(), { class: "primary", "data-act": "approve" });
    this.denyBtn = btn("Deny", () => void this.deny(), { "data-act": "deny" });
    this.approveBtn.disabled = true;
    this.yesRow.append(h("span", {}, "Production: "), this.yes);
    const args = Object.entries(r.args)
      .map(([k, v]) => `${k}=${s(v)}`)
      .join(" ");
    const extra: HTMLElement[] = [];
    if (r.kind === "merge-pr" || (r.kind === "rerun-checks" && r.args.pr)) {
      extra.push(btn("View diff", () => void this.diff(), { class: "link", "data-act": "diff" }));
      extra.push(btn("Open PR", () => void hostApi.open(r.id).catch((e) => this.status(errText(e))), { class: "link", "data-act": "open", title: "gh pr view --web" }));
    } else if (r.kind === "push-branch" || r.kind === "open-pr") {
      extra.push(btn("View diff", () => void this.diff(), { class: "link", "data-act": "diff" }));
    }
    this.el.dataset.id = r.id;
    this.el.dataset.kind = r.kind;
    this.el.append(
      h(
        "div",
        { class: "panel-row inbox-meta" },
        chip(r.kind, "chip-gate"),
        h("strong", { class: "grow ellipsis", title: r.summary }, r.summary),
        this.runningChip,
        h("span", { class: "dim small", title: r.createdAt }, ago(r.createdAt)),
      ),
      h("div", { class: "hostreq-meta mono small" }, `${r.origin === "agent" ? `agent pid ${r.pid}` : "started in Colony"} · nonce ${r.id.slice(0, 12)} · ${args}`),
      h("div", { class: "hostreq-meta mono small ellipsis", title: r.cwd }, r.cwd),
      ...(r.reason ? [h("div", { class: "hostreq-reason" }, r.reason)] : []),
      this.ctxEl,
      this.yesRow,
      h("div", { class: "actions" }, this.approveBtn, this.denyBtn, this.why, ...extra),
      this.out,
    );
    this.update(r);
    void this.load();
  }

  update(r: HostRequest) {
    this.r = r;
    this.runningChip.hidden = !r.running;
    this.el.classList.toggle("running", r.running);
    this.sync();
  }

  private sync() {
    const refused = !!this.ctx?.refused;
    this.approveBtn.disabled = this.busy || this.r.running || !this.ctx || refused;
    this.denyBtn.disabled = this.busy || this.r.running;
  }

  private async load() {
    try {
      this.ctx = await hostApi.context(this.r.id);
    } catch (e) {
      // Gone already (answered or withdrawn): the store removes the card.
      this.ctxEl.textContent = errText(e);
      return;
    }
    const c = this.ctx;
    const rows: (Node | string)[] = [];
    if (c.error) rows.push(h("div", { class: "hint warn" }, c.error));
    const pr = c.pr;
    if (pr && !pr.error) {
      rows.push(
        h("div", { class: "row" }, h("strong", { class: "grow ellipsis", title: s(pr.title) }, `#${s(pr.number)} ${s(pr.title)}`), ...(pr.isDraft ? [chip("draft")] : [])),
        h(
          "div",
          { class: "row" },
          h("span", { class: "mono" }, `${s(pr.baseRefName)} ← ${pr.isCrossRepository === false ? "" : `${s((pr.headRepositoryOwner as J | undefined)?.login) || "?"}:`}${s(pr.headRefName)}`),
          ...(pr.isCrossRepository === false ? [] : [chip("fork", "chip-failed")]),
          ...((pr.author as J | undefined)?.login ? [h("span", { class: "dim" }, `by ${s((pr.author as J).login)}`)] : []),
          chip(`mergeable: ${s(pr.mergeable).toLowerCase() || "?"}`, pr.mergeable === "MERGEABLE" ? "chip-done" : pr.mergeable === "CONFLICTING" ? "chip-failed" : ""),
          ...(pr.mergeStateStatus ? [chip(s(pr.mergeStateStatus).toLowerCase())] : []),
          ...(pr.reviewDecision ? [chip(s(pr.reviewDecision).toLowerCase().replace(/_/g, " "))] : []),
        ),
      );
    } else if (pr?.error) rows.push(h("div", { class: "hint warn" }, s(pr.error)));
    if (c.checks) rows.push(h("pre", { class: "hostreq-checks" }, c.checks));
    const run = c.run;
    if (run && !run.error) rows.push(h("div", { class: "row" }, chip(s(run.conclusion || run.status), run.conclusion === "failure" ? "chip-failed" : ""), h("span", { class: "grow ellipsis" }, `${s(run.workflowName)} · ${s(run.displayTitle)} · ${s(run.headBranch)}`)));
    else if (run?.error) rows.push(h("div", { class: "hint warn" }, s(run.error)));
    if (this.r.kind === "push-branch") {
      rows.push(h("div", { class: "row mono" }, `${s(c.branch)} → ${c.upstream ?? "origin (new upstream)"}`));
      if (c.log) rows.push(h("pre", { class: "hostreq-checks" }, c.log.trim() || "(nothing to push)"));
    }
    const plan = c.prPlan;
    if (this.r.kind === "open-pr" && plan) {
      rows.push(
        h("div", { class: "row" }, h("strong", { class: "grow ellipsis", title: plan.title }, plan.title)),
        h("div", { class: "row mono" }, `${plan.base} ← ${plan.head}`),
        ...(plan.pushSha ? [h("div", { class: "row mono small" }, `push ${plan.pushSha.slice(0, 12)} (the default branch's tip) → new branch ${plan.head}, never forced`)] : []),
        h("pre", { class: "hostreq-checks" }, plan.log || "(no commits)"),
      );
    }
    if (c.refused) rows.push(h("div", { class: "hint warn" }, c.refused));
    else if (c.production) rows.push(h("div", { class: "hint warn" }, `${c.production}: type yes to approve.`));
    this.ctxEl.replaceChildren(...rows);
    this.ctxEl.classList.remove("dim");
    this.el.dataset.ctx = "ready";
    this.el.dataset.production = c.production ? "yes" : "no";
    this.yesRow.hidden = !c.production || !!c.refused;
    this.sync();
  }

  private async diff() {
    this.out.hidden = false;
    this.out.textContent = "Loading…";
    try {
      const d = await hostApi.diff(this.r.id);
      this.out.replaceChildren(...diffLines(d || "(empty diff)"));
    } catch (e) {
      this.out.textContent = errText(e);
    }
  }

  private async approve() {
    if (this.ctx?.production && this.yes.value.trim() !== "yes") {
      this.out.hidden = false;
      this.out.textContent = `${this.ctx.production}. Type yes in the box to approve.`;
      this.yes.focus();
      return;
    }
    this.busy = true;
    this.sync();
    this.out.hidden = false;
    this.out.textContent = `Running: ${this.r.summary}…`;
    try {
      const d = await hostApi.approve(this.r.id, this.ctx?.production ? this.yes.value.trim() : undefined);
      this.out.textContent = d.output || d.outcome;
      this.done(this.r, d);
    } catch (e) {
      this.out.textContent = errText(e);
    } finally {
      this.busy = false;
      this.yes.value = "";
      this.sync();
    }
  }

  private async deny() {
    this.busy = true;
    this.sync();
    try {
      await hostApi.deny(this.r.id, this.why.value.trim());
      this.done(this.r, { outcome: "denied", output: this.why.value.trim() });
    } catch (e) {
      this.out.hidden = false;
      this.out.textContent = errText(e);
    } finally {
      this.busy = false;
      this.sync();
    }
  }
}

/** Git tab: the Requests card (pending approvals, then the last decisions). */
export class RequestsSection {
  readonly el: HTMLElement;
  private list = h("div", { class: "inbox-list hostreq-list" });
  private recent = h("div", { class: "hostreq-recent" });
  private cards = new Map<string, RequestCard>();
  private title = h("span", {}, "Requests");
  private decided: { r: HostRequest; d: Decision; at: string }[] = [];

  constructor(
    private status: (msg: string) => void,
    private onDecided?: (r: HostRequest, d: Decision) => void,
  ) {
    this.el = card(this.title, this.list, this.recent);
    this.el.classList.add("hostreq-section");
    hostRequests.on(() => this.render());
    this.render();
  }

  private render() {
    const items = hostRequests.items;
    for (const [id, c] of this.cards) {
      if (!items.some((i) => i.id === id)) {
        c.el.remove();
        this.cards.delete(id);
      }
    }
    for (const r of items) {
      const c = this.cards.get(r.id);
      if (c) c.update(r);
      else this.cards.set(r.id, new RequestCard(r, (req, d) => this.decide(req, d), this.status));
    }
    this.title.replaceChildren("Requests ", ...(items.length ? [chip(String(items.length), "chip-gate")] : []));
    const els = items.map((r) => this.cards.get(r.id)!.el);
    if (!els.length) {
      const hint = hostRequests.spool
        ? "Nothing waits for you. An agent in a Colony terminal or run files git and forge actions here with \"$COLONY_HOST_CLI\" request merge-pr|rerun-checks|push-branch|open-pr."
        : "Host requests are off: Colony could not create its request spool.";
      this.list.replaceChildren(empty(hint));
    } else {
      // Re-attaching the same nodes would blur a half-typed yes or deny reason.
      const same = els.length === this.list.children.length && els.every((e, i) => this.list.children[i] === e);
      if (!same) this.list.replaceChildren(...els);
    }
  }

  private decide(r: HostRequest, d: Decision) {
    this.decided.unshift({ r, d, at: new Date().toISOString() });
    this.decided.length = Math.min(this.decided.length, 5);
    this.status(`${r.summary}: ${d.outcome}`);
    this.onDecided?.(r, d);
    this.recent.replaceChildren(
      ...this.decided.map((x) =>
        h(
          "div",
          { class: "row small", title: x.d.output },
          chip(x.d.outcome, x.d.outcome === "succeeded" ? "chip-done" : x.d.outcome === "failed" ? "chip-failed" : ""),
          h("span", { class: "grow ellipsis" }, x.r.summary),
          h("span", { class: "dim" }, ago(x.at)),
        ),
      ),
    );
  }

  /** Scroll a card into view (e.g. right after the PR list's Merge created it). */
  reveal(id: string) {
    this.cards.get(id)?.el.scrollIntoView({ block: "nearest" });
  }
}

/** Inbox section: the pending host requests, each with a jump to its card in the Git tab. */
export function inboxRequests(showGit: () => void): Node[] {
  const items = hostRequests.items;
  if (!items.length) return [];
  return [
    card(
      h("span", {}, "Host requests ", chip(String(items.length), "chip-gate")),
      ...items.map((r) =>
        h(
          "div",
          { class: "row inbox-hostreq" },
          chip(r.kind, "chip-gate"),
          h("span", { class: "grow ellipsis", title: r.reason || r.summary }, r.summary),
          h("span", { class: "dim small" }, ago(r.createdAt)),
          btn("Approve or deny in Git", showGit, { class: "link" }),
        ),
      ),
    ),
  ];
}
