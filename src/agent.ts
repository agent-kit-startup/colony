// Agent panel: `agent-kit run-plan --events ndjson` (driver mode). Renders the NDJSON
// events and relays the operator's HITL answers; it never answers a gate by itself.
import { api, Channel, errText, h, type AgentEvent } from "./api";

const MAX_ROWS = 3000;

// biome-ignore lint: event payloads are open JSON
type Ev = Record<string, any>;

/** One display line per agent stream-json event (mirrors the benchmark derivation). */
function agentLine(e: Ev): { text: string; cls: string } | null {
  if (e.type === "assistant" && Array.isArray(e.message?.content)) {
    const text = e.message.content
      .filter((c: Ev) => c.type === "text")
      .map((c: Ev) => c.text)
      .join(" ")
      .trim();
    if (text) return { text, cls: "ag-assistant" };
    const tool = e.message.content.find((c: Ev) => c.type === "tool_use");
    if (tool) {
      const arg = tool.input?.command ?? tool.input?.file_path ?? tool.input?.pattern ?? "";
      return { text: `⚙ ${tool.name}${arg ? ` ${String(arg).slice(0, 160)}` : ""}`, cls: "ag-tool" };
    }
    return null;
  }
  if (e.type === "user" && e.isReplay) {
    const c = e.message?.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: Ev) => x.text ?? "").join(" ") : "";
    return { text: `↩ ${text}`, cls: "ag-reply" };
  }
  if (e.type === "result") return { text: `■ result ${e.subtype ?? ""}`.trim(), cls: "ag-dim" };
  if (e.type === "system" && e.subtype === "init") return { text: `◆ session ${e.model ?? ""}`.trim(), cls: "ag-dim" };
  return null;
}

export class AgentPanel {
  private log: HTMLElement;
  private gate: HTMLElement;
  private startBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;
  private killBtn: HTMLButtonElement;
  private backend: HTMLSelectElement;
  private ticks: HTMLInputElement;
  private running = false;

  constructor(root: HTMLElement, private status: (msg: string) => void) {
    this.backend = h("select", { title: "Agent backend" });
    for (const b of ["claude", "codex", "cursor-acp", "auto", "cursor-agent"]) this.backend.append(h("option", { value: b }, b));
    this.ticks = h("input", { type: "number", min: "1", max: "200", value: "10", title: "Max ticks", class: "num" });
    this.startBtn = h("button", { class: "primary" }, "Run plan");
    this.stopBtn = h("button", { title: "Send {type:stop} at the open gate" }, "Stop at gate");
    this.killBtn = h("button", { title: "Terminate the run now" }, "Kill");
    this.stopBtn.disabled = this.killBtn.disabled = true;
    this.gate = h("div", { class: "gate", hidden: "" });
    this.log = h("div", { class: "ag-log" });
    root.append(
      h("div", { class: "panel-row" }, h("label", {}, "Backend ", this.backend), h("label", {}, "Ticks ", this.ticks)),
      h("div", { class: "panel-row" }, this.startBtn, this.stopBtn, this.killBtn),
      h("p", { class: "hint" }, "Runs agent-kit run-plan --events ndjson on the active plan of this folder. Gates wait for your answer here."),
      this.gate,
      this.log,
    );
    this.startBtn.addEventListener("click", () => void this.start());
    this.stopBtn.addEventListener("click", () => api.agentStop().catch((e) => this.row(errText(e), "ag-err")));
    this.killBtn.addEventListener("click", () => api.agentKill().catch((e) => this.row(errText(e), "ag-err")));
  }

  private row(text: string, cls = "") {
    const r = h("div", { class: `ag-row ${cls}` }, text);
    this.log.append(r);
    while (this.log.childElementCount > MAX_ROWS) this.log.firstElementChild?.remove();
    const nearBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 120;
    if (nearBottom) this.log.scrollTop = this.log.scrollHeight;
  }

  private setRunning(on: boolean) {
    this.running = on;
    this.startBtn.disabled = on;
    this.stopBtn.disabled = this.killBtn.disabled = !on;
  }

