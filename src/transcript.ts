// Agent tab: one center tab per driver run, with a readable transcript built from the
// driver NDJSON events (kit docs/driver-events-protocol.md): assistant text as prose,
// tool calls collapsible with their results, thinking folded, each tick's
// LOOP_TICK_RESULT as a summary card and HITL gates inline with answer buttons that go
// to this run's stdin through runs.reply (the same relay as the Inbox). The raw event log
// stays one click away.
import { errText, h, type TickReview } from "./api";
import { gateControls } from "./agent";
import { ContextStrip } from "./contextstrip";
import { type Ev, type Run, type RunItem, runLabel, runs } from "./runs";

const RESULT_MAX = 6000;

export interface TranscriptHost {
  openRepoFile(rel: string, root: string): void;
  showReview(review: TickReview): void;
  status(msg: string): void;
  /** Open an absolute path (a context source) in the operator's editor. */
  openInEditor(path: string): void;
}

/** Inline markdown subset (code, bold) as DOM nodes; never innerHTML. */
function inline(text: string): Node[] {
  const out: Node[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    out.push(tok.startsWith("`") ? h("code", {}, tok.slice(1, -1)) : h("strong", {}, tok.slice(2, -2)));
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

/** Prose block: paragraphs, bullet lists, headings, fenced code. */
export function prose(text: string): HTMLElement {
  const root = h("div", { class: "prose" });
  const lines = text.replace(/\r/g, "").split("\n");
  let para: string[] = [];
  let list: HTMLElement | null = null;
  const flushPara = () => {
    if (para.length) root.append(h("p", {}, ...inline(para.join(" "))));
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      flushPara();
      list = null;
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) body.push(lines[i]);
      root.append(h("pre", {}, body.join("\n")));
      continue;
    }
    const bullet = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      if (!list) {
        list = h("ul");
        root.append(list);
      }
      list.append(h("li", {}, ...inline(bullet[1])));
      continue;
    }
    const head = /^#{1,4}\s+(.*)$/.exec(line);
    if (head) {
      flushPara();
      list = null;
      root.append(h("h4", {}, ...inline(head[1])));
      continue;
    }
    if (!line.trim()) {
      flushPara();
      list = null;
      continue;
    }
    list = null;
    para.push(line.trim());
  }
  flushPara();
  return root;
}

function toolArg(input: Ev | undefined): string {
  if (!input || typeof input !== "object") return "";
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description ?? input.query ?? "";
  return String(v).replace(/\s+/g, " ").slice(0, 200);
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : (c?.text ?? (c?.type ? `[${c.type}]` : "")))).join("\n");
  return content == null ? "" : JSON.stringify(content);
}

export class AgentTab {
  readonly el: HTMLElement;
  private tr = h("div", { class: "tr" });
  private raw = h("div", { class: "ag-log", hidden: "" });
  private chip = h("span", { class: "chip" });
  private title = h("span", { class: "run-title" });
  private stopBtn = h("button", { title: "Send {type:stop} at the open gate (the run ends, exit 4)" }, "Stop at gate");
  private killBtn = h("button", { title: "Terminate the run now" }, "Kill");
  private rawBtn = h("button", { class: "toggle", title: "Show the raw driver event log" }, "Raw log");
  private tools = new Map<string, HTMLElement>();
  private gates = new Map<string, HTMLElement>();
  private stderrGroup: { el: HTMLElement; body: HTMLElement; n: number } | null = null;
  private off: () => void;
  readonly context: ContextStrip;

