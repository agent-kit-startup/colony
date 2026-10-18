// Agent panel: start `agent-kit run-plan --events ndjson` runs (driver mode) and follow
// one of them: its NDJSON log, its open gate, stop / kill. Runs live in ./runs.ts; open
// gates from every run also show in the Inbox. It never answers a gate by itself.
import { open } from "@tauri-apps/plugin-dialog";
import { api, type BackendChoice, errText, h } from "./api";
import { type Gate, type Row, type Run, runLabel, runs } from "./runs";

export class AgentPanel {
  private log: HTMLElement;
  private gate: HTMLElement;
  private sessions: HTMLSelectElement;
  private startBtn: HTMLButtonElement;
  private otherBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;
  private killBtn: HTMLButtonElement;
  private clearBtn: HTMLButtonElement;
  readonly backend: HTMLSelectElement;
  readonly ticks: HTMLInputElement;
  readonly onLimit: HTMLSelectElement;
  readonly model: HTMLInputElement;
  private note: HTMLElement;
  private choices: BackendChoice[] = [];
  private selected: number | null = null;

  constructor(root: HTMLElement, private status: (msg: string) => void) {
    this.backend = h("select", { title: "Engine for this run (agent-kit run-plan --backend), remembered for this folder" });
    this.onLimit = h("select", { title: "On a vendor usage limit, continue the next fresh tick on this engine (--on-limit; once per run)" });
    this.model = h("input", { type: "text", placeholder: "default model", title: "Optional model id (--model), remembered for this folder", class: "grow" });
    this.note = h("p", { class: "hint" });
    this.ticks = h("input", { type: "number", min: "1", max: "200", value: "10", title: "Max ticks", class: "num" });
    this.setChoices([]);
    this.startBtn = h("button", { class: "primary", title: "Run the active plan of the opened folder" }, "Run plan");
    this.otherBtn = h("button", { title: "Run the active plan of another folder (another repository or a worktree); its gates land in the same Inbox" }, "Run in folder…");
    this.sessions = h("select", { title: "Runs started in this window", class: "grow" });
    this.stopBtn = h("button", { title: "Send {type:stop} at the open gate" }, "Stop at gate");
    this.killBtn = h("button", { title: "Terminate the run now" }, "Kill");
    this.clearBtn = h("button", { title: "Forget this finished run" }, "Clear");
    this.gate = h("div", { class: "gate", hidden: "" });
    this.log = h("div", { class: "ag-log" });
    root.append(
      h("div", { class: "panel-row" }, h("label", {}, "Engine ", this.backend), h("label", {}, "Ticks ", this.ticks)),
      h("div", { class: "panel-row" }, h("label", {}, "On limit ", this.onLimit), this.model),
      this.note,
      h("div", { class: "panel-row" }, this.startBtn, this.otherBtn),
      h("div", { class: "panel-row" }, this.sessions, this.stopBtn, this.killBtn, this.clearBtn),
      h("p", { class: "hint" }, "Runs agent-kit run-plan --events ndjson on the active plan. Gates wait for your answer here and in the Inbox."),
      this.gate,
      this.log,
    );
    this.startBtn.addEventListener("click", () => void this.start());
    this.backend.addEventListener("change", () => {
      this.renderNote();
      this.remember({ backend: this.backend.value });
    });
    this.onLimit.addEventListener("change", () => this.remember({ onLimit: this.onLimit.value || null }));
    this.model.addEventListener("change", () => this.remember({ model: this.model.value.trim() || null }));
    this.ticks.addEventListener("change", () => this.remember({ maxTicks: Number(this.ticks.value) || null }));
    api.agentBackends().then((c) => this.setChoices(c), () => {});
    this.otherBtn.addEventListener("click", () => void this.startElsewhere());
    this.sessions.addEventListener("change", () => this.select(Number(this.sessions.value) || null));
    this.stopBtn.addEventListener("click", () => this.withRun((r) => runs.stop(r.id)));
    this.killBtn.addEventListener("click", () => this.withRun((r) => runs.kill(r.id)));
    this.clearBtn.addEventListener("click", () =>
      this.withRun(async (r) => {
        runs.remove(r.id);
        this.select(runs.list().at(-1)?.id ?? null);
      }),
    );
    runs.on((c) => {
      if (c.kind === "state") this.renderSessions();
      if (c.run.id !== this.selected) return;
      if (c.kind === "row") this.appendRow(c.row);
      else if (c.kind === "gate") this.renderGate(c.run.gate);
    });
    this.renderSessions();
  }

  private setChoices(choices: BackendChoice[]) {
    this.choices = choices;
    const keep = this.backend.value || "claude";
    const keepLimit = this.onLimit.value;
    const ids = choices.length ? choices.map((c) => c.id) : ["claude", "codex", "cursor-acp", "cursor-agent", "auto"];
    const label = (id: string) => {
      const c = choices.find((x) => x.id === id);
      return c && !c.available ? `${id} (not on PATH)` : id;
    };
    this.backend.replaceChildren(...ids.map((id) => h("option", { value: id }, label(id))));
    this.onLimit.replaceChildren(h("option", { value: "" }, "stop"), ...ids.filter((id) => id !== "auto").map((id) => h("option", { value: id }, label(id))));
    this.backend.value = ids.includes(keep) ? keep : ids[0];
    this.onLimit.value = keepLimit;
    this.renderNote();
  }

