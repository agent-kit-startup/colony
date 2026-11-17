// The game data Colony gives the Oligarchy web page inside Colony (src/oligarchyfeed.ts, kit ADR
// 2026-11-17 points 2 and 6): kind and time per outcome, counts, the flow streak, nothing else;
// posted only to an exact allowed origin. Synthetic fixtures only. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GAME_DATA_MESSAGE,
  GAME_DATA_REQUEST,
  MAX_OUTCOMES,
  OLIGARCHY_ORIGINS,
  OUTCOME_KINDS,
  RESOURCES,
  count,
  emptyGameData,
  gameDataFromLedger,
  gameDataMessage,
  gameDataRequestHandler,
  isAllowedOrigin,
  isoTime,
  postGameData,
} from "../src/oligarchyfeed.ts";

const PROD = "https://oligarchy.missionkit.io";
const zeroKinds = { todo: 0, test: 0, ci: 0, releaseCut: 0, plan: 0, review: 0, releasePublished: 0 };
const zeroResources = { logic: 0, compute: 0, rare: 0 };
const EMPTY = { version: 1, outcomes: [], byKind: zeroKinds, byResource: zeroResources, flowStreak: 0 };

/** A ledger shaped like the kit's summarizeOutcomeLedger output (dashboard/lib/outcome-ledger.mjs). */
function kitLedger() {
  return {
    available: true,
    reason: null,
    version: 1,
    path: ".cursor/context/outcome-ledger.json",
    entries: 6,
    totals: { logic: 3, compute: 2, rare: 1 },
    byKind: { todo: 2, test: 1, ci: 1, releaseCut: 1, plan: 1, review: 0, releasePublished: 0 },
    recent: [
      { key: "todo:example-plan:t3", kind: "todo", resource: "logic", at: "2026-11-17T12:00:00.000Z", label: "example-plan t3" },
      { key: "ci:123", kind: "ci", resource: "compute", at: "2026-11-17T11:00:00Z", label: "ci" },
      { key: "release:v1.0.0", kind: "releaseCut", resource: "compute", at: "2026-11-16T10:00:00+03:00", label: "v1.0.0" },
      { key: "plan:example-plan", kind: "plan", resource: "rare", at: "2026-11-15", label: "example-plan" },
      { key: "test:abc1234", kind: "test", resource: "logic", at: null, label: "pnpm test" },
      { key: "todo:example-plan:t1", kind: "todo", resource: "logic", at: "2026-11-14T09:00:00Z", label: "example-plan t1" },
    ],
    flow: { plan: "example-plan.plan.md", streak: 2, lastClosedAt: "2026-11-17T12:00:00.000Z", brokenAt: null },
    tests: { configured: true, lastRun: { at: "2026-11-17T10:00:00Z", ok: true, head: "abc1234", commands: ["pnpm test"] } },
  };
}

test("a full kit ledger becomes kind and time per outcome, counts and the streak", () => {
  assert.deepEqual(gameDataFromLedger(kitLedger()), {
    version: 1,
    outcomes: [
      { kind: "todo", at: "2026-11-17T12:00:00.000Z" },
      { kind: "ci", at: "2026-11-17T11:00:00.000Z" },
      { kind: "releaseCut", at: "2026-11-16T07:00:00.000Z" },
      { kind: "plan", at: "2026-11-15T00:00:00.000Z" },
      { kind: "test", at: null },
      { kind: "todo", at: "2026-11-14T09:00:00.000Z" },
    ],
    byKind: { todo: 2, test: 1, ci: 1, releaseCut: 1, plan: 1, review: 0, releasePublished: 0 },
    byResource: { logic: 3, compute: 2, rare: 1 },
    flowStreak: 2,
  });
});

test("the constant lists match the kit's OUTCOME_KINDS and resources", () => {
  assert.deepEqual([...OUTCOME_KINDS], ["todo", "test", "ci", "releaseCut", "plan", "review", "releasePublished"]);
  assert.deepEqual([...RESOURCES], ["logic", "compute", "rare"]);
  assert.deepEqual([...OLIGARCHY_ORIGINS], [PROD], "production only; staging waits for the Settings switch");
});

