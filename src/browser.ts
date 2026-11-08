// Web links open in the user's default browser (kit ADR 2026-10-15, amend 2026-11-07): the
// doc preview's links and Ctrl+click on a terminal link. The address passes webUrl first,
// then tauri-plugin-opener, whose capability scope admits http:// and https:// only and
// opens with the system default handler (no `with`). Colony embeds no web content.
import { openUrl } from "@tauri-apps/plugin-opener";
import { errText } from "./api";
import { webUrl } from "./weblink";

/** Open `href` in the system browser; the status line to show, whatever the outcome. A
 *  failure is reported, never turned into a copy. */
export async function openInBrowser(href: string): Promise<string> {
  const url = webUrl(href);
  if (!url) return `Not a web address Colony opens (http or https only): ${href}`;
  try {
    await openUrl(url);
    return `Opened ${url} in your browser`;
  } catch (e) {
    return `Could not open ${url}: ${errText(e)}`;
  }
}
