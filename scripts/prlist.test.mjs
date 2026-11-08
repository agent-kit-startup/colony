// The Git tab's PR list: state, action, check badge, Bot, filters, bulk targets (src/prlist.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { authorName, authors, bulkTargets, checkBadge, filterPrs, isBot, NO_FILTER, needsAction, prAction, prState } from "../src/prlist.ts";

const run = (name, conclusion, status = "COMPLETED") => ({ __typename: "CheckRun", name, status, conclusion });
const green = [run("build", "SUCCESS"), run("lint", "SUCCESS")];
const pr = (over = {}) => ({ number: 1, title: "t", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", isDraft: false, statusCheckRollup: green, author: { login: "dadado", is_bot: false }, ...over });

test("one state per PR, in order", () => {
  assert.equal(prState(pr()), "ready");
  assert.equal(prState(pr({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })), "conflicts");
  assert.equal(prState(pr({ mergeStateStatus: "DIRTY", mergeable: "UNKNOWN" })), "conflicts");
  assert.equal(prState(pr({ mergeStateStatus: "BEHIND" })), "behind");
  assert.equal(prState(pr({ mergeStateStatus: "BEHIND", statusCheckRollup: [run("lint", "FAILURE")] })), "behind", "updating the branch reruns the checks");
  assert.equal(prState(pr({ isDraft: true })), "draft");
  assert.equal(prState(pr({ statusCheckRollup: [run("build", null, "IN_PROGRESS")] })), "checks running");
  assert.equal(prState(pr({ statusCheckRollup: [run("signature-scan", "FAILURE"), run("build", "SUCCESS")] })), "failing");
  assert.equal(prState(pr({ mergeStateStatus: "BLOCKED" })), "blocked");
  assert.equal(prState(pr({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" })), "checking");
  assert.equal(prState(pr({ statusCheckRollup: [] })), "ready", "no checks configured");
});

test("each state offers at most one action; none while checks run", () => {
  assert.equal(prAction("conflicts"), "resolve");
  assert.equal(prAction("behind"), "update-branch");
  assert.equal(prAction("ready"), "merge");
  for (const st of ["draft", "checks running", "failing", "blocked", "checking"]) assert.equal(prAction(st), null, st);
  assert.ok(needsAction("failing") && needsAction("behind") && !needsAction("checks running") && !needsAction("draft"));
});

test("check badge: passed/total, failing names", () => {
  assert.deepEqual(checkBadge(green), { passed: 2, total: 2, pending: 0, failing: [], text: "2/2", tone: "done" });
  const b = checkBadge([run("build", "SUCCESS"), run("lint", "FAILURE"), { __typename: "StatusContext", context: "ci/legacy", state: "ERROR" }, run("e2e", null, "QUEUED")]);
  assert.equal(b.text, "1/4");
  assert.deepEqual(b.failing, ["lint", "ci/legacy"]);
  assert.equal(b.tone, "failed");
  assert.equal(checkBadge(undefined).text, "no checks");
  assert.equal(checkBadge([run("x", null, "IN_PROGRESS")]).tone, "gate");
});

test("Bot: gh is_bot, app/ logins, [bot] suffix", () => {
  assert.ok(isBot({ login: "app/dependabot", is_bot: true }));
  assert.ok(isBot({ login: "app/agent-kit-idle" }));
  assert.ok(isBot({ login: "renovate[bot]" }));
  assert.ok(!isBot({ login: "dadado", is_bot: false }));
  assert.ok(!isBot(undefined));
  assert.equal(authorName({ login: "app/dependabot" }), "dependabot");
  assert.equal(authorName(null), "?");
});

test("filters: author, bot or human, needs action", () => {
  const list = [
    pr({ number: 1 }),
    pr({ number: 2, author: { login: "app/dependabot", is_bot: true }, mergeStateStatus: "BEHIND" }),
    pr({ number: 3, author: { login: "app/dependabot", is_bot: true }, statusCheckRollup: [run("b", null, "IN_PROGRESS")] }),
    pr({ number: 4, author: { login: "mallory" }, isDraft: true }),
  ];
  const nums = (f) => filterPrs(list, { ...NO_FILTER, ...f }).map((p) => p.number);
  assert.deepEqual(nums({}), [1, 2, 3, 4]);
  assert.deepEqual(nums({ who: "bot" }), [2, 3]);
  assert.deepEqual(nums({ who: "human" }), [1, 4]);
  assert.deepEqual(nums({ author: "mallory" }), [4]);
  assert.deepEqual(nums({ needsAction: true }), [1, 2]);
  assert.deepEqual(nums({ who: "bot", needsAction: true }), [2]);
  assert.deepEqual(authors(list), ["app/dependabot", "dadado", "mallory"]);
});

test("bulk: update branch only for behind PRs, close for any selected; never merge", () => {
  const list = [pr({ number: 1 }), pr({ number: 2, mergeStateStatus: "BEHIND" }), pr({ number: 3, mergeStateStatus: "BEHIND" }), pr({ number: 4, mergeable: "CONFLICTING" })];
  const sel = new Set([1, 2, 4]);
  assert.deepEqual(bulkTargets(list, sel, "update-branch"), [2]);
  assert.deepEqual(bulkTargets(list, sel, "close-pr"), [1, 2, 4]);
});

test("Resolve terminal: values are positional arguments, never script text", async () => {
  const { resolveArgv, RESOLVE_SCRIPT } = await import("../src/prlist.ts");
  const w = { number: 5, path: "/tmp/repo-pr-5; rm -rf ~", branch: "feat/x", base: "staging", reused: false, conflicted: ["a.txt"], kit: ["/usr/bin/node", "/e/index.js"], note: "" };
  const argv = resolveArgv(w);
  assert.deepEqual(argv.slice(0, 2), ["sh", "-c"]);
  assert.deepEqual(argv.slice(3), ["colony-resolve", "/tmp/repo-pr-5; rm -rf ~", "/usr/bin/node", "/e/index.js"]);
  assert.ok(!RESOLVE_SCRIPT.includes("repo-pr-5") && RESOLVE_SCRIPT.includes('"$@" conflicts propose "$f"') && RESOLVE_SCRIPT.includes("set -f"));
});

test("Resolve terminal script runs in sh: lists conflicts, proposes per file, ends in a shell", async () => {
  const { RESOLVE_SCRIPT } = await import("../src/prlist.ts");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const d = mkdtempSync(join(tmpdir(), "colony-resolve-"));
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: d, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  writeFileSync(join(d, "a b.txt"), "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "side");
  writeFileSync(join(d, "a b.txt"), "side\n");
  git("commit", "-q", "-am", "side");
  git("checkout", "-q", "main");
  writeFileSync(join(d, "a b.txt"), "main\n");
  git("commit", "-q", "-am", "main");
  try { git("merge", "-q", "side"); } catch {}
  const kit = join(d, "kit.sh");
  writeFileSync(kit, '#!/bin/sh\necho "kit: $*"\n');
  chmodSync(kit, 0o755);
  const out = execFileSync("sh", ["-c", RESOLVE_SCRIPT, "colony-resolve", d, kit], { env: { ...process.env, SHELL: "/bin/true" } }).toString();
  assert.match(out, /kit: conflicts\n/);
  assert.match(out, /kit: conflicts propose a b\.txt/);
});

test("Checks tab rows: name, state, duration, link; failing first", async () => {
  const { checkRows } = await import("../src/prlist.ts");
  const rows = checkRows([
    { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-08T10:00:00Z", completedAt: "2026-11-08T10:01:02Z", detailsUrl: "https://github.com/x/y/runs/1" },
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-08T10:00:00Z", completedAt: "2026-11-08T10:00:12Z", detailsUrl: "javascript:alert(1)" },
    { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: null, startedAt: "2026-11-08T10:00:00Z" },
    { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", targetUrl: "https://ci.example/1" },
  ]);
  assert.deepEqual(rows.map((r) => [r.name, r.state, r.tone, r.duration, r.url]), [
    ["lint", "failure", "failed", "12s", ""],
    ["e2e", "in progress", "gate", "", ""],
    ["build", "success", "done", "1m 02s", "https://github.com/x/y/runs/1"],
    ["ci/legacy", "success", "done", "", "https://ci.example/1"],
  ]);
});

test("merge box blockers in words", async () => {
  const { mergeBlockers } = await import("../src/prlist.ts");
  const base = pr({ state: "OPEN", baseRefName: "staging", isCrossRepository: false });
  assert.deepEqual(mergeBlockers(base), []);
  assert.deepEqual(mergeBlockers({ ...base, state: "MERGED" }), ["Merged already."]);
  assert.match(mergeBlockers({ ...base, mergeable: "CONFLICTING" })[0], /^Conflicts with staging/);
  assert.match(mergeBlockers({ ...base, mergeStateStatus: "BEHIND" })[0], /^Behind staging/);
  assert.deepEqual(mergeBlockers({ ...base, statusCheckRollup: [run("lint", "FAILURE"), run("e2e", null, "QUEUED")] }), ["1 check(s) still running.", "Failing: lint."]);
  assert.deepEqual(mergeBlockers({ ...base, mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }), ["A review is required."]);
  assert.deepEqual(mergeBlockers({ ...base, mergeStateStatus: "BLOCKED" }), ["Blocked by the rules of staging."]);
  assert.match(mergeBlockers({ ...base, baseRefName: "main", isCrossRepository: true })[0], /fork PR into main/);
  assert.deepEqual(mergeBlockers({ ...base, baseRefName: "main", isCrossRepository: false }), [], "a same-repo promote is mergeable (typed yes on the card)");
});
