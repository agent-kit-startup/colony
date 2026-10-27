// Driver chat: a side panel next to the run-plan-all queue (Queue view), outside the driver
// process (kit ADR 2026-10-26_driver-chat-side-agent-programmatic-resolver; Ask
// driver-chat-home = Colony panel). Deterministic helpers come first: the deferred gates
// and the resolution prompt are `agent-kit queue gates --json` / `--prompt`, with no model
// call. The loop closes with "Relaunch with resolution": `agent-kit run-plan-all --note`
// after a confirmation. A model only runs when the operator opens the chat agent (the vendor
// CLI in a terminal tab, small tier by default; Ask driver-chat-model-tier = Small tier).
//
// What it never does: answer a gate (a live run's open gate is answered with the same
// operator buttons as the Inbox), write the driver's stdin except that relay, edit HANDOFF,
// start a run without the operator's confirmation, or run /git-prod or /kit-prod.
import { api, errText, h, type WorkspaceSettings } from "./api";
import type { CockpitHost } from "./cockpit";
import { pendingGates } from "./gates";
import { gateCard } from "./inbox";
import { CHAT_ENGINES, chatModel, type GatesDecision, gatesChange, gatesKey, NEVER_PREANSWER, noteProblem, offerRelaunch, parseDecision, PREANSWER_CLASSES } from "./resolver";
import { liveQueueRun, runs } from "./runs";
import { snapshot } from "./snapshot";
import { btn, cardHeader, chip, empty, pill } from "./ui";
import "./driverchat.css";

export const RELAUNCH_TIP = "agent-kit run-plan-all --note: relaunch the queue with your resolution note after the command text. The note is context only: every gate the new run opens, queue-confirm included, still waits for you";

/** The extra methods the driver chat needs from the window (main.ts). */
export interface DriverChatHost extends CockpitHost {
  /** The engine (backend id) the Run controls have selected. */
  engine(): string;
  /** Confirm, then start `agent-kit run-plan-all --note <note>` as a driver run. */
  relaunchQueue(note: string): Promise<unknown>;
  /** The vendor CLI of `engine` in a terminal tab on `model` ("" = its default), no prompt. */
  chatAgent(engine: string, model: string): Promise<unknown>;
}

export class DriverChat {
  readonly el = h("section", { class: "card driver-chat", "data-panel": "driver-chat" });
  private note = h("textarea", { class: "dc-note", rows: "7", spellcheck: "false", "aria-label": "Resolution note", placeholder: "Your resolution note: what you did about each gate. It reaches the relaunched session as operator context, never as a gate answer." }) as HTMLTextAreaElement;
  private chatModelIn = h("input", { class: "dc-model", type: "text", spellcheck: "false", "aria-label": "Chat model" }) as HTMLInputElement;
  private offerIn = h("input", { type: "checkbox", "aria-label": "Offer a relaunch when a deferred gate moves" }) as HTMLInputElement;
  private root = "";
  private decision: GatesDecision | null = null;
  private supported: boolean | null = null;
  private probeNote = "";
  private prompt = "";
  /** The operator changed the note: a re-probe no longer replaces it. */
  private edited = false;
  private probing = false;
  private again = false;
  private queueKey = "";
  private settings: WorkspaceSettings = {};
  /** A deferred gate moved since the last probe: Relaunch is offered (never started). */
  private offered: string[] = [];
  private wasLive = false;

  private settingsEl = h("details", { class: "dc-settings" });

  constructor(private host: DriverChatHost) {
    this.offerIn.checked = true;
    this.note.addEventListener("input", () => {
      this.edited = true;
      this.renderActions();
    });
    this.chatModelIn.addEventListener("change", () => this.remember({ chatModel: this.chatModelIn.value.trim() || null }));
    this.offerIn.addEventListener("change", () => this.remember({ offerRelaunch: this.offerIn.checked }));
    // Re-probe when HANDOFF's queue fields change (the snapshot) or a queue run ends.
    snapshot.on((why) => {
      if (why !== "data") return;
      const key = JSON.stringify(snapshot.runQueue);
      if (key !== this.queueKey) {
        this.queueKey = key;
        void this.probe();
      }
    });
    runs.on((c) => {
      if (c.run.command !== "run-plan-all" || c.run.root !== this.root) return;
      if (c.kind === "gate") return this.render();
      if (c.kind !== "state") return;
      const live = !!liveQueueRun(this.root);
      if (this.wasLive && !live) void this.probe();
      this.wasLive = live;
      this.render();
    });
  }

  /** Form fields this panel keeps across the Queue view's re-renders. */
  owns(el: HTMLElement): boolean {
    return el === this.note || el === this.chatModelIn || el === this.offerIn;
  }

