// Which addresses Colony hands to the system browser (src/weblink.ts): http and https with a
// host, nothing else. The opener plugin's capability scope refuses the rest again
// (src-tauri/capabilities/default.json, cargo test opener_scope_http_https_only). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { editorLink, termLinkClick, webUrl } from "../src/weblink.ts";

test("http and https addresses open, normalised", () => {
  assert.equal(webUrl("https://github.com/agent-kit-startup/colony/pull/62"), "https://github.com/agent-kit-startup/colony/pull/62");
  assert.equal(webUrl("http://localhost:5173/x?y=1#z"), "http://localhost:5173/x?y=1#z");
  assert.equal(webUrl("  https://example.com  "), "https://example.com/", "trimmed, with the root path");
  assert.equal(webUrl("HTTPS://Example.COM/A"), "https://example.com/A", "the scheme and host lower-cased (the scope globs are case-sensitive)");
});

test("every other scheme is refused", () => {
  for (const href of ["mailto:a@b.c", "tel:+5561999999999", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "ftp://example.com/", "colony://play", "vscode://file/x"]) {
    assert.equal(webUrl(href), null, href);
  }
});

test("relative paths, anchors and broken addresses are refused", () => {
  for (const href of ["", "#top", "README.md", "./a.md", "//example.com/x", "https://", "http:///nohost", "https:example.com", "http://exa mple.com/"]) {
    assert.equal(webUrl(href), null, JSON.stringify(href));
  }
});

test("a terminal link opens on Ctrl+click (or Cmd+click) only", () => {
  const url = "https://example.com/a";
  assert.deepEqual(termLinkClick({ ctrlKey: true, metaKey: false }, url), { open: url });
  assert.deepEqual(termLinkClick({ ctrlKey: false, metaKey: true }, url), { open: url });
  assert.deepEqual(termLinkClick({ ctrlKey: false, metaKey: false }, url), { hint: `Ctrl+click opens ${url} in your browser` });
});

test("both xterm link providers go through Colony's handler, never xterm's confirm()/window.open()", () => {
  // xterm's OSC 8 provider (src/browser/OscLinkProvider.ts in @xterm/xterm 5.5) calls
  // confirm() then window.open() when the Terminal has no linkHandler; the webview opens no
  // window, so an OSC 8 link did nothing on Ctrl+click (plan residual x1b). The COLONY_SMOKE
  // step web-link-open clicks both kinds through the real xterm.
  const src = readFileSync(new URL("../src/termview.ts", import.meta.url), "utf8");
  assert.match(src, /linkHandler:\s*\{\s*activate:\s*\(ev, uri\) => activateLink\(ev, uri\),\s*allowNonHttpProtocols:\s*false\s*\}/);
  assert.match(src, /new WebLinksAddon\(\(ev, uri\) => activateLink\(ev, uri\)\)/);
});

test("an editor link: http(s) opens as written, command: stays Monaco's, every other scheme is refused", () => {
  assert.deepEqual(editorLink("https://example.com/a?q=1"), { open: "https://example.com/a?q=1" }, "the query kept as written");
  assert.deepEqual(editorLink("http://localhost:5173/x#y"), { open: "http://localhost:5173/x#y" });
  assert.equal(editorLink("command:editor.action.quickFix"), null, "Monaco's own hover actions");
  for (const uri of ["file:///etc/hostname", "mailto:a@b.c", "javascript:alert(1)", "ftp://example.com/", "data:text/html,x", "vscode://file/x"]) {
    assert.deepEqual(editorLink(uri), { refuse: `Not a web address Colony opens (http or https only): ${uri}` }, uri);
  }
});

test("the editor's links go through Colony's opener, never Monaco's window.open()/location.href", () => {
  // Monaco's default opener (editor/browser/services/openerService.js in monaco-editor 0.52)
  // calls window.open() for http(s), which the webview drops, and sets location.href for any
  // other scheme (plan residual x1c). registerLinkOpener puts Colony's opener first; the
  // COLONY_SMOKE step web-link-open Ctrl+clicks a link in a real editor.
  const src = readFileSync(new URL("../src/editor.ts", import.meta.url), "utf8");
  assert.match(src, /monaco\.editor\.registerLinkOpener\(\{\s*open\(uri\) \{[\s\S]*?editorLink\(uri\.toString\(true\)\)[\s\S]*?openInBrowser\(act\.open\)/);
  assert.doesNotMatch(src, /multiCursorModifier:\s*"ctrlCmd"/, "Ctrl+click stays the link gesture (Alt adds cursors)");
});
