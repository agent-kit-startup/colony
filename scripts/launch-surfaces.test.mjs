// Run with context, per launch surface (kit plan colony-commands-run-with-context c6; ADR
// 2026-10-22 commands-catalog contract, amend 2026-11-16): what each surface hands the host.
// The command palette is built on the small DOM of ./test-dom.mjs with a fake catalog
// (catalog 1.1.0 rows as catalog.rs serialises them) and a fake host that records calls;
// the Ship lane's slash-step parser and the Inbox allowlist are checked directly. The exact
// prompt each launch builds is scripts/launchctx.test.mjs; Rust re-checks it (vendor.rs).
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { elements, setInvoke } from "./test-dom.mjs";

const { CommandPalette } = await import("../src/palette.ts");
const { slashStep } = await import("../src/shiplane.ts");

const row = (name, o = {}) => ({ name, description: `${name} row`, layer: "kit", headless: false, run: true, context: "none", interactiveOnly: false, audience: "user", hidden: false, ...o });

/** A consumer workspace on catalog 1.1.0: review-pack is meta, so Rust marked it hidden. */
const CONSUMER = {
  catalogVersion: "1.1.0",
  kitVersion: "6.22.0",
  dropped: 0,
  factory: false,
  commands: [
    row("backlog-add", { context: "goal", headless: true }),
    row("git-staging", { context: "branch", headless: true }),
    row("git-prod", { context: "sha", interactiveOnly: true }),
    row("review-pack", { audience: "meta", hidden: true, run: false, headless: true }),
    row("deploy-site", { layer: "project" }),
    row("old-thing", { run: false }),
  ],
};

/** The factory workspace: meta rows are listed and run. */
const FACTORY = {
  ...CONSUMER,
  factory: true,
  commands: [row("review-pack", { audience: "meta", headless: true }), row("kit-prod", { layer: "factory", audience: "meta", context: "sha", interactiveOnly: true })],
};

function palette(catalog) {
  const calls = [];
  setInvoke(async (cmd) => {
    if (cmd === "commands_catalog") return catalog;
    throw new Error(`unexpected invoke ${cmd}`);
  });
  const p = new CommandPalette({
    status: (m) => calls.push(["status", m]),
    hasFolder: () => true,
    launch: async (r, why) => calls.push(["launch", r.name, why]),
    typeBuiltin: async (n) => calls.push(["type", n]),
    showEngine: () => calls.push(["engine"]),
    openClaude: async () => calls.push(["openClaude"]),
    actions: () => [],
    runAction: (id) => calls.push(["action", id]),
  });
  return { p, calls };
}

const pick = (p, sel) => {
  const el = elements(p.el).find(sel);
  assert.ok(el, "row rendered");
  el.dispatchEvent({ type: "mousedown", preventDefault() {}, stopPropagation() {} });
};

test("palette: a meta row is hidden in a consumer workspace; every shown runnable row launches with its row", async () => {
  const { p, calls } = palette(CONSUMER);
  await p.show();
  assert.deepEqual(p.rows().map((r) => r.name), ["backlog-add", "git-staging", "git-prod", "deploy-site", "old-thing"]);
  assert.ok(!elements(p.el).some((e) => e.dataset.name === "review-pack"), "review-pack not rendered");
  for (const name of ["backlog-add", "git-staging", "git-prod", "deploy-site"]) {
    pick(p, (e) => e.dataset.name === name);
    const last = calls.at(-1);
    assert.deepEqual(last.slice(0, 2), ["launch", name], name);
    assert.match(last[2], /^Command palette: /);
  }
  // A row Colony does not run is a copy, never a launch.
  const before = calls.filter((c) => c[0] === "launch").length;
  pick(p, (e) => e.dataset.name === "old-thing");
  assert.equal(calls.filter((c) => c[0] === "launch").length, before);
});

test("palette: meta rows are listed and run in the factory workspace", async () => {
  const { p, calls } = palette(FACTORY);
  await p.show();
  assert.deepEqual(p.rows().map((r) => r.name), ["review-pack", "kit-prod"]);
  pick(p, (e) => e.dataset.name === "kit-prod");
  assert.deepEqual(calls.at(-1).slice(0, 2), ["launch", "kit-prod"]);
});

test("palette: a Claude Code built-in is typed into the Claude terminal, not copied", async () => {
  const { p, calls } = palette(CONSUMER);
  await p.show();
  pick(p, (e) => e.dataset.name === "compact" && e.className.includes("palette-builtin"));
  assert.deepEqual(calls.at(-1), ["type", "compact"]);
});

test("Ship lane: a next step that is one slash command (with at most one argument) gets Run", () => {
  assert.deepEqual(slashStep("/git-prod"), { name: "git-prod", arg: "" });
  assert.deepEqual(slashStep(" /git-staging feat/x "), { name: "git-staging", arg: "feat/x" });
  assert.deepEqual(slashStep("/kit-prod abc123"), { name: "kit-prod", arg: "abc123" });
  for (const t of ["gh pr checks 12", "gh run rerun 99 --failed", "/git-prod a b", "/Git-Prod", "", "git-prod", "/x; rm -rf /"]) assert.equal(slashStep(t), null, t);
});

test("Inbox: Ask agent covers the user commands but never git-prod or kit-prod, and refuses what Rust would", () => {
  const src = readFileSync(new URL("../src/inbox.ts", import.meta.url), "utf8");
  const ASKABLE = new Function(`return ${/export const ASKABLE = (\/.*\/);/.exec(src)[1]}`)();
  for (const ok of ["/run-plan a.plan.md", "/git-staging feat/x", "/hotfix", "/field-report-resolve fr-1", "/plan-review-triage .cursor/plans/x.md"]) assert.ok(ASKABLE.test(ok), ok);
  for (const bad of ["/git-prod", "/git-prod abc", "/kit-prod", "/run-plan -x", "/run-plan ../x", "/run-plan a/../b", "/hotfix two words", "/review-pack"]) assert.ok(!ASKABLE.test(bad), bad);
});