test("a partial ledger fills what it has and zeroes the rest", () => {
  assert.deepEqual(gameDataFromLedger({ byKind: { ci: 4 }, recent: [{ kind: "ci", at: "2026-11-01T00:00:00Z" }] }), {
    ...EMPTY,
    outcomes: [{ kind: "ci", at: "2026-11-01T00:00:00.000Z" }],
    byKind: { ...zeroKinds, ci: 4 },
  });
  assert.deepEqual(gameDataFromLedger({ totals: { rare: 1 }, flow: null }), { ...EMPTY, byResource: { ...zeroResources, rare: 1 } });
});

test("no ledger, an empty one or available:false gives the well-formed empty shape", () => {
  for (const input of [null, undefined, {}, [], "ledger", 42, true]) assert.deepEqual(gameDataFromLedger(input), EMPTY, JSON.stringify(input));
  assert.deepEqual(gameDataFromLedger({ ...kitLedger(), available: false, reason: "unreadable" }), EMPTY);
  assert.deepEqual(gameDataFromLedger({ available: true, entries: 0, totals: zeroResources, byKind: zeroKinds, recent: [], flow: null }), EMPTY);
  assert.deepEqual(emptyGameData(), EMPTY);
  const a = emptyGameData();
  a.byKind.todo = 9;
  a.outcomes.push({ kind: "todo", at: null });
  assert.deepEqual(emptyGameData(), EMPTY, "a fresh object per call");
});

test("nothing from the ledger but kind, time, counts and streak reaches the output", () => {
  const SECRET = "ghp_FAKEsecretTOKEN0123456789";
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const ledger = {
    available: true,
    reason: SECRET,
    version: 1,
    path: `/home/someone/${SECRET}/.cursor/context/outcome-ledger.json`,
    repo: "someone/private-repo",
    entries: 3,
    totals: { logic: 2, compute: 1, rare: 0, [SECRET]: 7, secret: SECRET },
    byKind: { todo: 1, test: 1, ci: 1, [SECRET]: 5, label: SECRET, review: SECRET },
    recent: [
      { key: `ci:${SHA}:987654321`, kind: "ci", resource: "compute", at: "2026-11-17T10:00:00Z", label: `deploy ${SECRET}`, sha: SHA, runId: 987654321, tag: "v9.9.9" },
      { key: `todo:${SECRET}`, kind: "todo", resource: "logic", at: `2026-11-17T10:00:00Z ${SECRET}`, label: SECRET },
      { key: "x", kind: SECRET, at: "2026-11-17T09:00:00Z" },
      { key: "y", kind: "test", at: SECRET, extra: { nested: SECRET } },
    ],
    flow: { plan: `${SECRET}.plan.md`, streak: 3, lastClosedAt: "2026-11-17T10:00:00Z", brokenAt: "2026-11-16T10:00:00Z", note: SECRET },
    tests: { configured: true, lastRun: { at: "2026-11-17T10:00:00Z", ok: true, head: SHA, commands: [`curl -H 'Authorization: ${SECRET}'`] } },
  };
  const out = gameDataFromLedger(ledger);
  assert.deepEqual(out, {
    version: 1,
    outcomes: [
      { kind: "ci", at: "2026-11-17T10:00:00.000Z" },
      { kind: "todo", at: null },
      { kind: "test", at: null },
    ],
    byKind: { todo: 1, test: 1, ci: 1, releaseCut: 0, plan: 0, review: 0, releasePublished: 0 },
    byResource: { logic: 2, compute: 1, rare: 0 },
    flowStreak: 3,
  });
  const json = JSON.stringify(gameDataMessage(ledger));
  for (const leak of [SECRET, SHA, "987654321", "v9.9.9", "private-repo", "outcome-ledger.json", "plan.md", "deploy", "Authorization", "abc1234", "lastClosedAt", "brokenAt", "label", "key", "path", "tests"]) {
    assert.ok(!json.includes(leak), `leaked ${leak}`);
  }
  ledger.recent[0].kind = "plan";
  ledger.byKind.todo = 99;
  assert.equal(out.outcomes[0].kind, "ci", "the output shares nothing with the input");
  assert.equal(out.byKind.todo, 1);
});