  /** The panel for the opened folder: a new folder starts again from its own HANDOFF. */
  attach(): HTMLElement {
    const root = this.host.workspaceRoot();
    if (root !== this.root) {
      this.root = root;
      this.decision = null;
      this.supported = null;
      this.prompt = "";
      this.note.value = "";
      this.edited = false;
      this.offered = [];
      this.wasLive = !!liveQueueRun(root);
      void this.loadSettings().then(() => this.probe());
    }
    this.render();
    return this.el;
  }

  private async loadSettings() {
    try {
      this.settings = await api.settingsWorkspace();
    } catch {
      this.settings = {};
    }
    this.chatModelIn.value = this.settings.chatModel ?? "";
    this.offerIn.checked = this.settings.offerRelaunch !== false;
  }

  private remember(patch: Record<string, unknown>) {
    api
      .settingsSetWorkspace(patch)
      .then((ws) => {
        this.settings = ws;
        this.render();
      })
      .catch((e) => this.host.status(`Driver chat: could not save the setting: ${errText(e)}`));
  }

  /** `agent-kit queue gates` again (zero inference). One probe at a time; a request made
   *  while one runs is folded into one more probe after it. */
  async probe() {
    if (!this.root) return;
    if (this.probing) {
      this.again = true;
      return;
    }
    this.probing = true;
    this.render();
    const root = this.root;
    try {
      const r = await api.queueGates(this.host.engine(), root);
      if (root !== this.root) return;
      const next = r.supported ? parseDecision(r.decision) : null;
      const prev = this.decision;
      const live = !!liveQueueRun(root);
      if (offerRelaunch(this.offerIn.checked, prev, next, live)) {
        const c = gatesChange(prev, next);
        this.offered = [...c.gone, ...c.changed];
        this.host.status(`Driver chat: a deferred gate moved in HANDOFF (${this.offered.join(", ")}). Relaunch with resolution is ready in the Queue view`);
      } else if (gatesKey(prev) !== gatesKey(next)) {
        this.offered = [];
      }
      this.supported = r.supported;
      this.probeNote = r.note;
      this.decision = next;
      this.prompt = r.prompt;
      if (!this.edited) this.note.value = r.prompt.trim();
    } catch (e) {
      if (root !== this.root) return;
      this.supported = false;
      this.probeNote = `queue gates: ${errText(e)}`;
    } finally {
      this.probing = false;
      this.render();
      if (this.again) {
        this.again = false;
        void this.probe();
      }
    }
  }

  private actions = h("div", { class: "actions dc-actions" });
  private problem = h("p", { class: "hint warn dc-problem" });

  private renderActions() {
    const live = liveQueueRun(this.root);
    const problem = noteProblem(this.note.value);
    const relaunchBlock = !this.supported ? this.probeNote || "This engine has no queue gates helper" : live ? `Queue run #${live.id} is still running in this folder: one run per folder` : problem;
    const relaunch = btn("Relaunch with resolution", () => void this.relaunch(), { class: this.offered.length && !relaunchBlock ? "primary" : "status-bar-btn", "data-act": "dc-relaunch", title: relaunchBlock ? `${RELAUNCH_TIP}.\nNot now: ${relaunchBlock}` : RELAUNCH_TIP });
    relaunch.disabled = !!relaunchBlock;
    const reset = btn("Reset to helper prompt", () => {
      this.note.value = this.prompt.trim();
      this.edited = false;
      this.renderActions();
    }, { class: "status-bar-btn", "data-act": "dc-reset", title: "Replace the note with agent-kit queue gates --prompt" });
    reset.disabled = !this.edited || !this.prompt.trim();
    const copy = btn("Copy note", () => this.host.copy(this.note.value, "resolution note"), { class: "status-bar-btn", "data-act": "dc-copy", title: "Copy the note for a terminal: agent-kit run-plan-all --note @note.md" });
    copy.disabled = !this.note.value.trim();
    const engine = this.host.engine();
    const cm = chatModel(engine, this.settings.chatModel);
    const chatOk = (CHAT_ENGINES as readonly string[]).includes(engine);
    const agent = btn("Open chat agent", () => void this.host.chatAgent(engine, cm.model), {
      class: "status-bar-btn",
      "data-act": "dc-agent",
      title: chatOk
        ? `${engine}${cm.model ? ` --model ${cm.model}` : ""} (${cm.source}) in a terminal tab, on your own login: for questions no helper answers. Copy the note first to give it the context. It drafts; it does not answer the queue's gates`
        : `${engine} has no interactive vendor CLI here: the chat agent opens claude or codex only`,
    });
    agent.disabled = !chatOk;
    const refresh = btn(this.probing ? "Reading HANDOFF…" : "Refresh", () => void this.probe(), { class: "status-bar-btn", "data-act": "dc-refresh", title: "agent-kit queue gates again (no model call)" });
    refresh.disabled = this.probing;
    this.actions.replaceChildren(relaunch, reset, copy, agent, refresh);
    this.problem.textContent = this.supported && !live && problem && this.note.value.trim() ? problem : "";
    this.problem.hidden = !this.problem.textContent;
  }

