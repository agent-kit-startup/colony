// Everything Colony launched in this window, in one list: the driver runs of ./runs.ts
// (`agent-kit run-plan --events ndjson`, one agent tab each) and the terminal tabs that
// run an agent (the interactive vendor CLI, `/run-plan <plan>` from a plan action
// included, and the `run-plan-all` queue runner). The Mission view's Agent runs card and
// its "launched from Colony" hero read this, merged with what the kit snapshot reports.
// Colony only reads the snapshot here; nothing is written back to the kit.
import { type Run, runs } from "./runs";
import { obj, snapshot, str } from "./snapshot";
import type { TermView } from "./termview";

export type LaunchKind = "driver" | "interactive" | "queue";
export type LaunchState = "starting" | "running" | "gate" | "ended";

export interface Launch {
  /** Center tab id (`run:<n>` or `term:<n>`): a click on the row focuses it. */
  tabId: string;
  kind: LaunchKind;
  /** Plan file the launch works on, when known (`""` otherwise). */
  plan: string;
  backend: string;
  root: string;
  label: string;
  startedAt: string;
  state: LaunchState;
  exitCode: number | null | undefined;
  /** Open gate id (driver: the protocol's; terminal: the last `HITL_GATE:` line seen). */
  gate: string | null;
  runId?: number;
}

/** A row the kit snapshot reports (activity `run_plan` or a workspace process). */
export interface KitRun {
  key: string;
  plan: string;
  label: string;
  at: string | null;
  source: "activity" | "process";
}

interface TermLaunch {
  tabId: string;
  kind: "interactive" | "queue";
  plan: string;
  backend: string;
  root: string;
  label: string;
  startedAt: string;
  view: TermView;
  el: HTMLElement;
  seen: boolean;
  gate: string | null;
  tail: string;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const GATE = /HITL_GATE:\s*([A-Za-z0-9._:-]+)/g;

/** The plan a kit slash command works on: `/run-plan X` and `/continue-plan X` activate X. */
export function promptPlan(prompt: string | undefined): string {
  const m = /^\/(?:run-plan|continue-plan)\s+(\S+\.plan\.md)$/.exec((prompt ?? "").trim());
  return m ? m[1].split("/").pop() ?? "" : "";
}

class LaunchStore {
  private terms = new Map<string, TermLaunch>();
  /** HANDOFF plan at the time a driver run started (the run reports its plan later). */
  private driverPlan = new Map<number, string>();
  private listeners = new Set<() => void>();
  private ticker = 0;
  /** Launches whose plan HANDOFF has named at least once: they no longer wait for it. */
  private confirmed = new Set<string>();

  constructor() {
    snapshot.on((why) => {
      if (why === "data") this.confirm();
    });
    runs.on((c) => {
      if (c.kind === "state" && !this.driverPlan.has(c.run.id)) this.driverPlan.set(c.run.id, snapshot.activePlanFile);
      if (c.kind === "state" || c.kind === "gate" || (c.kind === "event" && c.ev.type === "run_start")) this.changed();
    });
  }

  on(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
    this.tick();
  }

  /** While anything is live, re-render every 15 s so the elapsed times move. */
  private tick() {
    const live = this.list().some((l) => l.state !== "ended");
    if (live && !this.ticker) this.ticker = window.setInterval(() => this.changed(), 15000);
    if (!live && this.ticker) {
      window.clearInterval(this.ticker);
      this.ticker = 0;
    }
  }

  /** A terminal tab that runs an agent (interactive vendor CLI or queue runner). */
  addTerm(o: { tabId: string; kind: "interactive" | "queue"; plan: string; backend: string; root: string; label: string; view: TermView; el: HTMLElement }) {
    const t: TermLaunch = { ...o, startedAt: new Date().toISOString(), seen: false, gate: null, tail: "" };
    this.terms.set(o.tabId, t);
    const prevExit = o.view.onExit;
    o.view.onExit = (code) => {
      prevExit(code);
      t.gate = null;
      this.changed();
    };
    o.view.onOutput = (data) => {
      const first = !t.seen;
      t.seen = true;
      // Best effort: the last HITL_GATE line printed since the operator last typed.
      t.tail = (t.tail + data.replace(ANSI, "")).slice(-4096);
      let gate: string | null = t.gate;
      for (const m of t.tail.matchAll(GATE)) gate = m[1];
      if (gate !== t.gate) {
        t.gate = gate;
        t.tail = "";
        this.changed();
      } else if (first) this.changed();
    };
    o.view.onInput = () => {
      t.tail = "";
      if (t.gate) {
        t.gate = null;
        this.changed();
      }
    };
    this.changed();
  }

