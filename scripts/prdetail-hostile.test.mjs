// Hostile forge text through the PR detail tab (src/prdetail.ts) and the document preview
// (src/docpreview.ts): kit plan colony-conflicts-and-smoke-residuals c4, forge-ux review
// finding F3. The views are built on the small DOM of ./test-dom.mjs, which records every
// markup or URL sink (innerHTML, outerHTML, insertAdjacentHTML, srcdoc, href / src / on*)
// instead of parsing it, so "no live sink" is checked on what the code writes, not on a
// grep. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { elements, liveSinks, setInvoke, sinks } from "./test-dom.mjs";

const { PrDetailView } = await import("../src/prdetail.ts");
const { renderDoc } = await import("../src/docpreview.ts");

const HOSTILE = [
  "# Release <script>alert(1)</script>",
  "",
  "[js](javascript:alert(document.cookie)) [data](data:text/html,<script>alert(1)</script>) [file](file:///etc/passwd) [vb](vbscript:msgbox(1)) [rel](../../etc/passwd) [ok](https://example.com/pr)",
  "",
  '<img src=x onerror=alert(1)> <iframe srcdoc="<script>alert(1)</script>"></iframe> <a href="javascript:alert(1)">raw</a> <style>*{display:none}</style>',
  "",
  "![pic](javascript:alert(1)) ![pic2](https://example.com/x.png)",
  "",
  "**bold [j](javascript:alert(2))** `<b>code</b>`",
  "",
  "| a | b |",
  "|---|---|",
  "| <b>x</b> | [j](javascript:alert(3)) |",
  "",
  "- [item](data:text/html;base64,PHNjcmlwdD4=)",
  "",
  "```html",
  "<script>alert(1)</script>",
  "```",
].join("\n");

const FORBIDDEN_TAGS = new Set(["SCRIPT", "IFRAME", "IMG", "OBJECT", "EMBED", "STYLE", "LINK", "META", "FORM", "BASE"]);

function pr(body, extra = {}) {
  return {
    number: 42,
    title: "<img src=x onerror=alert(1)> release",
    state: "OPEN",
    headRefName: "feat/x",
    baseRefName: "staging",
    headRefOid: "0123456789abcdef0123456789abcdef01234567",
    isCrossRepository: false,
    author: { login: "<b>mallory</b>", is_bot: false },
    labels: [{ name: "<script>label</script>" }],
    body,
    url: "javascript:alert(1)",
    createdAt: "2026-11-01T00:00:00Z",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [],
    ...extra,
  };
}

async function renderPr(data) {
  setInvoke(async (cmd, args) => {
    if (cmd === "forge_pr_detail") return { ...data, number: args.number };
    if (cmd === "forge_pr_diff") return "";
    return null;
  });
  const links = [];
  const view = new PrDetailView(42, {
    status() {},
    onLink: (href, kind) => links.push([href, kind]),
    onResolve() {},
    onCard() {},
    attachBox() {},
    detachBox() {},
    setLabel() {},
  });
  await view.reload();
  return { view, links };
}

/** The checks every rendering of untrusted text must pass. */
function assertInert(root, what) {
  assert.deepEqual(liveSinks(), [], `${what}: no markup or URL sink was written (the static icons aside)`);
  for (const el of elements(root)) {
    assert.ok(!FORBIDDEN_TAGS.has(el.tagName), `${what}: no <${el.tagName.toLowerCase()}> element`);
    for (const name of Object.keys(el.attributes)) {
      assert.ok(!name.startsWith("on") && !["href", "src", "srcdoc", "action", "formaction", "style"].includes(name), `${what}: no ${name} attribute on <${el.tagName.toLowerCase()}>`);
    }
  }
}

