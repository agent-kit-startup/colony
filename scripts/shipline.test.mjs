// The Ship lane status line and the staging vs main reads (src/shipline.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mainInStaging, shipLine, stagingAhead } from "../src/shipline.ts";

const green = [{ id: "release-close", state: "green" }, { id: "staging-main", state: "green" }];
const forge = (c) => ({ source: "forge", fetchedAt: "2026-11-08T12:03:00Z", ahead: 0, behind: 0, release: 0, merge: 0, docs: 0, ...c });

test("nothing to ship: merge-back and docs commits only (the 2026-11-07 case)", () => {
  const lane = { local: { latestTag: "v6.14.0", stagingAheadOfMain: 2 }, remote: { available: true, fetchedAt: "2026-11-08T12:03:00Z" }, compare: forge({ ahead: 2, merge: 1, docs: 1 }), rows: green };
  const l = shipLine(lane);
  assert.match(l.text, /^v6\.14\.0 shipped · staging \+2 \(nothing to ship\) · forge read \d\d:\d\d$/);
  assert.equal(l.open, false);
  assert.equal(l.tone, "green");
});

test("release pending: the release-worthy count, open while a row is pending", () => {
  const lane = { local: { latestTag: "v6.14.0" }, remote: { available: true }, compare: forge({ ahead: 5, release: 3 }), rows: [...green, { id: "x", state: "pending" }] };
  const l = shipLine(lane);
  assert.match(l.text, /release pending: 3 commits/);
  assert.ok(l.text.includes("1 pending") && l.open && l.tone === "yellow");
  assert.match(shipLine({ ...lane, compare: forge({ ahead: 40, release: 30, truncated: true }) }).text, /release pending: 30\+ commits/);
  assert.equal(shipLine({ ...lane, rows: [{ id: "tag-ci", state: "red" }] }).tone, "red");
});

test("local refs are labelled; an engine without compare never shows a bare count", () => {
  const local = shipLine({ local: { latestTag: "v1.0.0" }, remote: { available: false, reason: "gh-missing" }, compare: { source: "local", ahead: 2, behind: 0, release: 1 }, rows: green });
  assert.match(local.text, /release pending: 1 commit \(local refs, not fetched\)/);
  assert.match(local.text, /forge not read \(gh-missing\)/);
  const old = shipLine({ local: { latestTag: "v6.13.1", stagingAheadOfMain: 2, mainInStaging: true }, remote: { available: true }, rows: green });
  assert.match(old.text, /staging \+2 \(local count, may include merges; update the engine for the forge count\)/);
  assert.ok(!/release pending/.test(old.text));
});

test("staging sync and promote reads prefer the forge compare", () => {
  assert.equal(mainInStaging({ compare: forge({ behind: 1 }), local: { mainInStaging: true } }), false, "forge wins over local refs");
  assert.equal(mainInStaging({ compare: forge({ behind: 0 }), local: { mainInStaging: false } }), true);
  assert.equal(mainInStaging({ local: { mainInStaging: false } }), false, "older engine: the local flag");
  assert.equal(mainInStaging({}), null);
  assert.equal(stagingAhead({ compare: forge({ ahead: 4 }), local: { stagingAheadOfMain: 9 } }), 4);
  assert.equal(stagingAhead({ local: { stagingAheadOfMain: 9 } }), 9);
  assert.match(shipLine({ compare: forge({ behind: 2 }), rows: [] }).text, /main \+2 \(staging sync due\)/);
});
