// COLONY_SMOKE steps for the driver motion contract (kit ADR
// .cursor/memory/decisions/2026-10-29_colony-driver-motion-contract.md; plan
// colony-driver-motion v3). Called from runSmoke in main.ts, so this code runs only during the
// code-path smoke. The fake's `run-plan --model smoke-motion` (packaging/smoke/fake-agent-kit.sh,
// a branch that writes no files) goes running -> gate -> running -> done, and each state is read
// on the three surfaces: the run tab's chip, its transcript cards and the cockpit's Crew Monitor
// row. Two passes: `driver-motion` with motion allowed, `driver-motion-reduced` under reduce.
//
// The preference is emulated in the page (emulateMotion): every `prefers-reduced-motion` feature
// of the loaded stylesheets is rewritten to a query that is always or never true, then put back.
// CSS is the only reader of the preference (scripts/drivermotion.test.mjs pins that no script
// reads it), so this is what the preference does to the page on either value, whatever the
// desktop running the smoke is set to. It does not test how WebKitGTK maps the desktop setting
// (gtk-enable-animations) to the media feature.
import { type Motion, runState, stateRow } from "./drivermotion";
import type { Run } from "./runs";

export interface MotionSmokeCtx {
  log: (step: string, ok: boolean, detail?: unknown) => Promise<unknown>;
  wait: (ms: number) => Promise<unknown>;
  until: (cond: () => boolean, ms: number) => Promise<boolean>;
  shot: (name: string) => Promise<void>;
  showTab: (id: string) => void;
  view: (id: string) => HTMLElement;
  /** Shows Mission and renders it now. */
  onMission: () => Promise<void>;
  /** Starts the plan with `--model <model>` from the Current mission card; resolves once the
   *  run's first tick started. */
  playRun: (model: string) => Promise<{ dialog: boolean; r?: Run }>;
  closeTab: (id: string) => Promise<unknown>;
}

type Pref = "no-preference" | "reduce";

const FEATURE = /\(\s*prefers-reduced-motion(?:\s*:\s*(no-preference|reduce))?\s*\)/g;

/** Makes every `prefers-reduced-motion` media feature of the loaded stylesheets read as `pref`
 *  (a bare `(prefers-reduced-motion)` is `reduce`). Returns how many rules it rewrote and the
 *  undo. */
function emulateMotion(pref: Pref): { rules: number; restore: () => void } {
  const undo: (() => void)[] = [];
  const walk = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule && rule.media.mediaText.includes("prefers-reduced-motion")) {
        const was = rule.media.mediaText;
        rule.media.mediaText = was.replace(FEATURE, (_m, v?: string) => ((v ?? "reduce") === pref ? "(min-width: 0px)" : "(max-width: 0px)"));
        undo.push(() => {
          rule.media.mediaText = was;
        });
      }
      if (rule instanceof CSSGroupingRule) walk(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules);
    } catch {
      // A sheet from another origin has no readable rules, and is not Colony's.
    }
  }
  return { rules: undo.length, restore: () => undo.forEach((f) => f()) };
}

/** The keyframes of the motion contract plus the two that predate it on the same surfaces. */
const CONTRACT = ["mc-spin", "state-pulse", "state-enter", "state-fade", "tr-enter", "gate-flash", "now-stepbar-shimmer"];
/** The keyframes name a loop or a pulse runs (src/styles.css). */
const LOOP_NAME: Partial<Record<Motion, string>> = { loop: "mc-spin", pulse: "state-pulse" };

/** Running CSS animations in `root` (itself and below). Transitions are not CSS animations and
 *  are not listed. A window the compositor is not painting (another workspace, fully covered)
 *  gets no frames: its one-shots are created and stay `running` without ever ending, so a read
 *  may still list them; loops are the ones that never end by design. */
function running(root: Element | null): CSSAnimation[] {
  if (!root) return [];
  return document.getAnimations().filter((a): a is CSSAnimation => a instanceof CSSAnimation && a.playState === "running" && root.contains((a.effect as KeyframeEffect | null)?.target ?? null));
}
/** Their keyframes names. */
const anims = (root: Element | null) => running(root).map((a) => a.animationName).sort();
/** The keyframes names of the ones that repeat forever. */
const loops = (root: Element | null) => running(root).filter((a) => a.effect?.getComputedTiming().iterations === Infinity).map((a) => a.animationName).sort();

interface MarkRead { state: string; cls: string; table: string; ring: boolean; anims: string[]; loops: string[] }

/** The first state mark in `root`: its table state, its motion class, the table's motion, whether
 *  the activity ring is drawn, and what animates in it. */
function mark(root: Element | null): MarkRead | null {
  const m = root?.querySelector<HTMLElement>(".state-mark");
  if (!m) return null;
  const ring = m.querySelector(".state-ring");
  return { state: m.dataset.state ?? "", cls: [...m.classList].find((c) => c.startsWith("motion-")) ?? "", table: m.dataset.motion ?? "", ring: !!ring && getComputedStyle(ring).display !== "none", anims: anims(m), loops: loops(m) };
}

interface Read { at: string; live: boolean; chip: { state: string; text: string; mark: MarkRead | null }; row: MarkRead | null; runView: string[]; missionView: string[] }

/** One surface mark against the table row of `state` under `pref`. Under reduce nothing animates
 *  in it. With motion allowed a loop or a pulse runs its own keyframes (the ring is drawn for a
 *  loop only), and a one-shot or static row never loops. */
