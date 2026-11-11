// The Current mission card's action row (Mission hero): Play/Stop, Open, Edit, Cancel, Plans,
// and Kill as a secondary action while a driver run is live. Kit ADR
// 2026-10-24_colony-shell-rail-terminal-drawer-inner-nav.md, Amend (2026-10-29) point 1;
// the stop after the current tick is driver protocol 1.5.0 (kit docs/driver-events-protocol.md
// "Stop after the current tick"). Which button shows, enabled or not, and why. Pure, no
// imports: Node runs it in `pnpm test` (scripts/missioncard.test.mjs).

/** The first driver protocol that takes `{"type":"stop_after_tick"}` on stdin. */
export const STOP_AFTER_TICK_PROTOCOL = "1.5.0";

/** Whether a run that announced `protocol` in `run_start` takes a stop after the tick (1.x, >= 1.5.0, no pre-release). */
export function protocolHasStopAfterTick(protocol: unknown): boolean {
  if (typeof protocol !== "string") return false;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(protocol.trim());
  return !!m && Number(m[1]) === 1 && Number(m[2]) >= 5;
}

/** The live driver run the card governs (stdin is Colony's: it can be stopped from here). */
export interface CardRun {
  id: number;
  /** `run-plan` (tick loop) or `run-plan-all` (the queue runner: no tick boundary). */
  command: "run-plan" | "run-plan-all";
  /** The open gate's id, or "" with none. */
  gate: string;
  /** `run_start.protocol` ("" until it arrives: unknown, never assumed 1.5.0). */
  protocol: string;
  /** A stop after the tick was sent: the run ends at its next boundary. */
  stopRequested: boolean;
}

export interface CardInput {
  /** The plan file the card shows ("" when HANDOFF names none and nothing runs). */
  plan: string;
  run: CardRun | null;
  /** A live terminal tab working on this folder's plan (no input channel from Colony). */
  terminal: string;
  /** Why Cancel is off: a run or queue in flight in this folder ("" when none). */
  busy: string;
}

export type ToggleFace = "play" | "stop-gate" | "stop-after-tick" | "stopping" | "kill" | "terminal";
export type CardButtonId = "toggle" | "open" | "edit" | "cancel" | "plans" | "kill";

export interface CardButton {
  id: CardButtonId;
  /** `data-act` of the button (never `run-plan`: that id is the top bar's, ADR point 2). */
  act: string;
  label: string;
  /** Tooltip and aria-label text (every button keeps both, labels shown by default). */
  title: string;
  disabled: boolean;
  /** The toggle's face; "" on the other buttons. */
  face: ToggleFace | "";
  /** A kit icon of src/icons.ts (the driver motion table's play and stop), or "". */
  icon: "play" | "stop" | "plans" | "";
}

function toggle(o: CardInput): CardButton {
  const b = (face: ToggleFace, label: string, title: string, disabled = false): CardButton => ({ id: "toggle", act: `card-${face}`, label, title, disabled, face, icon: face === "play" ? "play" : "stop" });
  const r = o.run;
  if (r) {
    const queue = r.command === "run-plan-all";
    if (r.gate) return b("stop-gate", "Stop", `Stop at the open gate ${r.gate}: sends {"type":"stop"}, the run ends there (exit 4). Nothing is answered.`);
    if (r.stopRequested)
      return b("stopping", "Stopping…", queue ? "Stop requested: the queue run ends at its next gate, which is not offered (driver stop, exit 4)" : "Stop requested: the current tick finishes, then the run ends (stopped by request, exit 0)", true);
    if (protocolHasStopAfterTick(r.protocol))
      return queue
        ? b("stop-after-tick", "Stop", "Stop the queue run at its next gate: run-plan-all has no tick boundary, so the session runs on until its next gate, which is not offered (driver stop, exit 4)")
        : b("stop-after-tick", "Stop", "Stop after the current tick: the tick finishes as it would have, then the run ends (stopped by request, exit 0). Run plan resumes the plan later.");
    return b("kill", "Kill…", `This engine (driver protocol ${r.protocol || "not reported yet"}) cannot stop after a tick (${STOP_AFTER_TICK_PROTOCOL} or newer): Kill ends the run now and asks first. Or wait for a gate and Stop there.`);
  }
  if (o.terminal) return b("terminal", "Stop", `${o.terminal} runs in a terminal tab: stop it there (Colony has no input channel to it)`, true);
  if (!o.plan) return b("play", "Play", "HANDOFF names no plan: Run plan in the top bar starts a run once it does", true);
  return b("play", "Play", `Run plan: the run dialog for ${o.plan} (the same action as Run plan in the top bar)`);
}

/** The row in order: Play/Stop, Open, Edit, Cancel, Plans, then Kill while a driver run is
 *  live and the toggle is not Kill already. */
export function cardButtons(o: CardInput): CardButton[] {
  const t = toggle(o);
  const none = "HANDOFF names no plan";
  const b = (id: CardButtonId, label: string, title: string, disabled = false, icon: CardButton["icon"] = ""): CardButton => ({ id, act: `card-${id}`, label, title, disabled, face: "", icon });
  const out = [
    t,
    b("open", "Open", o.plan ? `Open ${o.plan} (the rendered preview)` : none, !o.plan),
    b("edit", "Edit…", o.plan ? `/backlog-edit ${o.plan} in your agent, interactively: change to-dos, overview or phases (it asks before it writes)` : none, !o.plan),
    b("cancel", "Cancel…", !o.plan ? none : o.busy ? `${o.busy}: stop it first (/cancel-plan refuses while a run or queue is in flight)` : `/cancel-plan ${o.plan} in your agent: open to-dos cancelled, the file kept, HANDOFF names no plan after (it asks first)`, !o.plan || !!o.busy),
    b("plans", "Plans", "Open the Plans view", false, "plans"),
  ];
  if (o.run && t.face !== "kill") out.push(b("kill", "Kill…", "Terminate the run now, mid-tick (asks first): the tick's work so far stays on disk, unfinished"));
  return out;
}