  constructor(readonly run: Run, private host: TranscriptHost) {
    this.context = new ContextStrip(run.root, run.backend, (p) => host.openInEditor(p));
    const gotoGate = h("button", { class: "icon", title: "Jump to the open gate" }, "‖ gate");
    gotoGate.addEventListener("click", () => this.scrollToGate());
    this.el = h(
      "div",
      { class: "run-view" },
      h("div", { class: "run-head" }, this.chip, this.title, h("span", { class: "spacer" }), gotoGate, this.rawBtn, this.stopBtn, this.killBtn),
      this.context.el,
      h("div", { class: "run-body" }, this.tr, this.raw),
    );
    this.el.dataset.run = String(run.id);
    this.stopBtn.addEventListener("click", () => runs.stop(run.id).catch((e) => this.error(errText(e))));
    this.killBtn.addEventListener("click", () => runs.kill(run.id).catch((e) => this.error(errText(e))));
    this.rawBtn.addEventListener("click", () => {
      const show = this.raw.hidden;
      this.raw.hidden = !show;
      this.tr.hidden = show;
      this.rawBtn.classList.toggle("on", show);
      if (show) this.renderRaw();
    });
    for (const item of run.items) this.add(item, false);
    for (const row of run.rows) this.raw.append(h("div", { class: `ag-row ${row.cls}` }, row.text));
    this.renderHead();
    this.off = runs.on((c) => {
      if (c.run.id !== run.id) return;
      if (c.kind === "item") this.add(c.item, true);
      else if (c.kind === "row" && !this.raw.hidden) this.raw.append(h("div", { class: `ag-row ${c.row.cls}` }, c.row.text));
      else if (c.kind === "gate" || c.kind === "state") {
        this.renderHead();
        this.syncGates();
      }
    });
  }

  dispose() {
    this.off();
    this.el.remove();
  }

  private renderRaw() {
    this.raw.replaceChildren(...this.run.rows.map((row) => h("div", { class: `ag-row ${row.cls}` }, row.text)));
    this.raw.scrollTop = this.raw.scrollHeight;
  }

  private renderHead() {
    const r = this.run;
    const state = r.gate ? "gate" : r.running ? "running" : r.exitCode === 0 ? "done" : "failed";
    this.chip.className = `chip chip-${state}`;
    this.chip.textContent = r.gate ? "waiting for you" : r.running ? "running" : `exited ${r.exitCode ?? "(signal)"}`;
    this.title.textContent = runLabel(r);
    this.title.title = r.cmd;
    this.stopBtn.disabled = !r.gate;
    this.killBtn.disabled = !r.running;
  }

  scrollToGate() {
    const g = this.run.gate && this.gates.get(this.run.gate.askId);
    g?.scrollIntoView({ block: "center" });
  }

  private error(text: string) {
    this.append(h("div", { class: "tr-line ag-err" }, text), true);
  }

  private append(el: HTMLElement, follow: boolean) {
    const body = this.tr.parentElement;
    const near = !body || body.scrollHeight - body.scrollTop - body.clientHeight < 160;
    if (!el.classList.contains("tr-stderr")) this.stderrGroup = null;
    this.tr.append(el);
    while (this.tr.childElementCount > 4000) this.tr.firstElementChild?.remove();
    if (follow && near && body) body.scrollTop = body.scrollHeight;
  }

  private add(item: RunItem, live: boolean) {
    switch (item.kind) {
      case "ev":
        return this.event(item.ev, live);
      case "raw":
        return this.append(h("div", { class: "tr-line ag-dim" }, item.line), live);
      case "stderr": {
        if (!this.stderrGroup) {
          const body = h("pre", { class: "tr-stderr-body" });
          const sum = h("summary", {}, "stderr");
          const el = h("details", { class: "tr-stderr" }, sum, body);
          this.stderrGroup = { el, body, n: 0 };
          this.append(el, live);
        }
        const g = this.stderrGroup;
        g.n += 1;
        g.body.append(`${item.line}\n`);
        (g.el.firstElementChild as HTMLElement).textContent = `stderr · ${g.n} line${g.n === 1 ? "" : "s"} (terminal text, not part of the protocol)`;
        return;
      }
      case "review": {
        const n = item.review.files.length;
        const btn = h("button", { class: "link" }, `Review tick ${item.review.tick}`);
        btn.addEventListener("click", () => this.host.showReview(item.review));
        return this.append(h("div", { class: "tr-line tr-review" }, `◇ ${n} file${n === 1 ? "" : "s"} changed${item.review.finished ? "" : " (tick did not finish)"} · `, btn), live);
      }
      case "reply": {
        const card = this.gates.get(item.askId);
        if (card) this.closeGate(card, `Answered: ${item.shown}`, "answered");
        return this.append(h("div", { class: "tr-line ag-reply" }, `↩ you answered ${item.askId}: ${item.shown}`), live);
      }
      case "error":
        return this.error(item.text);
      case "exit":
        this.syncGates();
        return this.append(h("div", { class: "tr-line ag-dim" }, `process exited ${item.code ?? "(signal)"}`), live);
    }
  }

