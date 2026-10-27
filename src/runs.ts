// Agent runs: every driver process this window started (one per folder): the tick loop
// `agent-kit run-plan --events ndjson` and, on driver protocol 1.2.0, the queue runner
// `agent-kit run-plan-all --events ndjson`. Their logs, their open HITL gates and their
// ticks. The Agent panel, the Inbox and the Review view all read from this one store.
// Colony never answers a gate by itself: a reply is only ever sent from an operator action.
import { api, Channel, errText, type AgentEvent, type RunCommand, type TickReview } from "./api";
import { addUsage, budgetState, formatTokens, protocolHasUsage, readUsage, type TokenUsage, usageText } from "./usage";

const MAX_ROWS = 3000;
const MAX_ITEMS = 6000;
/** Cap on the gate prompt kept from the agent's text (characters). */
const MAX_PROMPT = 4000;

// biome-ignore lint: event payloads are open JSON
export type Ev = Record<string, any>;

export interface Row { text: string; cls: string }
/** Everything a run produced, in order, for the transcript (agent tab). */
export type RunItem =
  | { kind: "ev"; ev: Ev }
  | { kind: "raw"; line: string }
  | { kind: "stderr"; line: string }
  | { kind: "review"; review: TickReview }
  | { kind: "reply"; askId: string; shown: string }
  | { kind: "error"; text: string }
  | { kind: "exit"; code: number | null };
/**
 * One open HITL gate of a driver run. `line` is the protocol's one-line `HITL_GATE:` text;
 * `prompt` is the agent's text that came before it in the same tick (the question itself),
 * which the protocol event does not carry. Both are untrusted: render them as text only.
 */
export interface Gate { runId: number; askId: string; labels: string[]; line: string; prompt: string; tick: number; detection: string; at: string }
/**
 * The queue as a `run-plan-all` driver run reports it (`queue_state`, driver protocol
 * 1.2.0): a read-only projection of the HANDOFF queue fields, never written back.
 */
export interface QueueState { cursor: number | null; total: number; current: string | null; status: string | null }

/** `queue_state` / `run_start.queue` fields, or null when the event carries none. */
export function queueState(v: unknown): QueueState | null {
  if (!v || typeof v !== "object") return null;
  const q = v as Ev;
  const total = Number(q.total);
  if (!Number.isInteger(total) || total < 0) return null;
  const cursor = Number.isInteger(q.cursor) && q.cursor >= 0 ? Number(q.cursor) : null;
  return { cursor, total, current: typeof q.current === "string" ? q.current : null, status: typeof q.status === "string" ? q.status : null };
}

export interface Run {
  id: number;
  /** `run-plan` (tick loop) or `run-plan-all` (the queue runner, one session). */
  command: RunCommand;
  backend: string;
  root: string;
  name: string;
  cmd: string;
  plan: string;
  running: boolean;
  exitCode: number | null | undefined;
  rows: Row[];
  items: RunItem[];
  gate: Gate | null;
  reviews: TickReview[];
  startedAt: string;
  /** The agent's latest text in the current tick: becomes the next gate's `prompt`. */
  lastText: string;
  /** Queue runner only: the latest `queue_state` (null until the first one, or for run-plan). */
  queue: QueueState | null;
  /** Queue runner relaunched from the driver chat: the operator's resolution note
   *  (`--note`). `run_start` does not echo it, so Colony keeps its own copy. */
  note: string;
  /** `run_start.protocol` ("" until it arrives). */
  protocol: string;
  /** The run reports token usage: its protocol is 1.3.0 or newer (usage.ts). */
  usageSupported: boolean;
  /** Tokens so far: the sum of `tick_end.usage`, replaced by `run_end.usage` when it
   *  arrives; null while nothing was reported (always null below 1.3.0). */
  usage: TokenUsage | null;
}

export type RunChange =
  | { kind: "row"; run: Run; row: Row }
  | { kind: "gate"; run: Run }
  | { kind: "state"; run: Run }
  | { kind: "event"; run: Run; ev: Ev }
  | { kind: "item"; run: Run; item: RunItem }
  | { kind: "review"; run: Run; review: TickReview };

