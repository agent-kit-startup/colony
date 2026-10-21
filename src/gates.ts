// Every HITL gate that waits for Ground Control in this window, from driver runs
// (./runs.ts, answered in Colony) and from terminal tabs (./launches.ts, answered in the
// terminal), plus the signals that make a new one hard to miss: the window title counter
// and an OS notification whose click focuses the window and opens the Inbox on that gate.
// Gate text is untrusted: it is only ever rendered as text, and the notification body
// carries the ask id and the run label, never the gate line.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onAction, sendNotification } from "@tauri-apps/plugin-notification";
import { launches } from "./launches";
import { type Gate, runLabel, runs } from "./runs";

export interface PendingGate {
  /** Stable per gate: `run:<id>:<ask>` or `term:<n>:<ask>`. */
  key: string;
  /** Center tab that holds the gate. */
  tabId: string;
  askId: string;
  /** Where it waits, for humans (`#3 repo · claude · plan` or the terminal tab label). */
  where: string;
  line: string;
  /** The question text before the gate line (driver runs only; "" otherwise). */
  prompt: string;
  at: string;
  /** Driver gate: answered from Colony. Absent for terminal gates (answered in the tab). */
  gate?: Gate;
}

/** Every open gate, oldest first. */
export function pendingGates(): PendingGate[] {
  const out: PendingGate[] = [];
  for (const g of runs.gates()) {
    const r = runs.runs.get(g.runId);
    out.push({ key: `run:${g.runId}:${g.askId}`, tabId: `run:${g.runId}`, askId: g.askId, where: r ? runLabel(r) : `#${g.runId}`, line: g.line, prompt: g.prompt, at: g.at, gate: g });
  }
  for (const t of launches.termGates()) {
    out.push({ key: `${t.tabId}:${t.askId}`, tabId: t.tabId, askId: t.askId, where: `${t.label}${t.plan ? ` · ${t.plan.replace(/\.plan\.md$/, "")}` : ""}`, line: t.line, prompt: "", at: t.at });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** Freedesktop notification servers read a markup subset in the body: send plain text. */
const plain = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface Notified { id: number; key: string; title: string; body: string; sent: boolean }

/**
 * Watches the gate list: keeps the window title counter current and raises one OS
 * notification per new gate unless the operator is already looking at it (or always,
 * when `always` is set). A click on the notification calls `onOpen` with the gate's key.
 */
export class GateAlerts {
  private known = new Set<string>();
  private byId = new Map<number, string>();
  private nextId = 1;
  private baseTitle = "Colony";
  /** Every notification raised, for the code-path smoke. */
  readonly log: Notified[] = [];
  /** Smoke: record notifications without showing them on the desktop. */
  dryRun = false;
  always = false;
  /**
   * True when the operator is already looking at this gate (its tab or the Inbox is the
   * active tab of a visible, focused window): then no notification is raised.
   */
  showing: (g: PendingGate) => boolean = () => false;

  constructor(private onOpen: (key: string | null) => void) {
    runs.on((c) => c.kind === "gate" || c.kind === "state" ? this.update() : undefined);
    launches.on(() => this.update());
    onAction((ev) => this.clicked(ev.notification?.id)).catch(() => {});
  }

  /** A click on notification `id`: focus the window, open the Inbox on that gate. */
  clicked(id: number | undefined) {
    // The smoke never moves the window or takes focus on the operator's desktop.
    if (!this.dryRun) void this.focusWindow();
    this.onOpen(id !== undefined ? (this.byId.get(id) ?? null) : null);
  }

  /** The folder part of the title (`<folder> · Colony`); the counter is prefixed to it. */
  setBase(title: string) {
    this.baseTitle = title;
    this.update();
  }

  title(): string {
    const n = pendingGates().length;
    return n ? `(${n}) ${this.baseTitle}` : this.baseTitle;
  }

  update() {
    const gates = pendingGates();
    const title = this.title();
    if (document.title !== title) {
      document.title = title;
      getCurrentWindow()
        .setTitle(title)
        .catch(() => {});
    }
    const live = new Set(gates.map((g) => g.key));
    for (const k of this.known) if (!live.has(k)) this.known.delete(k);
    for (const g of gates) {
      if (this.known.has(g.key)) continue;
      this.known.add(g.key);
      if (this.always || this.dryRun || !this.watched(g)) this.notify(g);
    }
  }

  /**
   * Window focus alone is not enough: a compositor may keep focus on a window parked on
   * another workspace, so a gate is only skipped when its own tab or the Inbox is on screen.
   */
  private watched(g: PendingGate): boolean {
    return document.visibilityState === "visible" && document.hasFocus() && this.showing(g);
  }

  private notify(g: PendingGate) {
    const id = this.nextId++;
    const title = "Colony: a gate waits for Ground Control";
    const body = plain(`${g.askId} · ${g.where}`).slice(0, 300);
    this.byId.set(id, g.key);
    let sent = false;
    if (!this.dryRun) {
      try {
        sendNotification({ id, title, body });
        sent = true;
      } catch {
        /* the status bar and the title still carry it */
      }
    }
    this.log.push({ id, key: g.key, title, body, sent });
  }

  /** Bring the window forward. Wayland compositors may only mark it urgent instead. */
  private async focusWindow() {
    const w = getCurrentWindow();
    await w.unminimize().catch(() => {});
    await w.show().catch(() => {});
    await w.setFocus().catch(() => {});
  }
}
