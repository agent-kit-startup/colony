// The Current mission card's action row (src/missioncard.ts): Play/Stop, Open, Edit, Cancel,
// Plans and the secondary Kill, per run state (shell ADR amend 2026-10-29 point 1; driver
// protocol 1.5.0 stop_after_tick). Pure: Node runs it with its types stripped. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cardButtons, protocolHasStopAfterTick, STOP_AFTER_TICK_PROTOCOL } from "../src/missioncard.ts";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const plan = "demo-2026-11-10.plan.md";
const idle = { plan, run: null, terminal: "", busy: "" };
const run = (o = {}) => ({ id: 7, command: "run-plan", gate: "", protocol: "1.5.0", stopRequested: false, ...o });
const busy = "Run #7 is going in this folder";
const ids = (bs) => bs.map((b) => b.id);
const by = (bs, id) => bs.find((b) => b.id === id);
const toggle = (o) => by(cardButtons(o), "toggle");

test("the row is Play/Stop, Open, Edit, Cancel, Plans, in that order", () => {
  assert.deepEqual(ids(cardButtons(idle)), ["toggle", "open", "edit", "cancel", "plans"]);
});

test("idle: Play is the toggle and every button is on", () => {
  const bs = cardButtons(idle);
  assert.equal(by(bs, "toggle").face, "play");
  assert.equal(by(bs, "toggle").icon, "play");
  assert.ok(bs.every((b) => !b.disabled), JSON.stringify(bs.filter((b) => b.disabled)));
});

test("running on a 1.5.0 engine with no gate: Stop sends a stop after the tick, Kill is secondary, Cancel is off", () => {
  const bs = cardButtons({ ...idle, run: run(), busy });
  assert.deepEqual(ids(bs), ["toggle", "open", "edit", "cancel", "plans", "kill"]);
  const t = by(bs, "toggle");
  assert.equal(t.face, "stop-after-tick");
  assert.equal(t.icon, "stop");
  assert.equal(t.disabled, false);
  assert.match(t.title, /after the current tick/);
  assert.equal(by(bs, "cancel").disabled, true);
  assert.match(by(bs, "cancel").title, /^Run #7 is going in this folder: stop it first/);
  assert.equal(by(bs, "kill").disabled, false);
});

test("a newer 1.x engine also takes the stop after the tick", () => {
  assert.equal(toggle({ ...idle, run: run({ protocol: "1.9.2" }), busy }).face, "stop-after-tick");
});

test("at a gate: Stop at the gate, on any engine", () => {
  for (const protocol of ["1.5.0", "1.4.0", "1.2.0", ""]) {
    const t = toggle({ ...idle, run: run({ gate: "smoke-card-gate", protocol }), busy });
    assert.equal(t.face, "stop-gate", protocol);
    assert.match(t.title, /smoke-card-gate/);
  }
});

test("a pre-1.5.0 engine with no gate: the toggle is Kill (it asks first), no second Kill", () => {
  for (const protocol of ["1.4.0", "1.2.0", "1.5.0-rc.1", "2.0.0", ""]) {
    const bs = cardButtons({ ...idle, run: run({ protocol }), busy });
    assert.equal(by(bs, "toggle").face, "kill", protocol);
    assert.equal(by(bs, "toggle").label, "Kill…");
    assert.equal(bs.filter((b) => b.face === "kill" || b.id === "kill").length, 1, protocol);
  }
  assert.match(toggle({ ...idle, run: run({ protocol: "" }), busy }).title, /not reported yet/);
});

test("after the stop request: Stopping… is off until the run ends, Kill stays", () => {
  const bs = cardButtons({ ...idle, run: run({ stopRequested: true }), busy });
  assert.equal(by(bs, "toggle").face, "stopping");
  assert.equal(by(bs, "toggle").disabled, true);
  assert.equal(by(bs, "kill").disabled, false);
});

test("a queue run: the stop after the tick ends it at its next gate", () => {
  const t = toggle({ ...idle, run: run({ command: "run-plan-all" }), busy: "Queue run #7 is going in this folder" });
  assert.equal(t.face, "stop-after-tick");
  assert.match(t.title, /next gate/);
});

test("a terminal tab on the plan: Stop is off and points at the tab; no Kill", () => {
  const bs = cardButtons({ ...idle, terminal: "claude · demo", busy: "claude · demo is going in a terminal tab" });
  assert.equal(by(bs, "toggle").face, "terminal");
  assert.equal(by(bs, "toggle").disabled, true);
  assert.match(by(bs, "toggle").title, /terminal tab/);
  assert.equal(by(bs, "cancel").disabled, true);
  assert.equal(by(bs, "kill"), undefined);
});

test("no plan: Play, Open, Edit and Cancel are off with the reason; Plans stays on", () => {
  const bs = cardButtons({ ...idle, plan: "" });
  for (const id of ["toggle", "open", "edit", "cancel"]) {
    assert.equal(by(bs, id).disabled, true, id);
    assert.match(by(bs, id).title, /no plan/, id);
  }
  assert.equal(by(bs, "plans").disabled, false);
});

test("Plans opens the Plans view (the card's click handler calls showTab(\"plans\"))", () => {
  const src = readFileSync(join(SRC, "cockpit.ts"), "utf8");
  assert.match(src, /b\.id === "plans"\) return this\.host\.showTab\("plans"\)/);
  assert.equal(by(cardButtons(idle), "plans").icon, "plans");
});

test("every button keeps a tooltip, a label and its own data-act (never the top bar's run-plan)", () => {
  for (const o of [idle, { ...idle, run: run(), busy }, { ...idle, run: run({ gate: "g" }), busy }, { ...idle, run: run({ protocol: "1.4.0" }), busy }]) {
    for (const b of cardButtons(o)) {
      assert.ok(b.label && b.title.length > 10, b.id);
      assert.match(b.act, /^card-/);
      assert.notEqual(b.act, "run-plan");
    }
  }
});

test("protocolHasStopAfterTick: 1.x from 1.5.0, no pre-release, nothing else", () => {
  assert.equal(STOP_AFTER_TICK_PROTOCOL, "1.5.0");
  for (const ok of ["1.5.0", "1.5.1", "1.10.0", " 1.6.0 "]) assert.equal(protocolHasStopAfterTick(ok), true, ok);
  for (const no of ["1.4.0", "1.2.0", "1.5.0-rc.1", "2.0.0", "0.5.0", "", null, undefined, 150]) assert.equal(protocolHasStopAfterTick(no), false, String(no));
});

test("the hero carries no plan CRUD dropdown and no top bar action ids", () => {
  const src = readFileSync(join(SRC, "cockpit.ts"), "utf8");
  const hero = src.slice(src.indexOf("  private hero(): HTMLElement {"), src.indexOf("  private cardRow("));
  assert.ok(hero.length > 500);
  assert.doesNotMatch(hero, /planCrudButton|"data-act": "run-plan"|"data-act": "run-queue"/);
});
