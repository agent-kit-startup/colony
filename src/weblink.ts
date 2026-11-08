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
