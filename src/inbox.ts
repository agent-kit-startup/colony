// Inbox: every open HITL gate across all agent runs in this window, whatever the engine
// (claude, codex, cursor-acp, ...). Answering a card writes the driver-protocol JSON
// line to that run's stdin (runs.reply); Colony never answers on the operator's behalf.
import { h } from "./api";
import { gateControls } from "./agent";
import { runLabel, runs } from "./runs";

export class InboxPanel {
  private list = h("div", { class: "inbox-list" });

  constructor(
    root: HTMLElement,
    private onCount: (n: number) => void,
    private onJump: (runId: number) => void,
    private status: (msg: string) => void,
  ) {
    root.append(h("p", { class: "hint" }, "Open decisions from every agent run in this window. Each answer goes to the run that asked."), this.list);
    runs.on((c) => {
      if (c.kind === "gate" || c.kind === "state") this.render();
      if (c.kind === "gate" && c.run.gate) this.status(`Inbox: ${runLabel(c.run)} waits for ${c.run.gate.askId}`);
    });
    this.render();
  }

  render() {
    const gates = runs.gates();
    this.onCount(gates.length);
    if (!gates.length) {
      this.list.replaceChildren(h("div", { class: "dim inbox-empty" }, "Nothing waits for you."));
      return;
    }
    this.list.replaceChildren(
      ...gates.map((g) => {
        const run = runs.runs.get(g.runId);
        const jump = h("button", { class: "icon", title: "Show this run in the Agent panel" }, "↗");
        jump.addEventListener("click", () => this.onJump(g.runId));
        const card = h(
          "div",
          { class: "gate inbox-card" },
          h("div", { class: "panel-row inbox-meta" }, h("span", { class: "grow" }, run ? runLabel(run) : `#${g.runId}`), h("span", { class: "dim" }, `tick ${g.tick}`), jump),
          h("div", { class: "inbox-line" }, g.line),
          ...gateControls(g, (msg) => this.status(`Inbox: ${msg}`)),
        );
        card.dataset.run = String(g.runId);
        card.dataset.ask = g.askId;
        return card;
      }),
    );
  }
}