  /** Forget a terminal launch (its tab closed). */
  dropTerm(tabId: string) {
    if (this.terms.delete(tabId)) this.changed();
  }

  private fromRun(r: Run): Launch {
    const state: LaunchState = !r.running ? "ended" : r.gate ? "gate" : r.plan ? "running" : "starting";
    return {
      tabId: `run:${r.id}`,
      kind: "driver",
      plan: r.plan || this.driverPlan.get(r.id) || "",
      backend: r.backend,
      root: r.root,
      label: `#${r.id} ${r.name}`,
      startedAt: r.startedAt,
      state,
      exitCode: r.exitCode,
      gate: r.gate?.askId ?? null,
      runId: r.id,
    };
  }

  /** Every launch of this window, newest first. Terminal tabs closed elsewhere drop out. */
  list(): Launch[] {
    for (const [id, t] of this.terms) if (!t.el.isConnected) this.terms.delete(id);
    const out = runs.list().map((r) => this.fromRun(r));
    for (const t of this.terms.values()) {
      const state: LaunchState = t.view.exited ? "ended" : t.gate ? "gate" : t.seen ? "running" : "starting";
      out.push({ tabId: t.tabId, kind: t.kind, plan: t.plan, backend: t.backend, root: t.root, label: t.label, startedAt: t.startedAt, state, exitCode: t.view.exited ? t.view.exitCode : undefined, gate: t.gate });
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /**
   * The newest live launch in `root` working on a plan the snapshot does not show as
   * active yet: the agent has not switched HANDOFF to it (it does so when the plan run
   * activates, which can take minutes in an interactive session).
   */
  pending(root: string): Launch | null {
    this.confirm();
    return this.list().find((l) => l.state !== "ended" && !!l.plan && !this.confirmed.has(l.tabId) && l.root === root) ?? null;
  }

  private confirm() {
    const active = snapshot.activePlanFile;
    if (!active) return;
    for (const l of this.list()) if (l.plan === active) this.confirmed.add(l.tabId);
  }
}

export const launches = new LaunchStore();

const RUNNER = /\b(run-plan(?:-all)?|claude|codex|cursor-agent)\b/;

/** Runs the kit snapshot reports: `run_plan` activity and agent processes of the folder. */
export function kitRuns(): KitRun[] {
  const out: KitRun[] = [];
  for (const a of snapshot.activity) {
    if (str(a.kind) !== "run_plan") continue;
    const refs = obj(a.refs);
    out.push({ key: `activity:${str(a.id)}`, plan: str(refs.plan), label: str(a.label), at: str(a.at) || null, source: "activity" });
  }
  for (const p of snapshot.processes) {
    const cmd = str(p.command);
    if (str(p.label) === "dashboard-server" || !RUNNER.test(cmd)) continue;
    const plan = /\b([\w.-]+\.plan\.md)\b/.exec(cmd)?.[1] ?? "";
    out.push({ key: `process:${str(p.pid)}`, plan, label: str(p.description) || cmd, at: null, source: "process" });
  }
  return out;
}

/**
 * Colony's launches plus the kit rows that are not one of them. A kit row is the same run
 * as a live launch when it names the same plan, or, for a process row without a plan,
 * when it is the same kind of runner (`run-plan-all` vs `run-plan`) as a live launch.
 */
export function mergeRuns(mine: Launch[], kit: KitRun[]): { mine: Launch[]; kit: KitRun[]; kitSeen: Map<string, KitRun> } {
  const live = mine.filter((l) => l.state !== "ended");
  const kitSeen = new Map<string, KitRun>();
  const rest: KitRun[] = [];
  for (const k of kit) {
    let match: Launch | undefined;
    if (k.plan) match = live.find((l) => l.plan === k.plan);
    else if (k.source === "process") {
      const queue = /run-plan-all/.test(k.label);
      match = live.find((l) => (queue ? l.kind === "queue" : l.kind === "driver" && /run-plan/.test(k.label)));
    }
    if (match) {
      if (!kitSeen.has(match.tabId)) kitSeen.set(match.tabId, k);
    } else rest.push(k);
  }
  return { mine, kit: rest, kitSeen };
}

/** Elapsed time since `iso` (`42s`, `5m`, `1h 12m`). */
export function elapsed(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