test("unknown kinds, inherited names and non-object rows are dropped", () => {
  const recent = [
    { kind: "constructor", at: null },
    { kind: "__proto__", at: null },
    { kind: "toString", at: null },
    { kind: "hasOwnProperty", at: null },
    { kind: "TODO", at: null },
    { kind: "quest", at: null },
    { kind: ["todo"], at: null },
    null,
    "todo",
    ["todo"],
    { at: "2026-11-17T00:00:00Z" },
    { kind: "review", at: "2026-11-17T00:00:00Z" },
  ];
  assert.deepEqual(gameDataFromLedger({ recent }).outcomes, [{ kind: "review", at: "2026-11-17T00:00:00.000Z" }]);
  const inherited = JSON.parse('{"byKind": {"__proto__": {"todo": 5}}, "totals": {"__proto__": {"logic": 5}}, "flow": {"__proto__": {"streak": 5}}}');
  assert.deepEqual(gameDataFromLedger(inherited), EMPTY, "counts are own properties only");
  assert.deepEqual(gameDataFromLedger({ recent: "todo" }), EMPTY);
});

test("counts are non-negative integers; garbage counts are zero", () => {
  assert.equal(count(3), 3);
  assert.equal(count(3.9), 3);
  assert.equal(count(0), 0);
  for (const v of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "5", "", null, undefined, {}, [5], true, 5n]) {
    assert.equal(count(v), 0, String(v));
  }
  assert.equal(count(1e300), Number.MAX_SAFE_INTEGER);
  const out = gameDataFromLedger({ byKind: { todo: -3, ci: "7", plan: 2.5 }, totals: { logic: Number.NaN, rare: 4 }, flow: { streak: -1 } });
  assert.deepEqual(out.byKind, { ...zeroKinds, plan: 2 });
  assert.deepEqual(out.byResource, { ...zeroResources, rare: 4 });
  assert.equal(out.flowStreak, 0);
  assert.equal(gameDataFromLedger({ flow: { streak: "3" } }).flowStreak, 0);
});

test("a time crosses only as a valid ISO date or zoned date-time, re-emitted in UTC", () => {
  assert.equal(isoTime("2026-11-17T10:00:00Z"), "2026-11-17T10:00:00.000Z");
  assert.equal(isoTime("2026-11-17T10:00Z"), "2026-11-17T10:00:00.000Z");
  assert.equal(isoTime("2026-11-17T10:00:00.123Z"), "2026-11-17T10:00:00.123Z");
  assert.equal(isoTime("2026-11-17T10:00:00-03:00"), "2026-11-17T13:00:00.000Z");
  assert.equal(isoTime("2026-11-17T10:00:00+0300"), "2026-11-17T07:00:00.000Z");
  assert.equal(isoTime("2026-11-17 10:00:00Z"), "2026-11-17T10:00:00.000Z");
  assert.equal(isoTime("2026-11-17"), "2026-11-17T00:00:00.000Z");
  assert.equal(isoTime("  2026-11-17T10:00:00Z\n"), "2026-11-17T10:00:00.000Z", "trimmed like the kit's isoOrNull");
  for (const v of [
    "2026-11-17T10:00:00", // no zone: local time, machine-dependent
    "2026-02-30",
    "2026-13-01T00:00:00Z",
    "2026-11-17T24:00:00Z",
    "2026-11-17T10:60:00Z",
    "17/11/2026",
    "Tue, 17 Nov 2026 10:00:00 GMT",
    "1 2026",
    "2026-11-17T10:00:00Z; rm -rf /",
    "",
    null,
    1794909600000,
    {},
  ]) {
    assert.equal(isoTime(v), null, JSON.stringify(v));
  }
});

test("at most MAX_OUTCOMES outcomes are copied, newest first as the kit orders them", () => {
  const recent = Array.from({ length: 50 }, (_, i) => ({ kind: "ci", at: new Date(Date.UTC(2026, 10, 17) - i * 60_000).toISOString() }));
  const out = gameDataFromLedger({ recent });
  assert.equal(MAX_OUTCOMES, 20);
  assert.equal(out.outcomes.length, MAX_OUTCOMES);
  assert.deepEqual(out.outcomes[0], { kind: "ci", at: "2026-11-17T00:00:00.000Z" });
});

test("the origin allowlist is exact string equality", () => {
  assert.equal(isAllowedOrigin(PROD), true);
  for (const o of [
    "*",
    "/",
    "",
    "null",
    `${PROD}/`,
    `${PROD}:443`,
    "http://oligarchy.missionkit.io",
    "https://OLIGARCHY.missionkit.io",
    "https://oligarchy.missionkit.io.evil.com",
    "https://evil-oligarchy.missionkit.io",
    "https://oligarchy.missionkit.io@evil.com",
    "https://evil.com/https://oligarchy.missionkit.io",
    "https://oligarchy-staging.missionkit.io",
    "https://missionkit.io",
    ` ${PROD}`,
    null,
    undefined,
    [PROD],
  ]) {
    assert.equal(isAllowedOrigin(o), false, JSON.stringify(o));
  }
  const staging = "https://oligarchy-staging.missionkit.io";
  assert.equal(isAllowedOrigin(staging, [...OLIGARCHY_ORIGINS, staging]), true, "a caller-built list adds staging");
});

