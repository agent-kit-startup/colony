// Inbox (center tab): every decision that waits for the operator.
//  - Live gates: every open HITL gate in this window, whatever the engine: driver runs
//    (answered here; the card writes the driver-protocol JSON line to that run's stdin,
//    runs.reply) and terminal tabs that printed a `HITL_GATE:` line (answered in that
//    terminal). Colony never answers on the operator's behalf.
//  - Attention: Mission Control's attention items (field reports, plan monitors) from the
//    snapshot, with their file and, for an allowlisted kit command, "Ask agent".
//  - Gate exits: pending gate-exit tickets (agent-kit ground-control).
import { h } from "./api";
import { gateControls } from "./agent";
import type { CockpitHost } from "./cockpit";
import { type PendingGate, pendingGates } from "./gates";
import { launches } from "./launches";
import { runLabel, runs } from "./runs";
import { type J, obj, snapshot, str } from "./snapshot";
import { ago, btn, card, chip, empty, pill, rerender } from "./ui";

/** Kit commands the Inbox may hand to an interactive agent: a subset of src-tauri vendor.rs PROMPT_SLASH (pinned by its tests). */
const ASKABLE = /^\/(plan-review-triage|field-report-resolve|continue-plan|run-plan|backlog-edit|agent-kit-onboard|start-project|backlog-add)( [A-Za-z0-9._:/-]{1,240})?$/;

export class InboxView {
  readonly el = h("div", { class: "cv cv-inbox" });
  private body = h("div", { class: "cv-body" });
  visible = false;
  private dirty = true;
  private sections: (() => Node[])[] = [];

  constructor(
    private host: CockpitHost,
    private onCount: (gates: number, attention: number) => void,
  ) {
    this.el.append(this.body);
    runs.on((c) => {
      if (c.kind === "gate" || c.kind === "state") this.invalidate();
      if (c.kind === "gate" && c.run.gate) host.status(`Inbox: ${runLabel(c.run)} waits for ${c.run.gate.askId}`);
    });
    launches.on(() => this.invalidate());
    snapshot.on((why) => why === "data" && this.invalidate());
    this.invalidate();
  }

  show() {
    this.visible = true;
    this.flush();
  }

  /** More decisions that wait for the operator (host requests), rendered after the live gates. */
  addSection(render: () => Node[]) {
    this.sections.push(render);
    this.invalidate();
  }

  hide() {
    this.visible = false;
  }

  /** Live gates must render at once (the badge and the cards are the operator's cue). */
  invalidate() {
    this.dirty = true;
    this.onCount(pendingGates().length, snapshot.attention.length);
    this.flush();
  }

  private flush() {
    if (!this.dirty) return;
    const a = document.activeElement as HTMLElement | null;
    if (a && this.el.contains(a) && a.tagName === "INPUT") {
      a.addEventListener("blur", () => this.flush(), { once: true });
      return;
    }
    this.dirty = false;
    rerender(this.el, () => this.body.replaceChildren(...this.render()));
  }

  private render(): Node[] {
    const gates = pendingGates();
    const live = gates.map((g) => gateCard(g, this.host, "inbox-card"));
    const att = snapshot.attention.map((a) => this.attention(a));
    const tickets: J[] = Array.isArray(snapshot.gateExit.tickets) ? snapshot.gateExit.tickets : [];
    return [
      card({ title: "Live gates", aside: gates.length ? [pill(`${gates.length} waiting`, "awaiting", "\u23EF")] : [] }, h("div", { class: "inbox-list" }, ...(live.length ? live : [empty("Nothing waits for you. Gates from every agent run in this window land here.")]))),
      ...this.sections.flatMap((s) => s()),
      card({ title: "Attention", aside: att.length ? [h("span", { class: "card-count mono" }, String(att.length))] : [] }, ...(snapshot.data ? (att.length ? att : [empty("No attention items.")]) : [empty("Waiting for Mission Control data…")])),
      ...(tickets.length
        ? [
            card(
              "Gate exits",
              ...tickets.map((t) => h("div", { class: "row" }, chip(str(t.branchState, "ticket"), "chip-gate"), h("span", { class: "grow ellipsis", title: str(t.headline) }, `${str(t.askId)} · ${str(t.headline)}`), h("span", { class: "run-meta mono" }, ago(t.openedAt)))),
              btn("Copy agent-kit ground-control status", () => this.host.copy("agent-kit ground-control status", "command"), { class: "link" }),
            ),
          ]
        : []),
    ];
  }

