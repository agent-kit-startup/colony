// Driver chat, the pure part (src/resolver.ts; kit ADR 2026-10-26 driver chat): the
// `queue gates --json` shape, the resolution note rule (the kit's `--note` refusal), the chat
// model per role (Ask driver-chat-model-tier = Small tier), the re-probe that offers a
// relaunch, and the empty pre-answer allowlist (ADR point 5). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { chatModel, gatesChange, gatesKey, MAX_NOTE, NEVER_PREANSWER, noteProblem, offerRelaunch, parseDecision, PREANSWER_CLASSES } from "../src/resolver.ts";

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

test("no Ask class is pre-answerable (ADR point 5), and the reserved ones never are", () => {
  assert.deepEqual([...PREANSWER_CLASSES], []);
  assert.deepEqual([...NEVER_PREANSWER], ["git-prod", "kit-prod", "queue-confirm", "risk", "ticket"]);
});
