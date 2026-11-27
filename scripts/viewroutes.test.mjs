// Old view ids route to their new places (src/viewroutes.ts; kit ADR 2026-10-24 amend
// 2026-11-19): Health folded into Activity and left Workspace, which opens on Overview.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { routeView, VIEW_ROUTES } from "../src/viewroutes.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8");

test("view:health opens Activity at its health part", () => {
  assert.deepEqual(routeView("health"), { view: "activity", part: "health" });
});

test("a view that still exists routes to itself", () => {
  for (const id of ["activity", "chats", "agents", "decisions", "overview", "plans", "memory"]) assert.deepEqual(routeView(id), { view: id });
});

test("no route names a Workspace section or a rail view as its old id", () => {
  const main = read("src/main.ts");
  const sections = /const WORKSPACE_SECTIONS = \[([^\]]*)\]/.exec(main)[1].replace(/["\s]/g, "").split(",");
  const rail = main.slice(main.indexOf("const RAIL: RailItem[] = ["), main.indexOf("\n];", main.indexOf("const RAIL: RailItem[] = [")));
  const railIds = [...rail.matchAll(/\{ id: "([^"]+)"/g)].map((m) => m[1]);
  for (const [old, r] of Object.entries(VIEW_ROUTES)) {
    assert.ok(!sections.includes(old) && !railIds.includes(old), `${old} is still a view of its own`);
    assert.ok(railIds.includes(r.view) || sections.includes(r.view), `${old} routes to ${r.view}, which is no view`);
  }
});

test("Workspace holds the static sections and opens on Overview; Agents stays a section", () => {
  const main = read("src/main.ts");
  const sections = /const WORKSPACE_SECTIONS = \[([^\]]*)\]/.exec(main)[1].replace(/["\s]/g, "").split(",");
  assert.deepEqual(sections, ["overview", "decisions", "agents", "skills", "rules", "commands"]);
  assert.match(main, /\{ id: "workspace", [^\n]*home: "overview", bottom: true \}/);
  assert.ok(!read("src/workspace.ts").includes("health: {"), "Workspace has no Health section");
  assert.ok(!read("src/kitviews.ts").includes("class HealthView"), "no Workspace Health view");
});

test("Activity carries the full health checks; Chats lists the live runs beside the saved chats", () => {
  const cockpit = read("src/cockpit.ts");
  const activity = cockpit.slice(cockpit.indexOf("export class ActivityView"), cockpit.indexOf("// ---- Plans"));
  assert.match(activity, /c\.dataset\.part = "health"/);
  assert.match(activity, /`\$\{checks\.length - failing\} of \$\{checks\.length\} pass`/);
  const chats = cockpit.slice(cockpit.indexOf("export class ChatsView"), cockpit.indexOf("// ---- Activity"));
  assert.match(chats, /launches\.on\(\(\) => this\.invalidate\(\)\)/);
  assert.match(chats, /l\.state !== "ended" && l\.root === root/);
  assert.match(chats, /launchRow\(l, undefined, this\.host\)/);
});
