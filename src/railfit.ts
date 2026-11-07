// Rail labels read as whole words (plan colony-rail-labels-whole-words): no label breaks
// inside a word, no label runs past its item, the rail never scrolls sideways. No imports, so
// scripts/*.test.mjs loads the verdict; the COLONY_SMOKE run in src/main.ts measures the DOM.

/** Horizontal extent of one line box, in CSS px. */
export interface Span {
  left: number;
  right: number;
}

export interface LabelGeometry {
  label: string;
  /** The item's content box (inside its border and padding). */
  content: Span;
  /** One entry per word of the label: the line boxes it was laid out on. */
  words: { word: string; lines: Span[] }[];
}

export interface LabelFit {
  label: string;
  /** Words laid out on more than one line: broken inside the word. */
  broken: string[];
  /** Px the text runs past the item's content box (0 when it fits). */
  overflow: number;
}

export interface RailFit {
  ok: boolean;
  /** rail.scrollWidth - rail.clientWidth: above 0 means the rail scrolls sideways. */
  railOverflowX: number;
  labels: LabelFit[];
}

/** Sub-pixel slack: layout rounds line boxes and borders to device pixels. */
const SLACK = 0.5;

export function railFitVerdict(railOverflowX: number, labels: LabelGeometry[]): RailFit {
  const fits = labels.map((l): LabelFit => {
    const broken = l.words.filter((w) => w.lines.length > 1).map((w) => w.word);
    const lines = l.words.flatMap((w) => w.lines);
    const past = lines.reduce((m, r) => Math.max(m, l.content.left - r.left, r.right - l.content.right), 0);
    return { label: l.label, broken, overflow: past > SLACK ? Math.round(past * 10) / 10 : 0 };
  });
  const ok = railOverflowX <= 0 && fits.every((f) => !f.broken.length && !f.overflow);
  return { ok, railOverflowX, labels: fits };
}

/** Line boxes of text[start, end) in one text node, merged per line (same top). */
function lineSpans(node: Text, start: number, end: number): Span[] {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const byTop = new Map<number, Span>();
  for (const r of range.getClientRects()) {
    if (r.width === 0) continue;
    const top = Math.round(r.top);
    const s = byTop.get(top);
    byTop.set(top, s ? { left: Math.min(s.left, r.left), right: Math.max(s.right, r.right) } : { left: r.left, right: r.right });
  }
  return [...byTop.values()];
}

/** Geometry of every `.rail-item .lbl` under `rail`, then the verdict. */
export function railFit(rail: HTMLElement): RailFit {
  const labels: LabelGeometry[] = [];
  for (const item of rail.querySelectorAll<HTMLElement>(".rail-item")) {
    const lbl = item.querySelector<HTMLElement>(".lbl");
    const node = lbl?.firstChild;
    if (!lbl || !(node instanceof Text)) continue;
    const box = item.getBoundingClientRect();
    const cs = getComputedStyle(item);
    const inset = (side: "Left" | "Right") => parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`)) + parseFloat(cs.getPropertyValue(`padding-${side.toLowerCase()}`));
    const content = { left: box.left + inset("Left"), right: box.right - inset("Right") };
    const text = node.data;
    const words: LabelGeometry["words"] = [];
    for (const m of text.matchAll(/\S+/g)) words.push({ word: m[0], lines: lineSpans(node, m.index, m.index + m[0].length) });
    labels.push({ label: text, content, words });
  }
  return railFitVerdict(rail.scrollWidth - rail.clientWidth, labels);
}
