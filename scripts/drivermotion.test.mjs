// Driver state -> icon and motion (src/drivermotion.ts), the table of the kit ADR
// 2026-10-29_colony-driver-motion-contract.md, and the CSS that animates it (src/styles.css).
// V1 of plan colony-driver-motion; V3 widens this to every surface. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { enterPlays, IDLE_ROW, LOOP_MS, missionState, phaseDelay, PULSE_MS, queueStatusState, runState, STATE_TABLE, stateRow, STOPPED_REASON } from "../src/drivermotion.ts";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const css = readFileSync(join(SRC, "styles.css"), "utf8");
const icons = readFileSync(join(SRC, "icons.ts"), "utf8");

test("every row of the ADR table, icon and motion", () => {
  const rows = Object.fromEntries(Object.entries(STATE_TABLE).flatMap(([g, t]) => Object.entries(t).map(([s, r]) => [`${g}:${s}`, `${r.icon} ${r.motion}`])));
  assert.deepEqual(rows, {
    "run:running": "play loop", "run:gate": "gate pulse", "run:done": "check enter", "run:failed": "cross enter", "run:stopped": "stop enter",
    "queue:running": "queue loop", "queue:held": "pause none", "queue:stopped": "stop enter", "queue:exhausted": "check enter",
    "mission:executing": "play loop", "mission:awaiting_user": "gate pulse", "mission:completed": "check enter", "mission:idle": "idle none",
  });
  for (const [, t] of Object.entries(STATE_TABLE)) for (const r of Object.values(t)) assert.match(icons, new RegExp(`\\n  ${r.icon}: '`), `icon ${r.icon} drawn`);
});

test("a state outside the table is the static idle row", () => {
  for (const [g, s] of [["run", "starting"], ["queue", "idle"], ["queue", "weird"], ["mission", "toString"], ["mission", "__proto__"]]) {
    const r = stateRow(g, s);
    assert.deepEqual({ icon: r.icon, motion: r.motion, known: r.known }, { ...IDLE_ROW, known: false }, `${g}:${s}`);
  }
  assert.equal(stateRow("run", "gate").known, true);
});

test("run state: gate, running, stopped by reason (not exit code), done, failed", () => {
  assert.equal(runState({ gate: { askId: "x" }, running: true, exitCode: undefined }), "gate");
  assert.equal(runState({ gate: null, running: true, exitCode: undefined }), "running");
  assert.equal(runState({ gate: null, running: false, exitCode: 0, reason: `${STOPPED_REASON} after tick 3` }), "stopped");
  assert.equal(runState({ gate: null, running: false, exitCode: 0, reason: "plan exhausted" }), "done");
  assert.equal(runState({ gate: null, running: false, exitCode: 4, reason: "gate x ended without a reply" }), "failed");
  assert.equal(runState({ gate: null, running: false, exitCode: null }), "failed");
});

test("queue state: first word of queue_state.status, lower-cased; none is idle", () => {
  assert.equal(queueStatusState("exhausted (deferred: colony-landing)"), "exhausted");
  assert.equal(queueStatusState("Running"), "running");
  assert.equal(queueStatusState("held: waiting for plan x"), "held");
  assert.equal(queueStatusState("stopped"), "stopped");
  assert.equal(queueStatusState(null), "idle");
  assert.equal(queueStatusState("  "), "idle");
});

test("mission state: the lifecycle value, else idle", () => {
  for (const s of ["executing", "awaiting_user", "completed"]) assert.equal(missionState(s), s);
  for (const s of ["idle", "", "parked", undefined, 3]) assert.equal(missionState(s), "idle");
});

test("loops keep one global phase across re-renders; the enter plays on a change only", () => {
  assert.equal(phaseDelay("loop", 3200 + 400), "-400ms");
  assert.equal(phaseDelay("pulse", 4000 + 1500), "-1500ms");
  assert.equal(phaseDelay("enter", 1234), "");
  assert.equal(phaseDelay("none", 1234), "");
  assert.equal(enterPlays(undefined, "done"), false, "first render stays still");
  assert.equal(enterPlays("done", "done"), false, "re-render in the same state");
  assert.equal(enterPlays("running", "done"), true);
});

test("CSS: tokens match, loops opt-in, reduced motion static, transform and opacity only", () => {
  assert.match(css, /--motion-fast: 150ms;/);
  assert.match(css, /--motion-enter: 400ms;/);
  assert.match(css, new RegExp(`--motion-loop: ${LOOP_MS / 1000}s;`));
  assert.match(css, new RegExp(`--motion-pulse: ${PULSE_MS / 1000}s;`));
  const noPref = css.match(/@media \(prefers-reduced-motion: no-preference\) \{\n((?:  .*\n)+)\}/g) ?? [];
  const optIn = noPref.join("\n");
  assert.match(optIn, /\.state-mark\.motion-loop \.state-ring \{[^}]*animation: mc-spin var\(--motion-loop\) linear infinite/);
  assert.match(optIn, /\.state-mark\.motion-pulse \.state-icon \{[^}]*animation: state-pulse var\(--motion-pulse\)/);
  // No loop outside the opt-in blocks for state marks; the ring is hidden by default.
  const outside = css.split(/@media \(prefers-reduced-motion: no-preference\) \{\n(?:  .*\n)+\}/).join("");
  assert.ok(!/\.state-[^{]*\{[^}]*infinite/.test(outside), "a state-mark loop outside no-preference");
  // Hidden by default with a selector that outranks `.state-mark svg { display: block }`.
  assert.match(outside, /\n\.state-mark \.state-ring \{[^}]*display: none;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.state-mark\.motion-enter \.state-icon \{ animation: none; \} \}/);
  for (const k of ["state-enter", "state-pulse"]) {
    const body = css.match(new RegExp(`@keyframes ${k} \\{(.*)\\}`))[1];
    for (const prop of body.matchAll(/([a-z-]+):/g)) assert.ok(["opacity", "transform"].includes(prop[1]), `${k} animates ${prop[1]}`);
  }
  assert.ok(!/will-change:/.test(css), "no will-change");
  // The Mode meta icon no longer spins next to the status ring (ADR point 2).
  assert.ok(!/now-meta-icon-executing/.test(css));
});
