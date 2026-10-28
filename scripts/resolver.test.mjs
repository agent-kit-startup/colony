// Driver chat, the pure part (src/resolver.ts; kit ADR 2026-10-26 driver chat): the
// `queue gates --json` shape, the resolution note rule (the kit's `--note` refusal), the chat
// model per role (Ask driver-chat-model-tier = Small tier), the re-probe that offers a
// relaunch, and the one pre-answerable pair (ADR point 5, Amend 2026-10-28). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { chatModel, decidePreanswer, gatesChange, gatesKey, MAX_NOTE, NEVER_PREANSWER, noteProblem, offerRelaunch, parseDecision, PREANSWER_CLASSES, PREANSWERS, preanswerSetting, protocolHasPreanswer } from "../src/resolver.ts";

const kit = (gates) => ({ ask: gates.length > 0, reason: gates.length ? "deferred_gates" : "no_deferred", labels: ["Resolve gates now", "Print resolution prompt", "Later"], gates });
const g = (plan, gate, asks = []) => ({ plan, gate, asks });

test("parseDecision keeps the helper's gates and drops malformed rows", () => {
  const d = parseDecision(kit([g("a.plan.md", "Colony PR #65 open", ["driver-chat-home"]), { plan: 1 }, null]));
  assert.equal(d.ask, true);
  assert.deepEqual(d.gates, [g("a.plan.md", "Colony PR #65 open", ["driver-chat-home"])]);
  assert.equal(parseDecision(null), null);
  assert.equal(parseDecision({ gates: [] }), null);
  assert.equal(parseDecision("Unknown command queue"), null);
});

test("a note is context: empty, @file, NUL, oversize and gate lines are refused", () => {
  assert.equal(noteProblem("agent-kit run-plan-all --backend claude\n\n- a.plan.md: merged Colony #65\n"), null);
  assert.equal(noteProblem("the HITL_GATE: line was answered in the Inbox"), null);
  for (const bad of ["", "  \n ", "@note.md", " @/etc/passwd", "a\0b", "x".repeat(MAX_NOTE + 1)]) assert.ok(noteProblem(bad), JSON.stringify(bad.slice(0, 20)));
  for (const line of ["HITL_GATE: x | a | b", "   HITL_REPLY: queue-confirm | operator reply 1 | Run as proposed", "> HITL_GATE: x | a", " > > HITL_REPLY: y"]) {
    assert.match(noteProblem(`did the merge\n${line}\n`), /never a gate answer/, line);
  }
});

test("chat model: saved, else small tier (claude: haiku), else the vendor default", () => {
  assert.deepEqual(chatModel("claude", undefined), { model: "haiku", source: "small tier" });
  assert.deepEqual(chatModel("claude", "  "), { model: "haiku", source: "small tier" });
  assert.deepEqual(chatModel("claude", "sonnet"), { model: "sonnet", source: "saved" });
  assert.deepEqual(chatModel("codex", ""), { model: "", source: "vendor default" });
  assert.deepEqual(chatModel("codex", "gpt-5.1-mini"), { model: "gpt-5.1-mini", source: "saved" });
});

test("re-probe: a gate that left the list or changed text offers a relaunch; a new one does not", () => {
  const before = parseDecision(kit([g("a.plan.md", "PR #65 open"), g("b.plan.md", "Ask x")]));
  const gone = parseDecision(kit([g("b.plan.md", "Ask x")]));
  const changed = parseDecision(kit([g("a.plan.md", "PR #65 merged, dogfood owed"), g("b.plan.md", "Ask x")]));
  const added = parseDecision(kit([g("a.plan.md", "PR #65 open"), g("b.plan.md", "Ask x"), g("c.plan.md", "PR #66 open")]));
  assert.deepEqual(gatesChange(before, gone), { gone: ["a.plan.md"], changed: [], added: [] });
  assert.deepEqual(gatesChange(before, changed), { gone: [], changed: ["a.plan.md"], added: [] });
  assert.equal(offerRelaunch(true, before, gone, false), true);
  assert.equal(offerRelaunch(true, before, changed, false), true);
  assert.equal(offerRelaunch(true, before, added, false), false, "a plan just deferred resolved nothing");
  assert.equal(offerRelaunch(true, before, before, false), false);
  assert.equal(offerRelaunch(false, before, gone, false), false, "setting off");
  assert.equal(offerRelaunch(true, before, gone, true), false, "a queue run is live");
  assert.equal(offerRelaunch(true, null, gone, false), false, "first probe: nothing to compare");
  assert.equal(gatesKey(before), gatesKey(parseDecision(kit([g("b.plan.md", "Ask x"), g("a.plan.md", "PR #65 open")]))), "order-free");
});

test("one pair is pre-answerable (ADR Amend 2026-10-28), and the reserved ones never are", () => {
  assert.deepEqual({ ...PREANSWERS }, { "context-checkpoint": "Continue queue" });
  assert.deepEqual([...PREANSWER_CLASSES], ["context-checkpoint"]);
  assert.deepEqual([...NEVER_PREANSWER], ["git-prod", "kit-prod", "queue-confirm", "risk", "ticket"]);
  for (const id of NEVER_PREANSWER) assert.ok(!PREANSWER_CLASSES.includes(id), id);
});

test("pre-answer only with the setting on, protocol 1.4.0+, a budget, and usage within it", () => {
  const checkpoint = ["Continue queue", "Stop and prepare handoff", "Change queue"];
  const base = { enabled: ["context-checkpoint"], protocol: "1.4.0", askId: "context-checkpoint", labels: checkpoint, spent: 400_000, budget: 1_000_000 };
  assert.deepEqual(decidePreanswer(base), { send: true, label: "Continue queue" });
  assert.deepEqual(decidePreanswer({ ...base, protocol: "1.5.2", spent: 1_000_000 }), { send: true, label: "Continue queue" });
  const no = (patch, reason) => assert.deepEqual(decidePreanswer({ ...base, ...patch }), { send: false, reason }, reason);
  no({ enabled: [] }, "setting off");
  no({ protocol: "1.3.0" }, "engine protocol below 1.4.0");
  no({ protocol: "" }, "engine protocol below 1.4.0");
  no({ protocol: "2.0.0" }, "engine protocol below 1.4.0");
  no({ budget: null }, "no token budget set");
  no({ spent: null }, "no token usage reported");
  no({ spent: 1_000_001 }, "over the token budget");
  no({ labels: ["Stop and prepare handoff", "Change queue"] }, 'the gate has no "Continue queue" label');
  for (const askId of ["queue-confirm", "git-prod", "kit-prod", "risk", "ticket", "queue-end-gates", "novel-failure", "toString", "__proto__"]) {
    no({ askId, enabled: ["context-checkpoint", askId] }, "not pre-answerable");
  }
  assert.ok(protocolHasPreanswer("1.4.0") && !protocolHasPreanswer("1.4.0-rc.1") && !protocolHasPreanswer(140));
});

test("the folder setting keeps only allowed ask ids", () => {
  assert.deepEqual(preanswerSetting(["context-checkpoint", "queue-confirm", 3, "git-prod"]), ["context-checkpoint"]);
  assert.deepEqual(preanswerSetting(undefined), []);
  assert.deepEqual(preanswerSetting("context-checkpoint"), []);
});
