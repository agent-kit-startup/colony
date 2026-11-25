// Back-forward history of the main pane (src/nav-history.ts). Node strips the types
// (Node 22.18 or later; src/nav-history.ts keeps to erasable syntax for that).
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { NavHistory } from "../src/nav-history.ts";

const open = (...ids) => (id) => ids.includes(id);
const all = () => true;

test("back and forward walk the views the user opened", () => {
  const h = new NavHistory();
  h.visit("mission");
  h.visit("inbox");
  h.visit("git");
  assert.equal(h.back(all), "inbox");
  assert.equal(h.back(all), "mission");
  assert.equal(h.back(all), null);
  assert.equal(h.forward(all), "inbox");
  assert.equal(h.forward(all), "git");
  assert.equal(h.forward(all), null);
});

test("a new visit after going back drops the forward entries", () => {
  const h = new NavHistory();
  for (const id of ["mission", "inbox", "git"]) h.visit(id);
  h.back(all);
  h.visit("review");
  assert.equal(h.canForward(all), false);
  assert.equal(h.back(all), "inbox");
});

test("visiting the current entry again records nothing", () => {
  const h = new NavHistory();
  h.visit("mission");
  h.visit("mission");
  assert.equal(h.canBack(all), false);
});

test("back skips entries whose tab is closed", () => {
  const h = new NavHistory();
  for (const id of ["mission", "/r/a.ts", "inbox"]) h.visit(id);
  assert.equal(h.back(open("mission", "inbox")), "mission");
});

test("canBack and canForward ignore closed tabs", () => {
  const h = new NavHistory();
  h.visit("/r/a.ts");
  h.visit("mission");
  assert.equal(h.canBack(open("mission")), false);
  assert.equal(h.canBack(all), true);
  assert.equal(h.canForward(all), false);
});

test("forget removes a closed tab and keeps the position on the same entry", () => {
  const h = new NavHistory();
  for (const id of ["mission", "/r/a.ts", "inbox", "/r/a.ts", "git"]) h.visit(id);
  h.back(all); // on the second /r/a.ts
  h.back(all); // on inbox
  h.forget("/r/a.ts");
  assert.equal(h.current(), "inbox");
  assert.equal(h.back(all), "mission");
  assert.equal(h.forward(all), "inbox");
  assert.equal(h.forward(all), "git");
});

test("forget merges the neighbours it leaves side by side", () => {
  const h = new NavHistory();
  for (const id of ["mission", "/r/a.ts", "mission", "inbox"]) h.visit(id);
  h.forget("/r/a.ts");
  assert.equal(h.back(all), "mission");
  assert.equal(h.back(all), null);
});

test("forgetting the current entry moves to the most recent entry before it", () => {
  const h = new NavHistory();
  for (const id of ["mission", "inbox", "/r/a.ts"]) h.visit(id);
  h.forget("/r/a.ts");
  assert.equal(h.current(), "inbox");
  assert.equal(h.back(all), "mission");
});

test("forgetting the first entry while on it moves to the next one", () => {
  const h = new NavHistory();
  for (const id of ["/r/a.ts", "mission"]) h.visit(id);
  h.back(all);
  h.forget("/r/a.ts");
  assert.equal(h.current(), "mission");
  assert.equal(h.canBack(all), false);
});

test("the history keeps the last entries only", () => {
  const h = new NavHistory(3);
  for (const id of ["a", "b", "c", "d"]) h.visit(id);
  assert.equal(h.back(all), "c");
  assert.equal(h.back(all), "b");
  assert.equal(h.back(all), null);
});

test("reset starts an empty history", () => {
  const h = new NavHistory();
  for (const id of ["mission", "inbox"]) h.visit(id);
  h.reset();
  assert.equal(h.current(), null);
  assert.equal(h.canBack(all), false);
  h.visit("mission");
  assert.equal(h.canBack(all), false);
});

// The tab strip holds documents only (kit ADR 2026-10-24 amend 2026-11-11, point 3): no view
// switch is drawn in it, and a rail group with several views switches inside its view.
test("the tab strip draws no view switch; Ship and Workspace switch inside their views", async () => {
  const fs = await import("node:fs/promises");
  const read = (p) => fs.readFile(new URL(`../${p}`, import.meta.url), "utf8");
  const main = await read("src/main.ts");
  const from = main.indexOf("function renderTabs()");
  const renderTabs = main.slice(from, main.indexOf("\nfunction showTab(", from));
  assert.ok(from > 0 && renderTabs.length > 200, "renderTabs found");
  assert.ok(!/RAIL|tablist|view-switch|showTab\("(git|cicd)"\)/.test(renderTabs), "renderTabs reads no rail group and draws no switch");
  assert.match(renderTabs, /rest\.replaceChildren\(\.\.\.\(docs\.length \? \[h\("span", \{ class: "tab-sep" \}\)\] : \[\]\), docBar\)/, "the strip is the separator and the document tabs");
  // Ship's two views are the members of its rail item, each wrapped with the inner switch.
  const views = /id: "ship",[^\n]*views: \[([^\]]*)\]/.exec(main)?.[1].replace(/["\s]/g, "");
  assert.equal(views, "git,cicd");
  const shipViews = main.slice(main.indexOf("const SHIP_VIEWS"), main.indexOf("];", main.indexOf("const SHIP_VIEWS")));
  assert.deepEqual([...shipViews.matchAll(/id: "([a-z]+)"/g)].map((m) => m[1]), ["git", "cicd"]);
  assert.match(main, /groupSection\("Ship", SHIP_VIEWS, info\.id, body/);
  assert.ok(!/\binner\??: /.test(main.slice(main.indexOf("interface RailItem"), main.indexOf("const CTRL_DIGITS"))), "no group is special-cased as inner");
  // The switch marks its current member with the 1px border colour only.
  const css = await read("src/styles.css");
  assert.ok(!css.includes("view-switch"), "the strip switch styles are gone");
  const active = css.split("\n").filter((l) => l.startsWith(".ws-nav-btn.active"));
  assert.equal(active.length, 1);
  assert.ok(/border-color/.test(active[0]) && !/background|border-left|inset|box-shadow/.test(active[0]), active[0]);
});
