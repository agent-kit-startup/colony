// Driver state -> icon and motion (src/drivermotion.ts), the table of the kit ADR
// 2026-10-29_colony-driver-motion-contract.md, and the CSS that animates it (src/styles.css).
// Plan colony-driver-motion: V1 the table, V2 the transitions, V3 the guard rails (the class
// every mark carries, the states the surfaces draw, the reduced-motion fallback of every
// animation, the smoke fixture). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cardEnters, ENTER_EVENTS, enterPlays, IDLE_ROW, LOOP_MS, markMotion, missionState, phaseDelay, PULSE_MS, queueCard, queueStatusState, runState, STATE_TABLE, stateRow, STOPPED_REASON } from "../src/drivermotion.ts";

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

test("queue_state card: the event's own queue row, its tone and label (V2, ADR point 6)", () => {
  assert.deepEqual(queueCard("running"), { state: "running", tone: "executing", label: "running" });
  assert.deepEqual(queueCard("held: waiting for plan x"), { state: "held", tone: "awaiting", label: "held" });
  assert.deepEqual(queueCard("stopped"), { state: "stopped", tone: "idle", label: "stopped" });
  assert.deepEqual(queueCard("exhausted (deferred: colony-landing)"), { state: "exhausted", tone: "completed", label: "exhausted" });
  // Outside the table: the static idle row, never the raw value as a state.
  assert.deepEqual(queueCard("confirming"), { state: "idle", tone: "idle", label: "queue" });
  assert.deepEqual(queueCard(null), { state: "idle", tone: "idle", label: "no status" });
});

test("transcript cards enter on a live, visible append only (V2, ADR point 5)", () => {
  assert.deepEqual([...ENTER_EVENTS].sort(), ["hitl_gate", "queue_state", "run_end", "run_start", "tick_end", "tick_start"]);
  for (const t of ENTER_EVENTS) {
    assert.equal(cardEnters(t, true, true), true, t);
    assert.equal(cardEnters(t, false, true), false, `${t}: a stored transcript or backfill never animates`);
    assert.equal(cardEnters(t, true, false), false, `${t}: a hidden tab never animates`);
  }
  for (const t of ["agent_event", "log", "agent_text", "usage"]) assert.equal(cardEnters(t, true, true), false, t);
});

test("CSS (V2): crossfade and card enter are opt-in one-shots; transitions on the fast token, off under reduce", () => {
  const noPref = (css.match(/@media \(prefers-reduced-motion: no-preference\) \{\n((?:  .*\n)+)\}/g) ?? []).join("\n");
  assert.match(noPref, /\.state-fade \{ animation: state-fade var\(--motion-fast\) ease-out both; \}/);
  assert.match(noPref, /\.tr-enter \{ animation: tr-enter var\(--motion-fast\) ease-out both; \}/);
  const outside = css.split(/@media \(prefers-reduced-motion: no-preference\) \{\n(?:  .*\n)+\}/).join("");
  assert.ok(!/\.(state-fade|tr-enter) \{[^}]*animation/.test(outside), "a crossfade or card enter outside no-preference");
  for (const k of ["state-fade", "tr-enter", "gate-flash"]) {
    const body = css.match(new RegExp(`@keyframes ${k} \\{(.*)\\}`))[1];
    for (const prop of body.matchAll(/([a-z-]+):/g)) assert.ok(["opacity", "transform"].includes(prop[1]), `${k} animates ${prop[1]}`);
  }
  // The revealed gate card: once, no box-shadow; reduced motion keeps the static outline.
  assert.match(css, /\.gate\.flash \{ animation: gate-flash var\(--motion-enter\) ease-out; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.gate\.flash \{ animation: none; outline: 2px solid var\(--yellow\); \} \}/);
  // No 0.2s card transitions left: every border-colour transition is on --motion-fast.
  assert.ok(!/transition: [^;]*0\.2s/.test(css), "a 0.2s transition left");
  assert.match(css, /\.chip, \.tr-card, \.tr-gate \{ transition: border-color var\(--motion-fast\) ease-out; \}/);
  const reduce = css.match(/@media \(prefers-reduced-motion: reduce\) \{ ([^{]*) \{ transition: none; \} \}/);
  assert.ok(reduce, "a reduce block turns the transitions off");
  for (const sel of [".card", ".chip", ".tr-card", ".tr-gate", ".q-row"]) assert.ok(reduce[1].split(", ").includes(sel), `${sel} keeps a transition under reduce`);
});

// ---- V3 guard rails ------------------------------------------------------------------------

const ROOT = join(SRC, "..");
/** Product sources: the smoke modules run only under COLONY_SMOKE. */
const sources = readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !/smoke/.test(f));
const read = (f) => readFileSync(join(SRC, f), "utf8");

