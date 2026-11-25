// The one check on an address before Colony hands it to the system browser (kit ADR
// 2026-10-15, amend 2026-11-07): http or https, written with `//` and a host. Everything else
// (mailto:, tel:, javascript:, file:, a relative path) is refused here, and the opener
// plugin's capability scope (src-tauri/capabilities/default.json) refuses it again. Pure, so
// scripts/weblink.test.mjs runs it under Node; keep to erasable syntax.

/** The address normalised (scheme and host lower-cased, which the scope globs need), or null
 *  when Colony must not open it. */
export function webUrl(href: string): string | null {
  const raw = href.trim();
  // The URL parser is lenient (`https:example.com`, `http:///host` parse): the written form
  // must already be scheme, `//`, then a host character.
  if (!/^https?:\/\/[^/\s?#]/i.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return null;
  return u.href;
}

/** A click on a link in a terminal, whichever xterm provider found it (an address printed as
 *  text, or an OSC 8 hyperlink): Ctrl+click (Cmd+click) opens it, as in VS Code and terminal
 *  emulators; a plain click stays a terminal click (selection, the program's own mouse mode)
 *  and only names the gesture. */
export function termLinkClick(mods: { ctrlKey: boolean; metaKey: boolean }, uri: string): { open: string } | { hint: string } {
  return mods.ctrlKey || mods.metaKey ? { open: uri } : { hint: `Ctrl+click opens ${uri} in your browser` };
}

/** A link Monaco opens (a Ctrl+click, Cmd+click on macOS, on an address it underlined, or a
 *  link in one of its hovers). Monaco's own opener would call window.open() for http(s),
 *  which the webview turns into nothing, and set location.href for any other scheme, which
 *  would navigate Colony's window. So: http(s) goes to the system browser, `command:` (the
 *  editor's own hover actions) stays Monaco's, and every other scheme is refused here. */
export function editorLink(uri: string): { open: string } | { refuse: string } | null {
  if (/^command:/i.test(uri)) return null;
  const url = webUrl(uri);
  return url ? { open: url } : { refuse: `Not a web address Colony opens (http or https only): ${uri}` };
}
