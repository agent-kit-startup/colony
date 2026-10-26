// Markdown subset for the plan / HANDOFF preview and the run transcripts: headings, paragraphs,
// lists (with nesting depth), GitHub tables, fenced code, quotes, rules; inline code, bold
// and links. Pure (no DOM, no imports): it returns plain data, and the renderers in
// ./transcript.ts build the DOM with h() only, so any text, hostile or not, stays text.
// Node runs it in `pnpm test` with its types stripped: keep to erasable syntax.

export type Inline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "strong"; text: string }
  | { t: "link"; text: string; href: string };

export type Align = "left" | "center" | "right" | "";

export interface ListItem {
  depth: number;
  ordered: boolean;
  text: string;
}

export type Block =
  | { t: "heading"; level: number; text: string }
  | { t: "para"; text: string }
  | { t: "list"; items: ListItem[] }
  | { t: "code"; lang: string; text: string }
  | { t: "table"; head: string[]; align: Align[]; rows: string[][] }
  | { t: "quote"; text: string }
  | { t: "rule" };

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\))/g;

/** Inline code, bold and links; everything else is text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  INLINE.lastIndex = 0;
  for (let m = INLINE.exec(text); m; m = INLINE.exec(text)) {
    if (m.index > last) out.push({ t: "text", text: text.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith("`")) out.push({ t: "code", text: tok.slice(1, -1) });
    else if (tok.startsWith("**")) out.push({ t: "strong", text: tok.slice(2, -2) });
    else {
      const mid = tok.indexOf("](");
      out.push({ t: "link", text: tok.slice(1, mid), href: tok.slice(mid + 2, -1) });
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push({ t: "text", text: text.slice(last) });
  return out;
}

/** What a link may do: open a repo file in Colony ("repo"), copy a web address ("web"), or
 *  nothing (null: script, data and file URLs, in-page anchors). */
export function linkKind(href: string): "repo" | "web" | null {
  const h = href.trim();
  if (/^https?:\/\//i.test(h)) return "web";
  if (!h || h.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//")) return null;
  return "repo";
}

/** A leading `---` YAML block (plan files) and the rest. */
export function splitFrontmatter(text: string): { front: string | null; body: string } {
  const src = text.replace(/\r/g, "");
  if (!src.startsWith("---\n")) return { front: null, body: text };
  const end = src.indexOf("\n---", 3);
  if (end < 0) return { front: null, body: text };
  const after = src.indexOf("\n", end + 4);
  const close = src.slice(end + 4, after < 0 ? src.length : after);
  if (close.trim()) return { front: null, body: text };
  return { front: src.slice(4, end), body: after < 0 ? "" : src.slice(after + 1) };
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+.-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const BULLET = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const ALIGN_ROW = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Cells of a table row: split on `|` outside inline code, `\|` is a literal pipe. */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = "";
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "`") {
      code = !code;
      cur += c;
    } else if (c === "|" && !code) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function align(cell: string): Align {
  const l = cell.startsWith(":");
  const r = cell.endsWith(":");
  return l && r ? "center" : l ? "left" : r ? "right" : "";
}

/** Block structure of `text` (no frontmatter handling: see splitFrontmatter). */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  let list: ListItem[] | null = null;
  let quote: string[] | null = null;
  const flush = () => {
    if (para.length) out.push({ t: "para", text: para.join(" ") });
    para = [];
    list = null;
    if (quote) out.push({ t: "quote", text: quote.join(" ") });
    quote = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const mark = fence[1];
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(mark); i++) body.push(lines[i]);
      out.push({ t: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const q = QUOTE.exec(line);
    if (q) {
      if (!quote) {
        flush();
        quote = [];
      }
      quote.push(q[1].trim());
      continue;
    }
    if (quote) flush();
    const head = HEADING.exec(line);
    if (head) {
      flush();
      out.push({ t: "heading", level: head[1].length, text: head[2] });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      out.push({ t: "rule" });
      continue;
    }
    if (line.trimStart().startsWith("|") && i + 1 < lines.length && ALIGN_ROW.test(lines[i + 1]) && lines[i + 1].includes("|")) {
      flush();
      const head = cells(line);
      const al = cells(lines[i + 1]).map(align);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].trimStart().startsWith("|"); i++) {
        const r = cells(lines[i]);
        rows.push(head.map((_, k) => r[k] ?? ""));
      }
      i--;
      out.push({ t: "table", head, align: head.map((_, k) => al[k] ?? ""), rows });
      continue;
    }
    const b = BULLET.exec(line);
    if (b) {
      if (para.length) {
        out.push({ t: "para", text: para.join(" ") });
        para = [];
      }
      if (!list) {
        list = [];
        out.push({ t: "list", items: list });
      }
      list.push({ depth: Math.floor(b[1].replace(/\t/g, "  ").length / 2), ordered: /\d/.test(b[2]), text: b[3].trim() });
      continue;
    }
    // An indented line right after a list item continues that item.
    if (list && /^\s/.test(line)) {
      const item = list[list.length - 1];
      item.text = `${item.text} ${line.trim()}`;
      continue;
    }
    list = null;
    para.push(line.trim());
  }
  flush();
  return out;
}