  private renderNote() {
    const c = this.choices.find((x) => x.id === this.backend.value);
    this.note.textContent = c ? `${c.note}${c.available ? "" : ` · ${c.bin || "no agent CLI"} not found on PATH`}` : "";
    this.note.classList.toggle("warn", this.backend.value === "cursor-agent" || !!(c && !c.available));
  }

  private remember(patch: Record<string, unknown>) {
    api.settingsSetWorkspace(patch).catch((e) => this.status(`Could not remember the engine: ${errText(e)}`));
  }

  /** Restore the engine choice remembered for the opened folder. */
  async loadWorkspace() {
    try {
      const ws = await api.settingsWorkspace();
      if (ws.backend && [...this.backend.options].some((o) => o.value === ws.backend)) this.backend.value = ws.backend;
      this.onLimit.value = ws.onLimit ?? "";
      this.model.value = ws.model ?? "";
      if (ws.maxTicks) this.ticks.value = String(ws.maxTicks);
      this.renderNote();
    } catch (e) {
      this.status(`Settings: ${errText(e)}`);
    }
  }

  private current(): Run | undefined {
    return this.selected === null ? undefined : runs.runs.get(this.selected);
  }

  private withRun(fn: (r: Run) => Promise<unknown>) {
    const r = this.current();
    if (r) fn(r).catch((e) => this.appendRow({ text: errText(e), cls: "ag-err" }));
  }

  /** Start a run (opened folder unless `cwd`), then follow it. Returns it for callers. */
  async start(cwd?: string): Promise<Run | undefined> {
    try {
      const run = await runs.start({
        backend: this.backend.value,
        maxTicks: Number(this.ticks.value) || 10,
        cwd,
        onLimit: this.onLimit.value || undefined,
        model: this.model.value.trim() || undefined,
      });
      this.select(run.id);
      this.status(`Agent run #${run.id} started in ${run.name} (${run.backend})`);
      return run;
    } catch (e) {
      this.status(`Agent: ${errText(e)}`);
      this.appendRow({ text: errText(e), cls: "ag-err" });
    }
  }

  private async startElsewhere() {
    const picked = await open({ directory: true, multiple: false, title: "Run the active plan of this folder" });
    if (typeof picked === "string") await this.start(picked);
  }

  select(id: number | null) {
    this.selected = id;
    const run = this.current();
    this.log.replaceChildren();
    for (const row of run?.rows ?? []) this.appendRow(row, false);
    this.log.scrollTop = this.log.scrollHeight;
    this.renderGate(run?.gate ?? null);
    this.renderSessions();
  }

  private renderSessions() {
    const list = runs.list();
    this.sessions.replaceChildren(
      ...(list.length ? [] : [h("option", { value: "" }, "No runs yet")]),
      ...list.map((r) => h("option", { value: String(r.id) }, `${r.running ? "●" : "○"} ${runLabel(r)}${r.gate ? " · gate" : ""}`)),
    );
    if (this.selected !== null) this.sessions.value = String(this.selected);
    const r = this.current();
    this.stopBtn.disabled = this.killBtn.disabled = !r?.running;
    this.clearBtn.disabled = !r || r.running;
  }

  private appendRow(row: Row, follow = true) {
    this.log.append(h("div", { class: `ag-row ${row.cls}` }, row.text));
    while (this.log.childElementCount > 3000) this.log.firstElementChild?.remove();
    const nearBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 120;
    if (follow && nearBottom) this.log.scrollTop = this.log.scrollHeight;
  }

  private renderGate(gate: Gate | null) {
    this.renderSessions();
    if (!gate) {
      this.gate.hidden = true;
      this.gate.replaceChildren();
      return;
    }
    this.gate.replaceChildren(...gateControls(gate, (msg) => this.appendRow({ text: msg, cls: "ag-err" })));
    this.gate.hidden = false;
    this.status(`Agent waits for your answer: ${gate.askId}`);
  }
}

/** Answer controls for one gate (used by the Agent panel and the Inbox). */
export function gateControls(gate: Gate, onError: (msg: string) => void): HTMLElement[] {
  const send = (reply: number | string, shown: string) => runs.reply(gate.runId, gate.askId, reply, shown).catch((e) => onError(errText(e)));
  const buttons = gate.labels.map((label, i) => {
    const b = h("button", { class: i === 0 ? "primary" : "" }, `${i + 1}. ${label}`);
    b.dataset.reply = String(i + 1);
    b.addEventListener("click", () => void send(i + 1, `${i + 1} | ${label}`));
    return b;
  });
  const free = h("input", { type: "text", placeholder: "Other answer (free text)" });
  const freeBtn = h("button", {}, "Send");
  freeBtn.addEventListener("click", () => {
    const v = free.value.trim();
    if (v) void send(v, v);
  });
  return [
    h("div", { class: "gate-title" }, `Decision needed · ${gate.askId}`),
    h("div", { class: "gate-buttons" }, ...buttons),
    h("div", { class: "panel-row" }, free, freeBtn),
  ];
}
