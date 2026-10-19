// Engine picker and run start for `agent-kit run-plan --events ndjson` (driver mode).
// The controls live in the Mission view's run bar; each run then opens its own center
// tab (./transcript.ts). Runs live in ./runs.ts. Colony never answers a gate by itself.
import { open } from "@tauri-apps/plugin-dialog";
import { api, type BackendChoice, errText, h } from "./api";
import { type Gate, type Run, runs } from "./runs";

export class RunControls {
  readonly backend: HTMLSelectElement;
  readonly ticks: HTMLInputElement;
  readonly onLimit: HTMLSelectElement;
  readonly model: HTMLInputElement;
  readonly note: HTMLElement;
  readonly el: HTMLElement;
  private choices: BackendChoice[] = [];

  constructor(private status: (msg: string) => void) {
    this.backend = h("select", { title: "Engine for this run (agent-kit run-plan --backend; also picks the vendor CLI for Open interactive), remembered for this folder" });
    this.onLimit = h("select", { title: "On a vendor usage limit, continue the next fresh tick on this engine (--on-limit; once per run)" });
    this.model = h("input", { type: "text", placeholder: "default model", title: "Optional model id (--model), remembered for this folder", class: "model" });
    this.note = h("span", { class: "hint run-note" });
    this.ticks = h("input", { type: "number", min: "1", max: "200", value: "10", title: "Max ticks", class: "num" });
    this.el = h(
      "div",
      { class: "engine-bar" },
      h("label", {}, h("span", { class: "dim" }, "Engine"), this.backend),
      h("label", {}, h("span", { class: "dim" }, "Ticks"), this.ticks),
      h("label", {}, h("span", { class: "dim" }, "On limit"), this.onLimit),
      h("label", {}, h("span", { class: "dim" }, "Model"), this.model),
    );
    this.setChoices([]);
    this.backend.addEventListener("change", () => {
      this.renderNote();
      this.remember({ backend: this.backend.value });
    });
    this.onLimit.addEventListener("change", () => this.remember({ onLimit: this.onLimit.value || null }));
    this.model.addEventListener("change", () => this.remember({ model: this.model.value.trim() || null }));
    this.ticks.addEventListener("change", () => this.remember({ maxTicks: Number(this.ticks.value) || null }));
    api.agentBackends().then((c) => this.setChoices(c), () => {});
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

  /** Start a driver run (opened folder unless `cwd`). The new run opens its own tab. */
  async start(cwd?: string): Promise<Run | undefined> {
    try {
      const run = await runs.start({
        backend: this.backend.value,
        maxTicks: Number(this.ticks.value) || 10,
        cwd,
        onLimit: this.onLimit.value || undefined,
        model: this.model.value.trim() || undefined,
      });
      this.status(`Agent run #${run.id} started in ${run.name} (${run.backend})`);
      return run;
    } catch (e) {
      this.status(`Agent: ${errText(e)}`);
    }
  }

  async startElsewhere() {
    const picked = await open({ directory: true, multiple: false, title: "Run the active plan of this folder" });
    if (typeof picked === "string") return this.start(picked);
  }
}

/** Answer controls for one gate (transcript, Inbox and Mission view). */
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
  const sendFree = () => {
    const v = free.value.trim();
    if (v) void send(v, v);
  };
  freeBtn.addEventListener("click", sendFree);
  free.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") sendFree();
  });
  return [
    h("div", { class: "gate-title" }, `Decision needed · ${gate.askId}`),
    h("div", { class: "gate-buttons" }, ...buttons),
    h("div", { class: "panel-row" }, free, freeBtn),
  ];
}
