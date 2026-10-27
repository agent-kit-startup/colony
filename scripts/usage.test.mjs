// Token usage and budget, the pure part (src/usage.ts): driver protocol 1.3.0 `usage` on
// `tick_end` / `run_end` (kit docs/driver-events-protocol.md "Token usage"), read only when the
// run's `run_start.protocol` is 1.3.0 or newer. No parsing of agent_event. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { addUsage, budgetState, formatTokens, parseBudget, protocolHasUsage, readUsage, USAGE_PROTOCOL, usageText } from "../src/usage.ts";

const u = (inputTokens, outputTokens, cachedInputTokens = null) => ({ inputTokens, cachedInputTokens, outputTokens, totalTokens: inputTokens + outputTokens });

test("usage is read only from driver protocol 1.3.0 or newer (same major)", () => {
  assert.equal(USAGE_PROTOCOL, "1.3.0");
  for (const p of ["1.3.0", "1.3.7", "1.4.0", "1.10.2"]) assert.equal(protocolHasUsage(p), true, p);
  for (const p of ["1.2.0", "1.2.9", "1.1.0", "1.3.0-rc.1", "2.0.0", "0.9.0", "", "x", undefined, null, 130]) assert.equal(protocolHasUsage(p), false, String(p));
});

test("readUsage keeps the kit's shape and refuses anything else (never invents numbers)", () => {
  assert.deepEqual(readUsage(u(579288, 11131, 426236)), u(579288, 11131, 426236));
  assert.deepEqual(readUsage(u(3, 2)), u(3, 2));
  assert.equal(readUsage(null), null);
  assert.equal(readUsage(undefined), null);
  assert.equal(readUsage({}), null);
  assert.equal(readUsage({ inputTokens: 1, outputTokens: 2 }), null, "totalTokens missing");
  assert.equal(readUsage({ ...u(1, 2), totalTokens: 4 }), null, "total is not input + output");
  assert.equal(readUsage({ ...u(1, 2), inputTokens: -1, totalTokens: 1 }), null);
  assert.equal(readUsage({ ...u(1, 2), outputTokens: 2.5, totalTokens: 3.5 }), null);
  assert.equal(readUsage({ ...u(1, 2), cachedInputTokens: "0" }), null);
  assert.equal(readUsage({ ...u(10, 2), cachedInputTokens: 11 }), null, "cached is part of input");
});

test("addUsage sums, and is null only when both are", () => {
  assert.equal(addUsage(null, null), null);
  assert.deepEqual(addUsage(u(1, 2), null), u(1, 2));
  assert.deepEqual(addUsage(null, u(1, 2, 1)), u(1, 2, 1));
  assert.deepEqual(addUsage(u(1, 2), u(3, 4, 2)), u(4, 6, 2));
  assert.deepEqual(addUsage(u(1, 2), u(3, 4)), u(4, 6));
});

test("token counts read short", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1.0k");
  assert.equal(formatTokens(590419), "590.4k");
  assert.equal(formatTokens(12_345_678), "12.3M");
});

test("usage text: no usage on an old engine, none reported, or the total with its parts", () => {
  assert.equal(usageText(false, null), "no usage (engine protocol below 1.3.0)");
  assert.equal(usageText(true, null), "no usage reported");
  assert.equal(usageText(true, u(579288, 11131, 426236)), "590.4k tokens (579.3k in, 426.2k cached, 11.1k out)");
  assert.equal(usageText(true, u(10, 5)), "15 tokens (10 in, 5 out)");
});

test("budget: empty is none; a positive integer is a budget; anything else is invalid", () => {
  assert.equal(parseBudget(""), null);
  assert.equal(parseBudget("  "), null);
  assert.equal(parseBudget(undefined), null);
  assert.equal(parseBudget(null), null);
  assert.equal(parseBudget("500000"), 500000);
  assert.equal(parseBudget(" 2_000_000 "), 2000000);
  assert.equal(parseBudget("1,500"), 1500);
  assert.equal(parseBudget(250000), 250000);
  for (const bad of ["0", "-5", "1.5", "abc", "1e6", 0, -1, 2.5]) assert.equal(parseBudget(bad), "invalid", String(bad));
});

test("budget state is informational: none, within or over (never a stop)", () => {
  assert.equal(budgetState(null, 100), "none");
  assert.equal(budgetState(u(10, 5), null), "none");
  assert.equal(budgetState(u(10, 5), 15), "within");
  assert.equal(budgetState(u(10, 6), 15), "over");
});