  private async start() {
    if (this.running) return;
    this.log.replaceChildren();
    this.hideGate();
    const channel = new Channel<AgentEvent>();
    channel.onmessage = (m) => this.onMessage(m);
    try {
      this.setRunning(true);
      const cmd = await api.agentStart(this.backend.value, Number(this.ticks.value) || 10, channel);
      this.row(`$ ${cmd}`, "ag-dim");
      this.status("Agent run started");
    } catch (e) {
      this.setRunning(false);
      this.row(errText(e), "ag-err");
    }
  }

  private onMessage(m: AgentEvent) {
    if (m.kind === "stderr") return this.row(m.line, "ag-stderr");
    if (m.kind === "exit") {
      this.setRunning(false);
      this.hideGate();
      this.row(`process exited ${m.code ?? "(signal)"}`, "ag-dim");
      this.status(`Agent run exited ${m.code ?? "(signal)"}`);
      return;
    }
    let ev: Ev;
    try {
      ev = JSON.parse(m.line);
    } catch {
      return this.row(m.line, "ag-dim");
    }
    switch (ev.type) {
      case "run_start":
        return this.row(`▶ run ${ev.plan} · ${ev.backend} · ${ev.pending} pending · max ${ev.maxTicks} ticks · protocol ${ev.protocol}`, "ag-head");
      case "tick_start":
        return this.row(`— tick ${ev.tick}/${ev.maxTicks} · ${ev.pending} pending · ${ev.backend ?? ""} · log ${ev.log}`, "ag-head");
      case "agent_event": {
        const line = agentLine(ev.event ?? {});
        if (line) this.row(line.text, line.cls);
        return;
      }
      case "agent_text":
        return this.row(String(ev.text ?? ""), "ag-dim");
      case "hitl_gate":
        return this.showGate(ev);
      case "tick_end": {
        const parts = [`tick ${ev.tick} ended · exit ${ev.exitCode} · pending ${ev.pendingBefore}→${ev.pendingAfter}`];
        if (ev.result?.line) parts.push(ev.result.line);
        if (ev.stop) parts.push(`stop: ${ev.stop.cause}${ev.stop.message ? ` (${ev.stop.message})` : ""}`);
        if (ev.limit) parts.push(`usage limit: ${ev.limit.source}`);
        return this.row(parts.join(" · "), "ag-head");
      }
      case "log":
        return this.row(String(ev.message ?? ""), ev.level === "error" ? "ag-err" : ev.level === "warn" ? "ag-warn" : "ag-dim");
      case "run_end":
        this.hideGate();
        return this.row(`■ run ended · exit ${ev.exitCode} · ${ev.reason} · ${ev.ticks} ticks · ${ev.pending} pending`, "ag-head");
      default:
        return this.row(m.line, "ag-dim");
    }
  }

  private hideGate() {
    this.gate.hidden = true;
    this.gate.replaceChildren();
  }

  private showGate(ev: Ev) {
    const askId = String(ev.askId);
    const labels: string[] = Array.isArray(ev.labels) ? ev.labels.map(String) : [];
    this.row(`⏸ gate ${askId}: ${ev.line ?? ""}`, "ag-warn");
    const send = async (reply: number | string, shown: string) => {
      try {
        await api.agentReply(askId, reply);
        this.row(`answered ${askId}: ${shown}`, "ag-reply");
        this.hideGate();
      } catch (e) {
        this.row(errText(e), "ag-err");
      }
    };
    const buttons = labels.map((label, i) => {
      const b = h("button", { class: i === 0 ? "primary" : "" }, `${i + 1}. ${label}`);
      b.addEventListener("click", () => void send(i + 1, `${i + 1} | ${label}`));
      return b;
    });
    const free = h("input", { type: "text", placeholder: "Other answer (free text)" });
    const freeBtn = h("button", {}, "Send");
    freeBtn.addEventListener("click", () => {
      const v = free.value.trim();
      if (v) void send(v, v);
    });
    this.gate.replaceChildren(
      h("div", { class: "gate-title" }, `Decision needed · ${askId}`),
      h("div", { class: "gate-buttons" }, ...buttons),
      h("div", { class: "panel-row" }, free, freeBtn),
    );
    this.gate.hidden = false;
    this.status(`Agent waits for your answer: ${askId}`);
  }
}
