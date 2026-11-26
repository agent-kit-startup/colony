// Run with context (src/launchctx.ts, kit ADR 2026-10-22 amend 2026-11-16): the prompt a
// launch builds from a catalog row's `context`, the checks that mirror vendor.rs, and the
// confirm rule (production and project rows only). Pure: Node runs it with its types
// stripped. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { composePrompt, contextLabel, contextOf, GOAL_COMMANDS, goalError, MAX_GOAL, needsConfirm, PROD_ONLY, promptName, tokenError } from "../src/launchctx.ts";

const vendor = readFileSync(new URL("../src-tauri/src/vendor.rs", import.meta.url), "utf8");
const rustList = (name) => {
  const m = new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\]`).exec(vendor);
  assert.ok(m, `vendor.rs has no ${name}`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
};

test("the goal and production sets are vendor.rs's GOAL_CONTEXT and INTERACTIVE_ONLY", () => {
  assert.deepEqual([...GOAL_COMMANDS].sort(), rustList("GOAL_CONTEXT").sort());
  assert.deepEqual([...PROD_ONLY].sort(), rustList("INTERACTIVE_ONLY").sort());
  assert.equal(MAX_GOAL, Number(/pub const MAX_CONTEXT: usize = (\d+);/.exec(vendor)?.[1]));
});

test("a goal launches as one prompt with the typed text, newlines kept", () => {
  assert.deepEqual(composePrompt("backlog-add", "goal", "  add a dark mode toggle  "), { prompt: "/backlog-add add a dark mode toggle" });
  assert.deepEqual(composePrompt("hotfix", "goal", "login 500\nafter deploy"), { prompt: "/hotfix login 500\nafter deploy" });
  assert.deepEqual(composePrompt("start-project", "goal", "café ünïcode ok"), { prompt: "/start-project café ünïcode ok" });
});

test("an empty value launches the bare command (it asks in the session)", () => {
  for (const c of ["goal", "plan", "branch", "pr", "sha", "none"]) assert.deepEqual(composePrompt("qa", c, "   "), { prompt: "/qa" }, c);
  assert.deepEqual(composePrompt("summary", "none", "ignored text"), { prompt: "/summary" });
});

test("goals refuse what vendor.rs valid_context refuses", () => {
  for (const bad of ["a\u0000b", "tab\there", "cr\rhere", "esc\u001b[31m", "bidi\u202Eevil", "zero\u200Bwidth", "bom\uFEFFin", "c1\u0085"]) {
    const r = composePrompt("hotfix", "goal", bad);
    assert.ok("error" in r, JSON.stringify(bad));
  }
  assert.ok("error" in composePrompt("hotfix", "goal", "x".repeat(MAX_GOAL + 1)));
  // The cap is in UTF-8 bytes, like Rust's str::len.
  assert.ok("error" in composePrompt("hotfix", "goal", "é".repeat(MAX_GOAL / 2 + 1)));
  assert.ok("prompt" in composePrompt("hotfix", "goal", "x".repeat(MAX_GOAL)));
  assert.equal(goalError("fine"), "");
});

test("plan, branch, PR and SHA take one plain token, like vendor.rs valid_token", () => {
  assert.deepEqual(composePrompt("backlog-edit", "plan", "a-b.plan.md"), { prompt: "/backlog-edit a-b.plan.md" });
  assert.deepEqual(composePrompt("git-staging", "branch", "feat/x_1"), { prompt: "/git-staging feat/x_1" });
  assert.deepEqual(composePrompt("git-prod", "sha", "a192a5e3"), { prompt: "/git-prod a192a5e3" });
  for (const bad of ["two words", "-rf", "a/../b", "..", "a;b", "a$b", "x".repeat(241), "plan\n.md"]) {
    assert.ok("error" in composePrompt("backlog-edit", "plan", bad), bad);
    assert.notEqual(tokenError(bad), "", bad);
  }
});

test("a project row takes one token even when it declares a goal", () => {
  assert.ok("error" in composePrompt("deploy-site", "goal", "two words", true));
  assert.deepEqual(composePrompt("deploy-site", "goal", "prod", true), { prompt: "/deploy-site prod" });
});

test("a name outside the catalog grammar never builds a prompt", () => {
  for (const bad of ["Git-Prod", "-x", "a b", "", "x".repeat(65), "../x"]) assert.ok("error" in composePrompt(bad, "none", ""), bad);
});

test("the native confirm: production always, project rows, nothing else", () => {
  for (const p of ["/git-prod", "/git-prod abc123", "/kit-prod"]) assert.ok(needsConfirm(p), p);
  for (const p of ["/run-plan a.plan.md", "/backlog-add a goal", "/git-staging feat/x", "/hotfix x", "/start-project"]) assert.ok(!needsConfirm(p), p);
  assert.ok(needsConfirm("/deploy-site", true));
  assert.equal(promptName("/hotfix fix\nthe thing"), "hotfix");
});

test("catalog context values: unknown or missing reads as none; each context has a composer label", () => {
  assert.equal(contextOf(undefined), "none");
  assert.equal(contextOf("everything"), "none");
  assert.equal(contextOf("goal"), "goal");
  assert.equal(contextLabel("summary", "none"), "");
  for (const c of ["goal", "plan", "branch", "pr", "sha"]) assert.match(contextLabel("x", c), /^\/x: /, c);
});