  private event(ev: Ev, live: boolean) {
    switch (ev.type) {
      case "run_start":
        return this.append(
          h("div", { class: "tr-card tr-start" }, h("strong", {}, `▶ ${ev.plan || "run"}`), h("span", { class: "dim" }, ` · ${ev.backend} · ${ev.pending} pending · max ${ev.maxTicks} ticks · protocol ${ev.protocol} · HITL ${ev.hitl}`)),
          live,
        );
      case "tick_start": {
        const log = h("button", { class: "link", title: "Open the tick log" }, String(ev.log ?? ""));
        log.addEventListener("click", () => ev.log && this.host.openRepoFile(String(ev.log), this.run.root));
        return this.append(h("div", { class: "tr-tick" }, h("span", {}, `Tick ${ev.tick}/${ev.maxTicks}`), h("span", { class: "dim" }, ` · ${ev.pending} pending · ${ev.backend ?? this.run.backend} · `), log), live);
      }
      case "agent_event":
        return this.agentEvent(ev.event ?? {}, live);
      case "agent_text":
        return this.append(h("div", { class: "tr-line ag-dim mono" }, String(ev.text ?? "")), live);
      case "hitl_gate":
        return this.gate(ev, live);
      case "tick_end":
        return this.tickEnd(ev, live);
      case "log": {
        const cls = ev.level === "error" ? "ag-err" : ev.level === "warn" ? "ag-warn" : "ag-dim";
        return this.append(h("div", { class: `tr-line ${cls}` }, String(ev.message ?? "")), live);
      }
      case "run_end":
        this.syncGates();
        return this.append(
          h("div", { class: `tr-card tr-end ${ev.exitCode === 0 ? "ok" : "bad"}` }, h("strong", {}, `■ Run ended · ${ev.reason}`), h("span", { class: "dim" }, ` · exit ${ev.exitCode} · ${ev.ticks} tick${ev.ticks === 1 ? "" : "s"} · ${ev.pending} pending${ev.planExhausted ? " · plan exhausted" : ""}`)),
          live,
        );
      default:
        return this.append(h("div", { class: "tr-line ag-dim mono" }, JSON.stringify(ev)), live);
    }
  }

