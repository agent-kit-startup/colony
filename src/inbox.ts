// Inbox (center tab): every decision that waits for the operator.
//  - Live gates: every open HITL gate across all agent runs in this window, whatever the
//    engine. Answering a card writes the driver-protocol JSON line to that run's stdin
//    (runs.reply); Colony never answers on the operator's behalf.
//  - Attention: Mission Control's attention items (field reports, plan monitors) from the
//    snapshot, with their file and, for an allowlisted kit command, "Ask agent".
//  - Gate exits: pending gate-exit tickets (agent-kit ground-control).
import { h } from "./api";
import { gateControls } from "./agent";
import type { CockpitHost } from "./cockpit";
import { runLabel, runs } from "./runs";
import { type J, obj, snapshot, str } from "./snapshot";
import { ago, btn, card, chip, empty, rerender } from "./ui";

/** Kit commands the Inbox may hand to an interactive agent (mirrors src-tauri vendor.rs). */
const ASKABLE = /^\/(plan-review-triage|field-report-resolve|continue-plan|run-plan|backlog-edit)( [A-Za-z0-9._:/-]{1,240})?$/;

export class InboxView {
  readonly el = h("div", { class: "cv cv-inbox" });
  private body = h("div", { class: "cv-body" });
  visible = false;
  private dirty = true;

  constructor(
    private host: CockpitHost,
    private onCount: (gates: number, attention: number) => void,
  ) {
    this.el.append(this.body);
    runs.on((c) => {
      if (c.kind === "gate" || c.kind === "state") this.invalidate();
      if (c.kind === "gate" && c.run.gate) host.status(`Inbox: ${runLabel(c.run)} waits for ${c.run.gate.askId}`);
    });
    snapshot.on((why) => why === "data" && this.invalidate());
    this.invalidate();
  }

  show() {
    this.visible = true;
    this.flush();
  }

  hide() {
    this.visible = false;
  }

  /** Live gates must render at once (the badge and the cards are the operator's cue). */
  invalidate() {
    this.dirty = true;
    this.onCount(runs.gates().length, snapshot.attention.length);
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
    const gates = runs.gates();
    const live = gates.map((g) => {
      const run = runs.runs.get(g.runId);
      const jump = btn("Open run", () => this.host.focusRun(g.runId), { class: "link", title: "Show this run's transcript" });
      const c = h(
        "div",
        { class: "gate inbox-card" },
        h("div", { class: "panel-row inbox-meta" }, h("span", { class: "grow" }, run ? runLabel(run) : `#${g.runId}`), h("span", { class: "dim" }, `tick ${g.tick}`), jump),
        h("div", { class: "inbox-line" }, g.line),
        ...gateControls(g, (msg) => this.host.status(`Inbox: ${msg}`)),
      );
      c.dataset.run = String(g.runId);
      c.dataset.ask = g.askId;
      return c;
    });
    const att = snapshot.attention.map((a) => this.attention(a));
    const tickets: J[] = Array.isArray(snapshot.gateExit.tickets) ? snapshot.gateExit.tickets : [];
    return [
      card(h("span", {}, "Live gates ", gates.length ? chip(String(gates.length), "chip-gate") : ""), h("div", { class: "inbox-list" }, ...(live.length ? live : [empty("Nothing waits for you. Gates from every agent run in this window land here.")]))),
      card(h("span", {}, "Attention ", att.length ? chip(String(att.length)) : ""), ...(snapshot.data ? (att.length ? att : [empty("No attention items.")]) : [empty("Waiting for Mission Control data…")])),
      ...(tickets.length
        ? [
            card(
              "Gate exits",
              ...tickets.map((t) => h("div", { class: "row" }, chip(str(t.branchState, "ticket"), "chip-gate"), h("span", { class: "grow ellipsis", title: str(t.headline) }, `${str(t.askId)} · ${str(t.headline)}`), h("span", { class: "dim small" }, ago(t.openedAt)))),
              btn("Copy agent-kit ground-control status", () => this.host.copy("agent-kit ground-control status", "command"), { class: "link" }),
            ),
          ]
        : []),
    ];
  }

  private attention(a: J): HTMLElement {
    const path = str(obj(a.pathAction).target) || str(a.sourcePath);
    const action = obj(a.action);
    const resolve = obj(a.resolveAction);
    const cmd = str(action.command || action.target);
    const rcmd = str(resolve.target || resolve.command);
    const acts: HTMLElement[] = [];
    if (path) acts.push(btn("Open", () => this.host.openRepoFile(path), { class: "link", title: path }));
    for (const [c, label] of [
      [cmd, str(action.label).replace(/^Copy /, "") || "command"],
      [rcmd, str(resolve.label).replace(/^Copy /, "") || "resolve"],
    ]) {
      if (!c) continue;
      if (ASKABLE.test(c)) acts.push(btn(`Ask agent: ${label}`, () => void this.host.interactive(c), { class: "link", title: `${c} in your agent, interactively` }));
      else acts.push(btn(`Copy ${label}`, () => this.host.copy(c, label), { class: "link" }));
    }
    const el = h(
      "div",
      { class: "att" },
      h("div", { class: "row" }, chip(str(a.severity || a.kind, "info"), a.group === "blocking" ? "chip-gate" : ""), h("strong", { class: "grow ellipsis", title: str(a.label) }, str(a.label)), h("span", { class: "dim small" }, ago(a.modifiedAt))),
      ...(str(a.findingsSummary) ? [h("div", { class: "dim small clamp-3", title: str(a.findingsSummary) }, str(a.findingsSummary))] : []),
      h("div", { class: "actions" }, ...acts),
    );
    el.dataset.id = str(a.id);
    return el;
  }
}