  private async relaunch() {
    const note = this.note.value;
    const problem = noteProblem(note);
    if (problem) return this.host.status(`Driver chat: ${problem}`);
    await this.host.relaunchQueue(note.trim());
    this.offered = [];
    this.render();
  }

  render() {
    if (!this.root) return;
    const live = liveQueueRun(this.root);
    const d = this.decision;
    const gates = d?.gates ?? [];
    const head = cardHeader({
      title: "Driver chat",
      icon: "queue",
      aside: [
        ...(live?.gate ? [pill(`Gate ${live.gate.askId}`, "awaiting", "⏯")] : []),
        ...(this.offered.length ? [pill("Gate moved", "awaiting", "↻")] : []),
        pill(gates.length ? `${gates.length} deferred` : this.supported === false ? "No helper" : "Nothing deferred", gates.length ? "awaiting" : "idle"),
      ],
    });
    // A live queue run's open gate: answered here with the Inbox's own controls (relay only).
    const liveGate = live?.gate ? pendingGates().find((g) => g.gate?.runId === live.id) : undefined;
    const gateList = gates.length
      ? h(
          "div",
          { class: "dc-gates" },
          ...gates.map((g) => {
            const row = h(
              "div",
              { class: `row dc-gate${this.offered.includes(g.plan) ? " moved" : ""}` },
              h("strong", { class: "mono ellipsis", title: g.plan }, g.plan.replace(/\.plan\.md$/, "")),
              h("span", { class: "grow dc-gate-text", title: g.gate }, g.gate),
              ...g.asks.map((a) => chip(a, "chip-gate")),
            );
            row.dataset.plan = g.plan;
            return row;
          }),
        )
      : empty(this.supported === false ? this.probeNote || "This engine has no queue gates helper." : this.supported === null ? "Reading HANDOFF…" : "No deferred operator gates in HANDOFF Queue outcomes.");
    this.renderActions();
    const cm = chatModel(this.host.engine(), this.settings.chatModel);
    this.chatModelIn.placeholder = cm.source === "saved" ? "" : cm.model ? `${cm.model} (small tier)` : "vendor default";
    // The same <details> node every render, so an open settings block stays open.
    this.settingsEl.replaceChildren(
      h("summary", {}, "Autonomy and token settings"),
      h("label", { class: "row" }, h("span", { class: "dc-label" }, "Chat model"), this.chatModelIn, h("span", { class: "dim small" }, "The chat agent only; queue workers keep the Run controls' engine and model")),
      h("label", { class: "row" }, this.offerIn, h("span", {}, "Offer a relaunch when a deferred gate moves in HANDOFF (re-probed on every HANDOFF change; you still confirm the relaunch)")),
      h("div", { class: "row" }, h("span", { class: "dc-label" }, "Pre-answered Asks"), h("span", { class: "dim" }, PREANSWER_CLASSES.length ? PREANSWER_CLASSES.join(", ") : `none: no Accepted ADR lets an app answer a gate class for you (driver chat ADR point 5). Never: ${NEVER_PREANSWER.join(", ")}`)),
      h("div", { class: "row" }, h("span", { class: "dc-label" }, "Token budget"), h("span", { class: "dim" }, "not shown yet: the driver events carry no token usage (needs a driver protocol minor version)")),
    );
    this.el.replaceChildren(
      head,
      h("p", { class: "hint" }, "Reads the queue's deferred gates and resolution prompt with agent-kit queue gates (no model call), then relaunches run-plan-all with your note. It never answers a gate for you and never edits HANDOFF."),
      ...(live ? [h("div", { class: "dc-live hint" }, `Queue run #${live.id} is live${live.queue?.status ? ` · ${live.queue.status}` : ""}. Its gates, queue-end-gates included, are answered here or in the Inbox; its input stays open until run_end.`)] : []),
      ...(liveGate ? [gateCard(liveGate, this.host, "dc-live-gate")] : []),
      gateList,
      h("div", { class: "dc-note-label" }, "Resolution note (run-plan-all --note)"),
      this.note,
      this.problem,
      this.actions,
      ...(live?.note ? [h("details", { class: "dc-sent" }, h("summary", {}, `Note sent with run #${live.id}`), h("pre", { class: "mono small" }, live.note))] : []),
      this.settingsEl,
    );
  }
}
