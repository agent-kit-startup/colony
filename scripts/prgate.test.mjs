// Merge method and merge gate of the Git tab's PRs (src/prgate.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { isStagingSync, mergeBlock, prMethod } from "../src/prgate.ts";

const ok = { head: "feat/x", base: "staging", draft: false, mergeable: "MERGEABLE", pendingChecks: 0 };

test("staging -> main and the staging sync keep a merge commit, the rest squash", () => {
  assert.equal(prMethod("staging", "main"), "merge");
  assert.equal(prMethod("staging", "master"), "merge");
  assert.equal(prMethod("chore/sync-staging-main-578dc26", "staging"), "merge");
  assert.equal(prMethod("chore/close-release-6.9.1", "staging"), "squash");
  assert.equal(prMethod("feat/x", "staging"), "squash");
  assert.equal(prMethod("staging", "release"), "squash");
  // A sync-named branch into main is not the staging sync.
  assert.equal(prMethod("chore/sync-staging-main-578dc26", "main"), "squash");
  assert.equal(isStagingSync("chore/sync-staging-main-578dc26", "main"), false);
});

test("Merge only when mergeable and no check is running", () => {
  assert.equal(mergeBlock(ok), null);
  assert.equal(mergeBlock({ ...ok, mergeable: "mergeable" }), null, "the snapshot lowercases the word");
  assert.equal(mergeBlock({ ...ok, draft: true }), "draft");
  assert.equal(mergeBlock({ ...ok, mergeable: "conflicting" }), "conflicts");
  assert.equal(mergeBlock({ ...ok, mergeable: "UNKNOWN" }), "mergeability not known yet");
  assert.equal(mergeBlock({ ...ok, mergeable: "" }), "mergeability not known yet");
  assert.equal(mergeBlock({ ...ok, pendingChecks: 2 }), "checks running");
});