test("a hostile PR body, title, author and label render as text with no live sink", async () => {
  sinks.length = 0;
  const { view, links } = await renderPr(pr(HOSTILE));
  assertInert(view.el, "PR detail");
  const text = view.el.textContent;
  for (const raw of ["<img src=x onerror=alert(1)>", "<script>alert(1)</script>", "<b>mallory</b>", "<script>label</script>", "<b>code</b>"]) {
    assert.ok(text.includes(raw), `the markup-looking text stays text: ${raw}`);
  }
  assert.ok(!elements(view.el).some((el) => el.dataset.act === "web"), "a non-https PR url gets no Open on the forge button");
  // Only http(s) and repository paths become links (no href: Colony's handler opens them, a
  // path through the workspace jail); every other scheme is plain text with no handler.
  const live = elements(view.el).filter((el) => el.className.split(" ").includes("md-link"));
  assert.deepEqual(live.map((el) => el.attributes.title.split("\n")[0]), ["../../etc/passwd", "https://example.com/pr", "https://example.com/x.png"]);
  for (const el of live) el.click();
  assert.deepEqual(links, [["../../etc/passwd", "repo"], ["https://example.com/pr", "web"], ["https://example.com/x.png", "web"]]);
  const inert = elements(view.el).filter((el) => el.className.split(" ").includes("md-link-text"));
  assert.ok(inert.length >= 7, `the other links are md-link-text spans (${inert.length})`);
  assert.ok(inert.every((el) => /^(javascript|data|file|vbscript):/.test(el.attributes.title)), "each inert one is a refused scheme");
  for (const el of inert) {
    assert.equal(el.tagName, "SPAN");
    assert.deepEqual(Object.keys(el.listeners), [], `no handler on ${el.attributes.title}`);
  }
});

test("a very long PR body is cut at 40 000 characters and renders quickly", async () => {
  sinks.length = 0;
  const body = `${"a ".repeat(19_990)}INSIDE ${"z".repeat(30_000)} OUTSIDE [x](javascript:alert(1))`;
  const t0 = Date.now();
  const { view } = await renderPr(pr(body));
  assert.ok(Date.now() - t0 < 5000, "renders in under 5 s");
  assertInert(view.el, "long PR body");
  const text = view.el.textContent;
  assert.ok(text.includes("INSIDE") && !text.includes("OUTSIDE"), "the body is cut at MAX_BODY");
  const bodyText = elements(view.el).find((el) => el.tagName === "ARTICLE")?.textContent ?? "";
  assert.ok(bodyText.length <= 40_000, `the rendered body holds at most 40 000 characters (${bodyText.length})`);
});

test("the plan preview renders hostile Markdown, frontmatter and to-dos as text", () => {
  sinks.length = 0;
  const doc = `---\nname: "<script>x</script>"\noverview: "[a](javascript:1)"\n---\n${HOSTILE}`;
  const links = [];
  const out = renderDoc(doc, [{ id: "<b>t1</b>", content: "[go](javascript:alert(1)) <img src=x onerror=1>", status: "pending\" onmouseover=\"x" }], (href, kind) => links.push([href, kind]));
  assertInert(out, "document preview");
  assert.ok(out.textContent.includes('name: "<script>x</script>"'), "the frontmatter stays raw text");
  assert.ok(out.textContent.includes("<img src=x onerror=1>"));
  for (const el of elements(out)) for (const c of el.className.split(" ")) assert.match(c, /^[a-z0-9_-]*$/, `class names are sanitised: ${el.className}`);
  for (const el of elements(out).filter((e) => e.className.split(" ").includes("md-link"))) el.click();
  assert.ok(links.every(([href, kind]) => kind === "web" ? href.startsWith("https://") : !/^[a-z]+:/i.test(href)), JSON.stringify(links));
});

test("the harness sees a sink when one is written (the checks above can fail)", () => {
  sinks.length = 0;
  const el = document.createElement("div");
  el.innerHTML = "<img src=x onerror=alert(1)>";
  const a = document.createElement("a");
  a.href = "javascript:alert(1)";
  a.setAttribute("onclick", "alert(1)");
  assert.deepEqual(sinks.map((s) => s.sink), ["innerHTML", "href", "attr:onclick"]);
  sinks.length = 0;
});