function markOk(m: MarkRead | null, state: string, pref: Pref): boolean {
  if (!m) return false;
  const row = stateRow("run", state);
  const name = LOOP_NAME[row.motion];
  if (m.state !== `run:${state}` || m.table !== row.motion) return false;
  if (name && m.cls !== `motion-${row.motion}`) return false;
  if (pref === "reduce") return m.anims.length === 0 && !m.ring;
  return name ? m.loops.join() === name && m.ring === (row.motion === "loop") : m.loops.length === 0 && !m.ring;
}

async function pass(c: MotionSmokeCtx, pref: Pref, step: string) {
  const emu = emulateMotion(pref);
  // Every keyframes name that ran during the pass, sampled whenever the DOM changes: a class or
  // a node that animates has its CSS animation from that moment. `animationstart` would not do:
  // it is dispatched with a frame, and an unpainted window gets none.
  const started = new Set<string>();
  const sample = () => {
    for (const a of document.getAnimations()) if (a instanceof CSSAnimation) started.add(a.animationName);
  };
  const seenBy = new MutationObserver(sample);
  seenBy.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden", "style"] });
  // Diagnostics only: whether this window gets frames (one-shots end only if it does).
  const painted = await Promise.race([new Promise<boolean>((res) => requestAnimationFrame(() => res(true))), c.wait(1000).then(() => false)]);
  let detail: Record<string, unknown> = { pref, rules: emu.rules, painted, visibility: document.visibilityState };
  let ok = false;
  try {
    const { dialog, r } = await c.playRun("smoke-motion");
    detail = { ...detail, dialog, run: r?.id ?? null };
    if (!r) return;
    const tab = `run:${r.id}`;
    const chip = () => c.view(tab).querySelector<HTMLElement>(".run-head .chip");
    const onRun = async () => {
      c.showTab(tab);
      await c.wait(250);
    };
    // The run tab first, then Mission, then the run tab again: a state change always arrives
    // with the transcript visible, so its card enter and the chip's crossfade can play.
    // `settle`: time for a one-shot to end before the cockpit mark is read.
    const read = async (at: string, live: () => boolean, settle = 0): Promise<Read> => {
      await onRun();
      const chipRead = { state: chip()?.dataset.state ?? "", text: chip()?.textContent ?? "", mark: mark(chip()) };
      const runView = anims(c.view(tab));
      await c.onMission();
      if (settle) await c.wait(settle);
      const row = mark(c.view("mission").querySelector(`.run-row[data-launch="${tab}"]`));
      const missionView = anims(c.view("mission"));
      // `live`: the run was still in this state when the last surface was read.
      const still = live();
      await onRun();
      return { at, live: still, chip: chipRead, row, runView, missionView };
    };
    const reads: Read[] = [];
    reads.push(await read("running", () => r.running && !r.gate));
    await c.until(() => !!r.gate || !r.running, 10000);
    await c.wait(300);
    reads.push(await read("gate", () => r.gate?.askId === "smoke-motion-gate"));
    await c.shot(step === "driver-motion" ? "driver-motion-gate" : "driver-motion-reduced-gate");
    c.view(tab).querySelector<HTMLButtonElement>('.tr-gate[data-ask="smoke-motion-gate"] .gate-buttons button[data-reply="1"]')?.click();
    await c.until(() => !r.gate, 3000);
    await c.wait(300);
    reads.push(await read("running", () => r.running && !r.gate));
    await c.until(() => !r.running, 15000);
    await c.wait(700);
    reads.push(await read(runState(r), () => !r.running, 700));
    const el = c.view(tab);
    const cards = {
      start: !!el.querySelector(".tr-card.tr-start"),
      tick: !!el.querySelector(".tr-tick"),
      gate: !!el.querySelector('.tr-gate.answered[data-ask="smoke-motion-gate"]'),
      tickEnd: !!el.querySelector(".tr-card.tr-sum"),
      end: !!el.querySelector(".tr-card.tr-end.ok"),
    };
    const seen = [...started].sort();
    const want = ["running", "gate", "running", "done"];
    const text: Record<string, string> = { running: "running", gate: "waiting for you", done: "exited 0" };
    const surfaces = reads.length === want.length && reads.every((x, i) => x.at === want[i] && x.live && x.chip.state === want[i] && x.chip.text === text[want[i]] && markOk(x.chip.mark, want[i], pref) && markOk(x.row, want[i], pref));
    // Under reduce nothing animates anywhere in the two views, at any state, and none of the
    // contract's keyframes ever ran. With motion allowed every motion of the contract ran: the
    // ring, the gate pulse, the crossfade, the card enter and the one-shot enter.
    const motion = pref === "reduce" ? reads.every((x) => !x.runView.length && !x.missionView.length) && !seen.some((n) => CONTRACT.includes(n)) : ["mc-spin", "state-pulse", "state-fade", "tr-enter", "state-enter"].every((n) => seen.includes(n));
    ok = dialog && emu.rules > 0 && surfaces && motion && Object.values(cards).every(Boolean) && r.exitCode === 0;
    detail = { ...detail, exit: r.exitCode, reason: r.reason, surfaces, motion, cards, started: seen, reads };
    if (!r.running) await c.closeTab(tab);
  } finally {
    seenBy.disconnect();
    emu.restore();
    await c.log(step, ok, detail);
  }
}

export async function motionSmoke(c: MotionSmokeCtx) {
  await pass(c, "no-preference", "driver-motion");
  await pass(c, "reduce", "driver-motion-reduced");
}
