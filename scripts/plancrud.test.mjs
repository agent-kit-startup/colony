// The plan CRUD dropdown's actions (src/plancrud.ts): which kit command each plan row offers
// (ADR 2026-10-24 amend 2026-10-26, Ask colony-plan-crud-delete = Edit, Archive, Cancel,
// Delete). Pure: Node runs it with its types stripped. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { planActions } from "../src/plancrud.ts";

const ids = (xs) => xs.map((x) => x.id);

test("the active plan offers Edit only, whatever its lifecycle", () => {
  for (const lc of ["executing", "incomplete", "awaiting_user", "backlog", "parked", "completed"]) {
    assert.deepEqual(ids(planActions("a.plan.md", lc, true)), ["edit"], lc);
  }
});

test("backlog rows: Edit, Cancel, Delete", () => {
  assert.deepEqual(ids(planActions("b.plan.md", "backlog", false)), ["edit", "cancel", "delete"]);
});

test("parked rows: Edit, Archive", () => {
  assert.deepEqual(ids(planActions("p.plan.md", "parked", false)), ["edit", "archive"]);
});

test("other rows: Edit only", () => {
  for (const lc of ["incomplete", "completed", "executing", "unknown"]) assert.deepEqual(ids(planActions("x.plan.md", lc, false)), ["edit"], lc);
});

test("each action is one allowlisted command with the plan file", () => {
  const all = [...planActions("b.plan.md", "backlog", false), ...planActions("p.plan.md", "parked", false)];
  const prompts = Object.fromEntries(all.map((a) => [a.id, a.prompt]));
  assert.deepEqual(prompts, { edit: "/backlog-edit p.plan.md", cancel: "/backlog-cancel b.plan.md", delete: "/backlog-delete b.plan.md", archive: "/archive-plan p.plan.md" });
  for (const a of all) {
    assert.match(a.prompt, /^\/(backlog-edit|backlog-cancel|backlog-delete|archive-plan) [A-Za-z0-9._:/-]{1,240}$/);
    assert.ok(a.why.length > 20 && a.title.length > 10, a.id);
  }
});

test("a file name that is not one plain token gets no action", () => {
  for (const bad of ["", "a b.plan.md", "../x.plan.md", "-x.plan.md", "x;rm.plan.md"]) assert.deepEqual(planActions(bad, "backlog", false), [], bad);
});
