// Markdown subset parser of the plan / HANDOFF preview and the run transcripts
// (src/markdown.ts). Pure: no DOM, so Node runs it with its types stripped (Node 22.18 or
// later; src/markdown.ts keeps to erasable syntax). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkKind, parseBlocks, parseInline, splitFrontmatter } from "../src/markdown.ts";

test("headings keep their level", () => {
  const b = parseBlocks("# One\n## Two ##\n###### Six\n####### seven is text");
  assert.deepEqual(b.slice(0, 3), [
    { t: "heading", level: 1, text: "One" },
    { t: "heading", level: 2, text: "Two" },
    { t: "heading", level: 6, text: "Six" },
  ]);
  assert.deepEqual(b[3], { t: "para", text: "####### seven is text" });
});

test("paragraphs join their lines; a blank line ends them", () => {
  assert.deepEqual(parseBlocks("a\nb\n\nc"), [
    { t: "para", text: "a b" },
    { t: "para", text: "c" },
  ]);
});

test("lists: bullets, numbers, nesting depth and continuation lines", () => {
  const b = parseBlocks("- one\n  more of one\n  - nested\n1. first\n2) second\n* star");
  assert.deepEqual(b, [
    {
      t: "list",
      items: [
        { depth: 0, ordered: false, text: "one more of one" },
        { depth: 1, ordered: false, text: "nested" },
        { depth: 0, ordered: true, text: "first" },
        { depth: 0, ordered: true, text: "second" },
        { depth: 0, ordered: false, text: "star" },
      ],
    },
  ]);
});

test("tables: header, alignment row, cells with code and escaped pipes", () => {
  const b = parseBlocks("| To-do | Status | Note |\n|:---|:---:|---:|\n| `a|b` | done | x \\| y |\n| t2 | open |");
  assert.deepEqual(b, [
    {
      t: "table",
      head: ["To-do", "Status", "Note"],
      align: ["left", "center", "right"],
      rows: [
        ["`a|b`", "done", "x | y"],
        ["t2", "open", ""],
      ],
    },
  ]);
});

test("a pipe line without an alignment row stays a paragraph", () => {
  assert.deepEqual(parseBlocks("| not | a table |"), [{ t: "para", text: "| not | a table |" }]);
});

test("fenced code keeps its text verbatim, unclosed fences run to the end", () => {
  assert.deepEqual(parseBlocks("```ts\nconst a = `<b>`;\n\n  x\n```\nafter"), [
    { t: "code", lang: "ts", text: "const a = `<b>`;\n\n  x" },
    { t: "para", text: "after" },
  ]);
  assert.deepEqual(parseBlocks("~~~\nopen"), [{ t: "code", lang: "", text: "open" }]);
});

test("quotes and rules", () => {
  assert.deepEqual(parseBlocks("> a\n> b\n\n---\n***"), [{ t: "quote", text: "a b" }, { t: "rule" }, { t: "rule" }]);
});

test("frontmatter splits off; its fence never becomes a rule", () => {
  const { front, body } = splitFrontmatter("---\nname: x\ntodos: []\n---\n# Title\n");
  assert.equal(front, "name: x\ntodos: []");
  assert.equal(body, "# Title\n");
  assert.deepEqual(splitFrontmatter("# no front\n---\n"), { front: null, body: "# no front\n---\n" });
  assert.deepEqual(splitFrontmatter("---\nunclosed"), { front: null, body: "---\nunclosed" });
});

test("inline: code, strong, links; the rest stays text", () => {
  assert.deepEqual(parseInline("a `b` **c** [d](e.md) f"), [
    { t: "text", text: "a " },
    { t: "code", text: "b" },
    { t: "text", text: " " },
    { t: "strong", text: "c" },
    { t: "text", text: " " },
    { t: "link", text: "d", href: "e.md" },
    { t: "text", text: " f" },
  ]);
});

test("hostile text stays text", () => {
  const html = "<script>alert(1)</script><img src=x onerror=alert(2)>";
  assert.deepEqual(parseInline(html), [{ t: "text", text: html }]);
  assert.deepEqual(parseBlocks(html), [{ t: "para", text: html }]);
  const [row] = parseBlocks(`| h |\n|---|\n| ${html} |`);
  assert.equal(row.rows[0][0], html);
});

test("link kinds: repo paths, web links; script and data URLs are refused", () => {
  assert.equal(linkKind(".cursor/plans/a.plan.md"), "repo");
  assert.equal(linkKind("../memory/decisions/x.md#point-3"), "repo");
  assert.equal(linkKind("https://github.com/agent-kit-startup/colony/pull/62"), "web");
  assert.equal(linkKind("javascript:alert(1)"), null);
  assert.equal(linkKind(" JavaScript:alert(1)"), null);
  assert.equal(linkKind("data:text/html,<b>x</b>"), null);
  assert.equal(linkKind("file:///etc/passwd"), null);
  assert.equal(linkKind("#anchor"), null);
});
