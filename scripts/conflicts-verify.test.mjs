// The conflict window's verify box (git-cicd ADR amend 2026-11-19, plan
// colony-conflicts-and-smoke-residuals c0): verification runs the repository's commands on the
// agent's text before anyone reviewed it, as the operator, so the box starts unticked, says so
// in one line, and the host always names the choice to the kit. Source-level: no DOM.
// Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the verify box starts unticked and has a one-line warning", () => {
  const src = read("src/conflicts.ts");
  const box = src.match(/private verify = h\("input", (\{[^}]*\})\);/);
  assert.ok(box, "the verify checkbox is found");
  assert.ok(!/checked/.test(box[1]), `the checkbox has no checked attribute: ${box[1]}`);
  const note = src.match(/export const VERIFY_NOTE = "([^"]+)";/);
  assert.ok(note, "VERIFY_NOTE is a static string");
  assert.ok(!note[1].includes("\n") && note[1].length <= 160, "one line");
  for (const word of ["test commands", "agent's text", "unsandboxed", "as you"]) assert.ok(note[1].includes(word), `the note says "${word}"`);
  assert.match(src, /h\("div", \{ class: "hint small cf-verify-note" \}, VERIFY_NOTE\)/, "the note renders under the header row, as text");
  assert.match(src, /api\.conflictsPropose\(path, this\.backend\.value, this\.verify\.checked\)/, "the box's state goes to the host as is");
});

test("the host names verification both ways, whatever the kit's default", () => {
  const rs = read("src-tauri/src/conflicts.rs");
  assert.match(rs, /let flag = if verify \{ "--verify" \} else \{ "--no-verify" \};/);
  assert.match(rs, /let args = propose_args\(&path, backend\.as_deref\(\), verify\)\?;/, "conflicts_propose builds its argv through propose_args");
});