/** One display line per agent stream-json event (mirrors the benchmark derivation). */
function agentLine(e: Ev): Row | null {
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
      return { text: `› ${tool.name}${arg ? ` ${String(arg).slice(0, 160)}` : ""}`, cls: "ag-tool" };
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

export interface StartOptions { backend: string; maxTicks: number; cwd?: string; onLimit?: string; model?: string; command?: RunCommand; note?: string }

class RunStore {
  readonly runs = new Map<number, Run>();
  private listeners = new Set<(c: RunChange) => void>();
  /** Per-run token budget by folder (setting `tokenBudget`); informational only. */
  private budgets = new Map<string, number>();

  /** The folder's per-run token budget (null = none). Runs in it re-render. */
  setBudget(root: string, budget: number | null) {
    if ((this.budgets.get(root) ?? null) === budget) return;
    if (budget === null) this.budgets.delete(root);
    else this.budgets.set(root, budget);
    for (const r of this.runs.values()) if (r.root === root) this.emit({ kind: "state", run: r });
  }

  budget(root: string): number | null {
    return this.budgets.get(root) ?? null;
  }

  on(fn: (c: RunChange) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(c: RunChange) {
    for (const fn of this.listeners) fn(c);
  }

  list(): Run[] {
    return [...this.runs.values()];
  }

  /** Every open gate across all runs, oldest first. */
  gates(): Gate[] {
    return this.list()
      .map((r) => r.gate)
      .filter((g): g is Gate => !!g)
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  async start(opts: StartOptions): Promise<Run> {
    const channel = new Channel<AgentEvent>();
    const early: AgentEvent[] = [];
    let run: Run | null = null;
    channel.onmessage = (m) => (run ? this.onMessage(run, m) : early.push(m));
    const started = await api.agentStart({ ...opts, onEvent: channel });
    run = {
      id: started.id,
      command: started.command === "run-plan-all" ? "run-plan-all" : "run-plan",
      backend: started.backend,
      root: started.root,
      name: started.root.split("/").pop() || started.root,
      cmd: started.cmd,
      plan: "",
      running: true,
      exitCode: undefined,
      rows: [],
      items: [],
      gate: null,
      reviews: [],
      startedAt: new Date().toISOString(),
      lastText: "",
      queue: null,
      note: opts.note?.trim() ?? "",
      protocol: "",
      usageSupported: false,
      usage: null,
    };
    this.runs.set(run.id, run);
    this.emit({ kind: "state", run });
    this.row(run, `$ ${started.cmd}`, "ag-dim");
    if (run.note) this.row(run, `resolution note (${run.note.split("\n").length} lines): ${run.note}`, "ag-dim");
    for (const m of early.splice(0)) this.onMessage(run, m);
    return run;
  }

  /** Relay the operator's answer to `runId`'s open gate (number = 1-based label). */
  async reply(runId: number, askId: string, reply: number | string, shown: string) {
    const run = this.runs.get(runId);
    if (!run?.gate || run.gate.askId !== askId) throw new Error("That gate is no longer open");
    await api.agentReply(runId, askId, reply);
    this.row(run, `answered ${askId}: ${shown}`, "ag-reply");
    this.item(run, { kind: "reply", askId, shown });
    this.setGate(run, null);
  }

  async stop(runId: number) {
    await api.agentStop(runId);
  }

  async kill(runId: number) {
    await api.agentKill(runId);
  }

  /** Forget a finished run (its log and ticks). */
  remove(runId: number) {
    const run = this.runs.get(runId);
    if (!run || run.running) return;
    this.runs.delete(runId);
    this.emit({ kind: "state", run });
  }

  private row(run: Run, text: string, cls = "") {
    const row = { text, cls };
    run.rows.push(row);
    if (run.rows.length > MAX_ROWS) run.rows.splice(0, run.rows.length - MAX_ROWS);
    this.emit({ kind: "row", run, row });
  }

  private item(run: Run, item: RunItem) {
    run.items.push(item);
    if (run.items.length > MAX_ITEMS) run.items.splice(0, run.items.length - MAX_ITEMS);
    this.emit({ kind: "item", run, item });
  }

  /** A note in the transcript that is not from the driver (e.g. a failed answer). */
  note(runId: number, text: string) {
    const run = this.runs.get(runId);
    if (run) this.item(run, { kind: "error", text });
  }

  private setGate(run: Run, gate: Gate | null) {
    run.gate = gate;
    this.emit({ kind: "gate", run });
  }

  private onMessage(run: Run, m: AgentEvent) {
    if (m.kind === "stderr") {
      this.item(run, { kind: "stderr", line: m.line });
      return this.row(run, m.line, "ag-stderr");
    }
    if (m.kind === "review") {
      run.reviews.push(m.review);
      this.item(run, { kind: "review", review: m.review });
      const n = m.review.files.length;
      this.row(run, `tick ${m.review.tick} review: ${n} file${n === 1 ? "" : "s"} changed${m.review.finished ? "" : " (tick did not finish)"}`, "ag-dim");
      this.emit({ kind: "review", run, review: m.review });
      return;
    }
    if (m.kind === "exit") {
      run.running = false;
      run.exitCode = m.code;
      if (run.gate) this.setGate(run, null);
      this.item(run, { kind: "exit", code: m.code });
      this.row(run, `process exited ${m.code ?? "(signal)"}`, "ag-dim");
      this.emit({ kind: "state", run });
      return;
    }
    let ev: Ev;
    try {
      ev = JSON.parse(m.line);
    } catch {
      this.item(run, { kind: "raw", line: m.line });
      return this.row(run, m.line, "ag-dim");
    }
    this.emit({ kind: "event", run, ev });
    this.apply(run, ev, m.line);
    this.item(run, { kind: "ev", ev });
  }

  private apply(run: Run, ev: Ev, line: string) {
    switch (ev.type) {
      case "run_start":
        run.protocol = String(ev.protocol ?? "");
        run.usageSupported = protocolHasUsage(ev.protocol);
        run.plan = String(ev.plan ?? "");
        if (ev.backend) run.backend = String(ev.backend);
        if (ev.command === "run-plan-all") run.command = "run-plan-all";
        if (run.command === "run-plan-all") {
          run.queue = queueState(ev.queue) ?? run.queue;
          this.emit({ kind: "state", run });
          return this.row(run, `queue run-plan-all · ${ev.backend} · protocol ${ev.protocol}`, "ag-head");
        }
        this.emit({ kind: "state", run });
        return this.row(run, `run ${ev.plan} · ${ev.backend} · ${ev.pending} pending · max ${ev.maxTicks} ticks · protocol ${ev.protocol}`, "ag-head");
      case "queue_state": {
        const q = queueState(ev);
        if (!q) return this.row(run, line, "ag-dim");
        run.queue = q;
        this.emit({ kind: "state", run });
        return this.row(run, `queue ${queuePosition(q)}${q.current ? ` · ${q.current}` : ""}${q.status ? ` · ${q.status}` : ""}`, "ag-head");
      }
      case "tick_start":
        run.lastText = "";
        return this.row(run, `— tick ${ev.tick}/${ev.maxTicks} · ${ev.pending} pending · ${ev.backend ?? ""} · log ${ev.log}`, "ag-head");
      case "agent_event": {
        const line = agentLine(ev.event ?? {});
        if (line?.cls === "ag-assistant") run.lastText = line.text.slice(-MAX_PROMPT);
        if (line) this.row(run, line.text, line.cls);
        return;
      }
      case "agent_text":
        if (String(ev.text ?? "").trim()) run.lastText = String(ev.text).slice(-MAX_PROMPT);
        return this.row(run, String(ev.text ?? ""), "ag-dim");
      case "hitl_gate": {
        const gate: Gate = {
          runId: run.id,
          askId: String(ev.askId),
          labels: Array.isArray(ev.labels) ? ev.labels.map(String) : [],
          line: String(ev.line ?? ""),
          // The question without its own gate line (the card shows that line separately).
          prompt: run.lastText.replace(/^[ \t]*HITL_GATE:.*$/gm, "").trim(),
          tick: Number(ev.tick) || 0,
          detection: String(ev.detection ?? ""),
          at: String(ev.ts ?? new Date().toISOString()),
        };
        this.row(run, `gate ${gate.askId}: ${gate.line}`, "ag-warn");
        return this.setGate(run, gate);
      }
      case "tick_end": {
        if (run.gate) this.setGate(run, null);
        const parts = [`tick ${ev.tick} ended · exit ${ev.exitCode} · pending ${ev.pendingBefore}→${ev.pendingAfter}`];
        if (ev.result?.line) parts.push(ev.result.line);
        if (ev.stop) parts.push(`stop: ${ev.stop.cause}${ev.stop.message ? ` (${ev.stop.message})` : ""}`);
        if (ev.limit) parts.push(`usage limit: ${ev.limit.source}`);
        if (run.usageSupported) {
          const u = readUsage(ev.usage);
          if (u) {
            run.usage = addUsage(run.usage, u);
            parts.push(`${formatTokens(u.totalTokens)} tokens`);
            this.emit({ kind: "state", run });
          }
        }
        return this.row(run, parts.join(" · "), "ag-head");
      }
      case "log":
        return this.row(run, String(ev.message ?? ""), ev.level === "error" ? "ag-err" : ev.level === "warn" ? "ag-warn" : "ag-dim");
      case "run_end":
        if (run.gate) this.setGate(run, null);
        if (run.usageSupported) {
          // The kit's run total is authoritative (run-plan: the ticks' sum; run-plan-all: the session).
          run.usage = readUsage(ev.usage) ?? run.usage;
          this.emit({ kind: "state", run });
        }
        if (run.command === "run-plan-all") {
          const n = Array.isArray(ev.replies) ? ev.replies.length : 0;
          const stop = ev.stop?.cause ? ` · stop: ${ev.stop.cause}` : "";
          return this.row(run, `■ queue run ended · exit ${ev.exitCode} · ${ev.reason} · ${n} answer${n === 1 ? "" : "s"}${stop} · ${usageText(run.usageSupported, run.usage)}`, "ag-head");
        }
        return this.row(run, `■ run ended · exit ${ev.exitCode} · ${ev.reason} · ${ev.ticks} ticks · ${ev.pending} pending · ${usageText(run.usageSupported, run.usage)}`, "ag-head");
      default:
        return this.row(run, line, "ag-dim");
    }
  }
}

export const runs = new RunStore();

/** The newest live `run-plan-all` driver run in `root`, or null. */
export function liveQueueRun(root: string): Run | null {
  const live = runs.list().filter((r) => r.running && r.command === "run-plan-all" && r.root === root);
  return live.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
}

/** `2/8` (1-based cursor of total), `–/8` when the cursor names no queued plan, `none`. */
export function queuePosition(q: QueueState): string {
  if (q.total === 0) return "none";
  return `${q.cursor === null ? "–" : q.cursor + 1}/${q.total}`;
}

/** A run's tokens against its folder's budget: one line, and `over` when it passed it. */
export function runTokens(r: Run): { text: string; short: string; state: "none" | "within" | "over"; budget: number | null } {
  const budget = runs.budget(r.root);
  const state = budgetState(r.usage, budget);
  const tail = budget === null ? "" : state === "over" ? ` · over the ${formatTokens(budget)} budget` : ` of ${formatTokens(budget)} budget`;
  const short = !r.usageSupported ? "no usage" : r.usage ? `${formatTokens(r.usage.totalTokens)} tok` : "no usage yet";
  return { text: `${usageText(r.usageSupported, r.usage)}${r.usage ? tail : ""}`, short, state, budget };
}

export function runLabel(r: Run): string {
  if (r.command === "run-plan-all") return `#${r.id} ${r.name} · ${r.backend} · queue${r.queue ? ` ${queuePosition(r.queue)}` : ""}`;
  return `#${r.id} ${r.name} · ${r.backend}${r.plan ? ` · ${r.plan.replace(/\.plan\.md$/, "")}` : ""}`;
}

export { errText };