  /** Scroll the Inbox to one gate's card and flash it (a notification click). */
  reveal(key: string | null) {
    this.flush();
    const cards = [...this.el.querySelectorAll<HTMLElement>(".inbox-card")];
    const c = (key && cards.find((x) => x.dataset.key === key)) || cards[0];
    if (!c) return;
    c.scrollIntoView({ block: "nearest" });
    c.classList.remove("flash");
    void c.offsetWidth;
    c.classList.add("flash");
  }

  private attention(a: J): HTMLElement {
    const path = str(obj(a.pathAction).target) || str(a.sourcePath);
    const action = obj(a.action);
    const resolve = obj(a.resolveAction);
    const cmd = str(action.command || action.target);
    const rcmd = str(resolve.target || resolve.command);
    const acts: HTMLElement[] = [];
    if (path) acts.push(btn("Open", () => this.host.openRepoFile(path), { class: "status-bar-btn", title: path }));
    for (const [c, label] of [
      [cmd, str(action.label).replace(/^Copy /, "") || "command"],
      [rcmd, str(resolve.label).replace(/^Copy /, "") || "resolve"],
    ]) {
      if (!c) continue;
      if (ASKABLE.test(c)) acts.push(btn(`Ask agent: ${label}`, () => void this.host.interactive(c), { class: "status-bar-btn", title: `${c} in your agent, interactively` }));
      else acts.push(btn(`Copy ${label}`, () => this.host.copy(c, label), { class: "status-bar-btn" }));
    }
    const el = h(
      "div",
      { class: "att" },
      h("div", { class: "row" }, chip(str(a.severity || a.kind, "info"), a.group === "blocking" ? "chip-gate" : ""), h("strong", { class: "grow ellipsis", title: str(a.label) }, str(a.label)), h("span", { class: "run-meta mono" }, ago(a.modifiedAt))),
      ...(str(a.findingsSummary) ? [h("div", { class: "dim small clamp-3", title: str(a.findingsSummary) }, str(a.findingsSummary))] : []),
      h("div", { class: "actions" }, ...acts),
    );
    el.dataset.id = str(a.id);
    return el;
  }
}

/**
 * One gate card (Inbox and the Mission view's pinned strip): where it waits, the full
 * question and the gate line as text, and the answer controls for a driver run or a
 * button to the terminal that holds it.
 */
export function gateCard(g: PendingGate, host: CockpitHost, cls: string): HTMLElement {
  const term = !g.gate;
  const jump = term
    ? btn("Open terminal", () => host.showTab(g.tabId), { class: "status-bar-btn", title: "Answer it in its terminal tab" })
    : btn("Open run", () => host.focusRun(g.gate!.runId), { class: "status-bar-btn", title: "Show this run's transcript" });
  const c = h(
    "div",
    { class: `gate ${cls}` },
    h(
      "div",
      { class: "panel-row inbox-meta" },
      pill("Awaiting", "awaiting", "\u23EF"),
      h("span", { class: "grow" }, g.where),
      ...(g.gate ? [h("span", { class: "run-meta mono" }, `tick ${g.gate.tick}`)] : [h("span", { class: "run-meta mono" }, "terminal")]),
      jump,
    ),
    ...(g.prompt ? [h("div", { class: "gate-prompt" }, g.prompt)] : []),
    h("div", { class: "inbox-line" }, g.line || `HITL_GATE: ${g.askId}`),
    ...(g.gate ? gateControls(g.gate, (msg) => host.status(`Inbox: ${msg}`)) : [h("div", { class: "gate-title" }, `Decision needed · ${g.askId} · answer in the terminal tab`)]),
  );
  if (g.gate) c.dataset.run = String(g.gate.runId);
  else c.dataset.tab = g.tabId;
  c.dataset.ask = g.askId;
  c.dataset.key = g.key;
  return c;
}