  private agentEvent(e: Ev, live: boolean) {
    if (e.type === "system") {
      if (e.subtype === "init") this.append(h("div", { class: "tr-line ag-dim" }, `◆ session${e.model ? ` · ${e.model}` : ""}${e.session_id ? ` · ${String(e.session_id).slice(0, 8)}` : ""}`), live);
      return;
    }
    if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      for (const c of e.message.content as Ev[]) {
        if (c.type === "text" && String(c.text ?? "").trim()) this.append(h("div", { class: "tr-msg" }, prose(String(c.text))), live);
        else if (c.type === "thinking" && String(c.thinking ?? "").trim()) {
          this.append(h("details", { class: "tr-think" }, h("summary", {}, "Thinking"), prose(String(c.thinking))), live);
        } else if (c.type === "tool_use") {
          const arg = toolArg(c.input);
          const sum = h("summary", {}, h("span", { class: "tool-name" }, `› ${c.name ?? "tool"}`), h("span", { class: "tool-arg" }, arg));
          const input = h("pre", { class: "tool-input" }, JSON.stringify(c.input ?? {}, null, 2).slice(0, RESULT_MAX));
          const el = h("details", { class: "tr-tool" }, sum, input);
          if (c.id) this.tools.set(String(c.id), el);
          this.append(el, live);
        }
      }
      return;
    }
    if (e.type === "user") {
      const content = e.message?.content;
      if (e.isReplay) {
        const text = resultText(content);
        return this.append(h("div", { class: "tr-line ag-reply" }, `↩ ${text}`), live);
      }
      if (Array.isArray(content)) {
        for (const c of content as Ev[]) {
          if (c.type !== "tool_result") continue;
          const text = resultText(c.content);
          const tool = c.tool_use_id ? this.tools.get(String(c.tool_use_id)) : undefined;
          const out = h("pre", { class: `tool-result ${c.is_error ? "err" : ""}` }, text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)}\n… (${text.length - RESULT_MAX} more characters in the tick log)` : text || "(no output)");
          if (tool) {
            tool.append(out);
            if (c.is_error) tool.classList.add("err");
            tool.classList.add("done");
          } else this.append(h("details", { class: "tr-tool done" }, h("summary", {}, "tool result"), out), live);
        }
      }
      return;
    }
    if (e.type === "result") {
      const bits = [`■ agent result ${e.subtype ?? ""}`.trim()];
      if (typeof e.num_turns === "number") bits.push(`${e.num_turns} turns`);
      if (typeof e.duration_ms === "number") bits.push(`${Math.round(e.duration_ms / 1000)} s`);
      return this.append(h("div", { class: `tr-line ${e.is_error ? "ag-err" : "ag-dim"}` }, bits.join(" · ")), live);
    }
  }

  private gate(ev: Ev, live: boolean) {
    const askId = String(ev.askId);
    const card = h("div", { class: "gate tr-gate" }, h("div", { class: "inbox-line" }, String(ev.line ?? "")));
    card.dataset.ask = askId;
    card.dataset.run = String(this.run.id);
    this.gates.set(askId, card);
    this.append(card, live);
    this.syncGates();
    if (live) requestAnimationFrame(() => card.scrollIntoView({ block: "nearest" }));
  }

  /** Live controls only on the gate the run still waits for; the others say how they ended. */
  private syncGates() {
    for (const [askId, card] of this.gates) {
      if (card.classList.contains("answered") || card.classList.contains("closed")) continue;
      const open = this.run.gate?.askId === askId;
      if (open && !card.querySelector(".gate-buttons")) {
        card.prepend(...gateControls(this.run.gate!, (msg) => this.error(msg)));
      } else if (!open && card.querySelector(".gate-buttons")) {
        this.closeGate(card, "Closed without an answer from Colony (tick ended or run stopped)", "closed");
      } else if (!open && !this.run.running) {
        this.closeGate(card, "Closed (run ended)", "closed");
      }
    }
  }

  private closeGate(card: HTMLElement, text: string, cls: string) {
    for (const el of [...card.querySelectorAll(".gate-title, .gate-buttons, .panel-row")]) el.remove();
    card.classList.add(cls);
    card.prepend(h("div", { class: "gate-title" }, `${card.dataset.ask} · ${text}`));
  }

  private tickEnd(ev: Ev, live: boolean) {
    const result = ev.result && typeof ev.result === "object" ? (ev.result as Ev) : null;
    const kind = String(result?.kind ?? (ev.stop ? "stopped" : "no result"));
    const lines: (HTMLElement | string)[] = [
      h("div", { class: "tr-sum-head" }, h("span", { class: `chip chip-${ev.exitCode === 0 ? "done" : "failed"}` }, kind), h("strong", {}, ` Tick ${ev.tick} ended`), h("span", { class: "dim" }, ` · exit ${ev.exitCode} · pending ${ev.pendingBefore} → ${ev.pendingAfter} · ${ev.backend ?? ""}`)),
    ];
    if (result?.line) lines.push(h("div", { class: "mono tr-result-line" }, String(result.line)));
    if (result?.reason) lines.push(h("div", { class: "dim" }, String(result.reason)));
    if (Array.isArray(ev.replies) && ev.replies.length) lines.push(h("div", { class: "dim" }, `Replies: ${ev.replies.map((r: Ev) => r.line ?? `${r.askId} ${r.label ?? r.reply}`).join(" · ")}`));
    if (ev.stop) lines.push(h("div", { class: "ag-warn" }, `Stop: ${ev.stop.cause}${ev.stop.message ? ` (${ev.stop.message})` : ""}`));
    if (ev.limit) lines.push(h("div", { class: "ag-warn" }, `Usage limit: ${ev.limit.source}${ev.limit.detail ? ` · ${ev.limit.detail}` : ""}`));
    this.append(h("div", { class: "tr-card tr-sum" }, ...lines), live);
  }
}