test("mark motion class (V3): every row on a state change, on a first render and as a still copy", () => {
  for (const [g, t] of Object.entries(STATE_TABLE)) {
    for (const [s, r] of Object.entries(t)) {
      assert.equal(markMotion(r, false, true), r.motion, `${g}:${s} on a state change`);
      assert.equal(markMotion(r, false, false), r.motion === "enter" ? "none" : r.motion, `${g}:${s} on a first render or a re-render: a one-shot stays still, a loop keeps going`);
      for (const changed of [true, false]) assert.equal(markMotion(r, true, changed), "none", `${g}:${s} as a still copy`);
    }
  }
  for (const changed of [true, false]) assert.equal(markMotion(IDLE_ROW, false, changed), "none", "a state outside the table never moves");
  // stateMark writes that motion as the class, and each class animates on its own token.
  assert.match(icons, /const motion = markMotion\(row, !!opts\.still, changed\);/);
  assert.match(icons, /el\.className = `state-mark motion-\$\{motion\}`;/);
  const motions = new Set(Object.values(STATE_TABLE).flatMap((t) => Object.values(t).map((r) => r.motion)));
  assert.deepEqual([...motions].sort(), ["enter", "loop", "none", "pulse"]);
  for (const m of ["enter", "loop", "pulse"]) assert.match(css, new RegExp(`\\.state-mark\\.motion-${m} [^{]*\\{[^}]*var\\(--motion-${m}\\)`), `motion-${m} runs on --motion-${m}`);
  assert.ok(!/\.state-mark\.motion-none[^{]*\{[^}]*animation/.test(css), "motion-none is static");
});

test("surfaces (V3): the run tab, the cockpit and the driver chat draw state marks, and only states of the table", () => {
  const drawn = new Map();
  for (const f of sources) for (const m of read(f).matchAll(/stateMark\("(run|queue|mission)", "([a-z_]+)"(, \{ still: true \})?/g)) drawn.set(`${m[1]}:${m[2]}`, { file: f, still: !!m[3] });
  assert.ok(drawn.size >= 4, `literal state marks found: ${[...drawn.keys()]}`);
  for (const [k, d] of drawn) {
    const [g, s] = k.split(":");
    // `starting` (a launch that has not reported yet) is the one state drawn outside the table:
    // the static idle mark, never animated.
    if (k === "run:starting") assert.equal(d.still, true, `${d.file}: run:starting is a still mark`);
    else assert.equal(stateRow(g, s).known, true, `${d.file} draws ${k}, which the table does not have`);
  }
  for (const f of ["transcript.ts", "cockpit.ts", "driverchat.ts"]) assert.match(read(f), /import \{[^}]*\bstateMark\b[^}]*\} from "\.\/icons";/, `${f} draws state marks`);
  // The derivations feed the marks whose state is not a literal.
  assert.match(read("transcript.ts"), /stateMark\("run", state, \{ key: `run:\$\{r\.id\}` \}\)/);
  assert.match(read("transcript.ts"), /stateMark\("queue", c\.state, \{ still: true \}\)/);
  assert.match(read("cockpit.ts"), /stateMark\("mission", missionState\(status\), \{ key: "mission" \}\)/);
  assert.match(read("cockpit.ts"), /stateMark\("queue", stState, \{ key: "queue-hero" \}\)/);
});

