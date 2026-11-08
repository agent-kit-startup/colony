// Which addresses Colony hands to the system browser (src/weblink.ts): http and https with a
// host, nothing else. The opener plugin's capability scope refuses the rest again
// (src-tauri/capabilities/default.json, cargo test opener_scope_http_https_only). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { webUrl } from "../src/weblink.ts";

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
