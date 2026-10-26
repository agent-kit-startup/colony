// The plan CRUD dropdown's actions (src/plancrud.ts): which kit command each plan row offers
// (ADR 2026-10-24 amend 2026-10-26, Ask colony-plan-crud-delete = Edit, Archive, Cancel,
// Delete). Pure: Node runs it with its types stripped. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { planActions } from "../src/plancrud.ts";

const ids = (xs) => xs.map((x) => x.id);

const none = { parked: false, backlog: false };
const parked = { parked: true, backlog: false };
const backlog = { parked: false, backlog: true };

test("the active plan offers Edit only, whatever list names it", () => {
  for (const l of [none, parked, backlog]) assert.deepEqual(ids(planActions("a.plan.md", l, true)), ["edit"], JSON.stringify(l));
});

test("a plan on the Backlog: Edit, Cancel, Delete (also once all its to-dos are done)", () => {
  assert.deepEqual(ids(planActions("b.plan.md", backlog, false)), ["edit", "cancel", "delete"]);
});

test("a parked plan: Edit, Archive (also once all its to-dos are done)", () => {
  assert.deepEqual(ids(planActions("p.plan.md", parked, false)), ["edit", "archive"]);
});

test("a plan on no list: Edit only", () => {
  assert.deepEqual(ids(planActions("x.plan.md", none, false)), ["edit"]);
});

test("each action is one allowlisted command with the plan file", () => {
  const all = [...planActions("b.plan.md", backlog, false), ...planActions("p.plan.md", parked, false)];
  const prompts = Object.fromEntries(all.map((a) => [a.id, a.prompt]));
  assert.deepEqual(prompts, { edit: "/backlog-edit p.plan.md", cancel: "/backlog-cancel b.plan.md", delete: "/backlog-delete b.plan.md", archive: "/archive-plan p.plan.md" });
  for (const a of all) {
    assert.match(a.prompt, /^\/(backlog-edit|backlog-cancel|backlog-delete|archive-plan) [A-Za-z0-9._:/-]{1,240}$/);
    assert.ok(a.why.length > 20 && a.title.length > 10, a.id);
  }
});

test("a file name that is not one plain token gets no action", () => {
  for (const bad of ["", "a b.plan.md", "../x.plan.md", "-x.plan.md", "x;rm.plan.md"]) assert.deepEqual(planActions(bad, backlog, false), [], bad);
});