test("reduced motion (V3): every animation is opt-in or has a reduce override, and CSS alone reads the preference", () => {
  const optIn = /@media \(prefers-reduced-motion: no-preference\) \{\n(?:  .*\n)+\}/g;
  const override = /@media \(prefers-reduced-motion: reduce\) \{ ([^{]*) \{([^}]*)\} \}/g;
  let animated = 0;
  for (const f of readdirSync(SRC).filter((x) => x.endsWith(".css"))) {
    const text = read(f);
    const still = new Set();
    for (const m of text.matchAll(override)) if (/animation: none;/.test(m[2])) for (const sel of m[1].split(", ")) still.add(sel.trim());
    const outside = text.replace(optIn, "").replace(override, "");
    for (const m of outside.matchAll(/(?:^|\n)([^{}\n@][^{}\n]*) \{([^{}]*)\}/g)) {
      if (!/animation: (?!none)/.test(m[2])) continue;
      animated += 1;
      for (const sel of m[1].split(", ")) assert.ok(still.has(sel.trim()), `${f}: ${sel.trim()} animates outside no-preference with no reduce override`);
    }
    // The fallback adds no motion: a reduce block never declares an animation or a transition.
    for (const m of text.matchAll(override)) assert.ok(!/(animation|transition): (?!none)/.test(m[2]), `${f}: a reduce block adds motion (${m[1]})`);
  }
  assert.ok(animated >= 3, "the unguarded one-shots and the button spinner were found");
  // Each class of the contract under reduce: loops, the crossfade and the card enter exist only
  // inside the opt-in blocks; the one-shot enter and the gate flash are overridden.
  const outside = css.replace(optIn, "");
  for (const cls of ["motion-loop", "motion-pulse", "state-fade", "tr-enter"]) assert.ok(!new RegExp(`\\.${cls}[^{\\n]*\\{[^}]*(animation|display: block)`).test(outside), `.${cls} shows or animates outside no-preference`);
  // No script branches on the preference, so emulating it in the stylesheets (src/motionsmoke.ts)
  // is the whole of what it changes.
  for (const f of sources) assert.ok(!/prefers-reduced-motion/.test(read(f)), `${f} reads prefers-reduced-motion`);
});

test("smoke fixture (V3): the card and motion branch of fake-agent-kit.sh writes no file and never falls through", () => {
  const sh = readFileSync(join(ROOT, "packaging", "smoke", "fake-agent-kit.sh"), "utf8");
  const start = sh.indexOf('if [ "$cmd" = run-plan ] && case "${model:-}" in smoke-card-*|smoke-motion) true ;;');
  assert.ok(start > 0, "the branch is picked by --model smoke-card-* or smoke-motion");
  const block = sh.slice(start, sh.indexOf("\nfi\n", start));
  const code = block.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.ok(!code.includes(">"), "a redirection in the branch");
  assert.ok(!/\b(tee|touch|mkdir|cp|mv|rm|git|dd)\b/.test(code), "a command that writes in the branch");
  // It sits before the stand-ins that edit the workspace, and every path through it exits.
  for (const w of ["> queue-reply.json", "> run-plan-all-proof.txt", "> fixture-tick.txt", ">> README.md"]) assert.ok(sh.indexOf(w) > start + block.length, `${w} comes after the branch`);
  assert.match(code, /finish\(\) \{\n(?:.*\n)*?    exit "\$4"\n  \}/);
  const arms = code.slice(code.indexOf('case "$model" in'));
  assert.match(arms, /\n    smoke-motion\)\n/);
  assert.match(arms, /\n    \*\)\n/, "an unknown smoke-card-* model has a default arm");
  for (const arm of arms.split(/\n    (?=[a-z*][a-z*-]*\)\n)/).slice(1)) assert.match(arm, /\bfinish \d/, `an arm without finish: ${arm.slice(0, 40)}`);
  // The motion run: a gate between two running stretches, a clean end (run state `done`).
  const motion = arms.slice(arms.indexOf("smoke-motion)"), arms.indexOf("\n    *)\n"));
  assert.match(motion, /sleep 3\n(?:.*\n)*.*\\"askId\\":\\"smoke-motion-gate\\"(?:.*\n)*.*line_in\n(?:.*\n)*.*sleep 3\n\s*finish 0 .* null 0 "max ticks reached"/);
  // The smoke runs it twice, with motion allowed and under emulated reduce, and puts the
  // stylesheets back whatever happens.
  const smoke = read("motionsmoke.ts");
  assert.match(smoke, /playRun\("smoke-motion"\)/);
  assert.match(smoke, /await pass\(c, "no-preference", "driver-motion"\);\n  await pass\(c, "reduce", "driver-motion-reduced"\);/);
  assert.match(smoke, /\} finally \{\n(?:.*\n)*?    emu\.restore\(\);/);
  assert.match(read("main.ts"), /await motionSmoke\(\{ log, wait, until, shot, showTab, view, onMission, playRun, closeTab \}\);/);
});