function fakeWindow() {
  const sent = [];
  return { sent, postMessage(message, targetOrigin) { sent.push({ message, targetOrigin }); } };
}

test("posting addresses the exact origin and refuses '*' and every other origin", () => {
  const w = fakeWindow();
  assert.equal(postGameData(w, PROD, kitLedger()), true);
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].targetOrigin, PROD);
  assert.deepEqual(w.sent[0].message, { type: GAME_DATA_MESSAGE, version: 1, data: gameDataFromLedger(kitLedger()) });
  for (const o of ["*", "/", "https://oligarchy.missionkit.io.evil.com", "https://oligarchy-staging.missionkit.io", ""]) {
    assert.equal(postGameData(w, o, kitLedger()), false, o);
  }
  for (const o of ["*", "/"]) {
    assert.equal(isAllowedOrigin(o, [PROD, o]), false, `${o} in a caller's list`);
    assert.equal(postGameData(w, o, kitLedger(), [PROD, o]), false, `${o} in a caller's list`);
    const handle = gameDataRequestHandler(() => w, o, () => kitLedger(), [PROD, o]);
    assert.equal(handle({ origin: o, source: w, data: { type: GAME_DATA_REQUEST } }), false);
  }
  assert.equal(postGameData(null, PROD, kitLedger()), false);
  assert.equal(postGameData(undefined, PROD, kitLedger()), false);
  assert.equal(w.sent.length, 1, "nothing else was posted");
  assert.ok(!JSON.stringify(w.sent).includes("example-plan"), "the raw ledger is never posted");
});

test("the page's request is answered only from the expected window and origin, and only for its type", () => {
  const frame = fakeWindow();
  const other = fakeWindow();
  let reads = 0;
  const handle = gameDataRequestHandler(() => frame, PROD, () => { reads += 1; return kitLedger(); });
  const ok = { origin: PROD, source: frame, data: { type: GAME_DATA_REQUEST } };
  for (const ev of [
    { ...ok, source: other },
    { ...ok, source: null },
    { ...ok, origin: "https://oligarchy.missionkit.io.evil.com" },
    { ...ok, origin: "null" },
    { ...ok, data: { type: GAME_DATA_MESSAGE } },
    { ...ok, data: { type: "oligarchy:run", command: "rm -rf /" } },
    { ...ok, data: GAME_DATA_REQUEST },
    { ...ok, data: null },
    { ...ok, data: [GAME_DATA_REQUEST] },
    { ...ok, data: Object.create({ type: GAME_DATA_REQUEST }) },
  ]) {
    assert.equal(handle(ev), false, JSON.stringify({ origin: ev.origin, data: ev.data }));
  }
  assert.equal(reads, 0, "the ledger is not read for refused messages");
  assert.equal(frame.sent.length + other.sent.length, 0);
  assert.equal(handle({ ...ok, data: { type: GAME_DATA_REQUEST, path: "/etc/passwd", origin: "*" } }), true, "extra fields are ignored, not read");
  assert.equal(frame.sent.length, 1);
  assert.equal(frame.sent[0].targetOrigin, PROD);
  assert.equal(frame.sent[0].message.type, GAME_DATA_MESSAGE);
  assert.equal(other.sent.length, 0);
});

test("a handler set up for a disallowed origin or without a frame never answers", () => {
  const frame = fakeWindow();
  const req = { type: GAME_DATA_REQUEST };
  const star = gameDataRequestHandler(() => frame, "*", () => kitLedger());
  assert.equal(star({ origin: "*", source: frame, data: req }), false);
  const evil = "https://oligarchy.missionkit.io.evil.com";
  const suffix = gameDataRequestHandler(() => frame, evil, () => kitLedger());
  assert.equal(suffix({ origin: evil, source: frame, data: req }), false);
  const gone = gameDataRequestHandler(() => null, PROD, () => kitLedger());
  assert.equal(gone({ origin: PROD, source: null, data: req }), false);
  assert.equal(frame.sent.length, 0);
});
