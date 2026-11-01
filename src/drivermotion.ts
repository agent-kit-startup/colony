// Driver state -> state icon and motion: the table of the kit ADR
// .cursor/memory/decisions/2026-10-29_colony-driver-motion-contract.md (point 1) and the
// three derivations of its point 7 (plan colony-driver-motion v1). Pure, no DOM:
// scripts/drivermotion.test.mjs imports it directly. Any change to a row is an amend of that
// ADR first.

export type StateGroup = "run" | "queue" | "mission";
/** loop = activity ring, pulse = attention pulse, enter = one-shot on entering the state. */
export type Motion = "loop" | "pulse" | "enter" | "none";
/** Icon kinds of src/icons.ts that a state can draw. */
export type StateIcon = "play" | "gate" | "check" | "cross" | "stop" | "queue" | "pause" | "idle";
export interface StateRow { icon: StateIcon; motion: Motion }

export const STATE_TABLE: Record<StateGroup, Record<string, StateRow>> = {
  run: {
    running: { icon: "play", motion: "loop" },
    gate: { icon: "gate", motion: "pulse" },
    done: { icon: "check", motion: "enter" },
    failed: { icon: "cross", motion: "enter" },
    stopped: { icon: "stop", motion: "enter" },
  },
  queue: {
    running: { icon: "queue", motion: "loop" },
    held: { icon: "pause", motion: "none" },
    stopped: { icon: "stop", motion: "enter" },
    exhausted: { icon: "check", motion: "enter" },
  },
  mission: {
    executing: { icon: "play", motion: "loop" },
    awaiting_user: { icon: "gate", motion: "pulse" },
    completed: { icon: "check", motion: "enter" },
    idle: { icon: "idle", motion: "none" },
  },
};

/** A state outside the table: static idle mark, never a raw value or a stale icon. */
export const IDLE_ROW: StateRow = { icon: "idle", motion: "none" };

/** The table row of a state, or the idle row; `known` says whether the table has it. */
export function stateRow(group: StateGroup, state: string): StateRow & { known: boolean } {
  const row = Object.hasOwn(STATE_TABLE[group], state) ? STATE_TABLE[group][state] : null;
  return { ...(row ?? IDLE_ROW), known: !!row };
}

/** `run_end.reason` prefix of a stop after the current tick (driver protocol 1.5.0). */
export const STOPPED_REASON = "stopped by request";

export type RunState = "gate" | "running" | "stopped" | "done" | "failed";

/** Run: gate, else running, else stopped by `run_end.reason` (not the exit code), else exit 0. */
export function runState(r: { gate: unknown; running: boolean; exitCode: number | null | undefined; reason?: string | null }): RunState {
  if (r.gate) return "gate";
  if (r.running) return "running";
  if (typeof r.reason === "string" && r.reason.startsWith(STOPPED_REASON)) return "stopped";
  return r.exitCode === 0 ? "done" : "failed";
}

/** Queue: the first word of `queue_state.status`, lower-cased (`exhausted (deferred: ...)` is
 *  `exhausted`); no status is `idle`. */
export function queueStatusState(status: string | null | undefined): string {
  return (status ?? "").trim().split(/[\s(:,]/)[0].toLowerCase() || "idle";
}

/** Mission: the Mission Control lifecycle value; anything else is `idle`. */
export function missionState(status: unknown): "executing" | "awaiting_user" | "completed" | "idle" {
  return status === "executing" || status === "awaiting_user" || status === "completed" ? status : "idle";
}

/** Periods of --motion-loop and --motion-pulse (src/styles.css :root; the test pins both). */
export const LOOP_MS = 1600;
export const PULSE_MS = 2000;

/**
 * Negative animation-delay that keeps a loop on one global phase. The cockpit rebuilds its
 * nodes on every snapshot and on the 15s launch ticker; without this a ring would restart at
 * 0 degrees on each render and visibly jump.
 */
export function phaseDelay(motion: Motion, nowMs: number): string {
  const period = motion === "loop" ? LOOP_MS : motion === "pulse" ? PULSE_MS : 0;
  return period ? `-${Math.round(((nowMs % period) + period) % period)}ms` : "";
}

/** The one-shot enter plays only when a mark key changes state; a first render or a
 *  re-render in the same state stays still. */
export function enterPlays(prev: string | undefined, state: string): boolean {
  return prev !== undefined && prev !== state;
}
