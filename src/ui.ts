// Small DOM helpers shared by the cockpit views.
import { h } from "./api";
import { icon, type IconKind } from "./icons";

export function btn(label: string, onClick: () => void, attrs: Record<string, string> = {}): HTMLButtonElement {
  const b = h("button", attrs, label);
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return b;
}

/** A button led by a kit SVG icon instead of a unicode glyph. With no text the button is
 *  icon-only, so `aria-label` carries its name (the SVG itself is aria-hidden). */
export function iconBtn(kind: IconKind, text: string, onClick: () => void, attrs: Record<string, string> = {}): HTMLButtonElement {
  const b = btn("", onClick, text ? attrs : { "aria-label": attrs.title ?? kind, ...attrs });
  b.classList.add("has-icon");
  b.replaceChildren(icon(kind, "btn-icon"), ...(text ? [h("span", {}, text)] : []));
  return b;
}

export function chip(text: string, cls = ""): HTMLElement {
  return h("span", { class: `chip ${cls}` }, text);
}

/** Status pill tones: the dashboard's lifecycle-pill / now-status colors. */
export type Tone = "executing" | "running" | "awaiting" | "parked" | "backlog" | "incomplete" | "completed" | "failed" | "idle";

/**
 * Solid status pill (dashboard .lifecycle-pill / .now-status): filled semantic surface,
 * uppercase 11px, squared to --mc-radius-chrome, with a mark glyph as the non-color cue.
 */
export function pill(label: string, tone: Tone, mark = ""): HTMLElement {
  return h("span", { class: `pill pill-${tone}` }, ...(mark ? [h("span", { class: "pill-mark", "aria-hidden": "true" }, mark)] : []), label);
}

/** Lifecycle labels and marks of the dashboard's lifecycleMeta() (parked: U+23F8 instead of the
 *  dashboard's U+20E0, a combining mark with no base glyph). */
const LIFECYCLE: Record<string, [string, Tone, string]> = {
  executing: ["Executing", "executing", "\u25B6"],
  awaiting_user: ["Awaiting", "awaiting", "\u23EF"],
  parked: ["Parked", "parked", "\u23F8"],
  backlog: ["Backlog", "backlog", "\u23F9"],
  incomplete: ["Incomplete", "incomplete", "\u26A0"],
  completed: ["Completed", "completed", "\u2713"],
};

export function lifecycleChip(lc: string): HTMLElement {
  const [label, tone, mark] = LIFECYCLE[lc] ?? [lc.replace(/_/g, " ") || "unknown", "idle" as Tone, "\u25CB"];
  const el = pill(label, tone, mark);
  el.dataset.lifecycle = lc;
  return el;
}

/** Continuous progress bar (dashboard .plan-progress-bar), for very long to-do lists. */
export function bar(done: number, total: number): HTMLElement {
  const pct = total > 0 ? Math.round((100 * done) / total) : 0;
  const fill = h("span", { class: "bar-fill" });
  fill.style.width = `${pct}%`;
  return h("span", { class: "bar", title: `${done} of ${total} (${pct}%)` }, fill);
}

/**
 * Per-to-do segmented progress (dashboard .now-stepbar): one segment per to-do, done
 * green, the current one blue (shimmer while live), the rest on --border. Over 40 to-dos
 * it falls back to the continuous bar.
 */
export function stepbar(done: number, total: number, current: boolean, label = true): HTMLElement {
  const d = Math.min(Math.max(done, 0), total);
  const cur = current && d < total;
  const rest = Math.max(0, total - d - (cur ? 1 : 0));
  const aria = `${d} of ${total} to-dos complete${cur ? ", 1 in progress" : ""}`;
  const track =
    total > 40
      ? bar(d, total)
      : h(
          "div",
          { class: "now-stepbar", role: "img", "aria-label": aria, title: aria },
          ...Array.from({ length: d }, () => h("span", { class: "now-stepbar-seg now-stepbar-seg-done" })),
          ...(cur ? [h("span", { class: "now-stepbar-seg now-stepbar-seg-current" })] : []),
          ...Array.from({ length: rest }, () => h("span", { class: "now-stepbar-seg" })),
        );
  return h("div", { class: "now-stepbar-row" }, track, ...(label ? [h("span", { class: "now-stepbar-label" }, `${d} of ${total}`)] : []));
}

export interface Step {
  /** "Previous", "Current", "Next" (or "Final step", "Next up"). */
  label: string;
  /** A to-do (id in monospace, then its text) or a plain line. */
  todo?: { id: string; content: string } | null;
  text?: string;
  /** Marker glyph and state. */
  mark: string;
  state: "done" | "current" | "pending" | "empty";
  cls?: string;
}

/** Connected previous -> current -> next blocks (dashboard .now-stepper). */
export function stepper(steps: Step[], aria = "Work progression: previous, current, next"): HTMLElement {
  return h(
    "ol",
    { class: "now-stepper", "aria-label": aria },
    ...steps.map((s) =>
      h(
        "li",
        { class: `now-step ${s.cls ?? ""} now-step-${s.state === "done" ? "done" : s.state === "empty" ? "empty" : s.state}`.trim() },
        h("span", { class: "now-step-marker", "aria-hidden": "true" }, s.mark),
        h(
          "div",
          { class: "now-step-body" },
          h("span", { class: "now-step-label" }, s.label),
          h("div", { class: "now-step-text", title: s.todo ? `${s.todo.id} \u2014 ${s.todo.content}` : (s.text ?? "") }, ...(s.todo ? [h("span", { class: "now-todo-id" }, s.todo.id), s.todo.content ? ` \u2014 ${s.todo.content}` : ""] : [s.text ?? "\u2014"])),
        ),
      ),
    ),
  );
}

export interface Meta {
  icon: IconKind;
  text: string;
  title?: string;
  /** Monospace value (paths, ids, times). */
  mono?: boolean;
  /** Spin the icon (the dashboard's executing Mode icon). */
  live?: boolean;
}

/** Quiet metadata strip with icons (dashboard .now-meta). */
export function metaRow(items: (Meta | null | false | undefined)[], cls = ""): HTMLElement {
  return h(
    "div",
    { class: `now-meta ${cls}`.trim(), role: "group" },
    ...items
      .filter((m): m is Meta => !!m && !!m.text)
      .map((m) =>
        h("span", { class: "now-meta-item", title: m.title ?? m.text }, icon(m.icon, `now-meta-icon${m.live ? " now-meta-icon-executing" : ""}`), h("span", { class: `now-meta-value${m.mono ? " mono" : ""}` }, m.text)),
      ),
  );
}

/** Card titles that get a header icon without the caller naming one. */
const CARD_ICONS: Record<string, IconKind> = {
  "Current mission": "current-mission",
  "Needs you": "inbox",
  "Agent runs": "monitor",
  Chats: "commands",
  Queue: "queue",
  "Queue status (HANDOFF)": "queue",
  "Flight Log": "field-report",
  Activity: "activity",
  Repository: "git",
  "Working tree": "git",
  "Production promotion": "shield",
  "Live gates": "inbox",
  Attention: "checklist",
  "Gate exits": "field-report",
  "Gate-exit tickets": "field-report",
  "Open triages": "checklist",
  "Ticks in this window": "activity",
  "Tick logs (.cursor/loop-logs)": "terminals",
};

export interface CardHead {
  title: string;
  icon?: IconKind;
  /** Right-aligned header content (status pills, counts, links). */
  aside?: (Node | string)[];
}

/** Card header: icon + title-case label on the left, an optional aside on the right. */
export function cardHeader(head: CardHead): HTMLElement {
  const kind = head.icon ?? CARD_ICONS[head.title];
  return h(
    "div",
    { class: "card-header" },
    h("span", { class: "card-title" }, ...(kind ? [icon(kind)] : []), head.title),
    ...(head.aside?.length ? [h("span", { class: "card-aside" }, ...head.aside)] : []),
  );
}

/** A card: a string title (icon looked up by title), a header spec, or a custom node. */
export function card(title: string | CardHead | Node, ...children: (Node | string)[]): HTMLElement {
  const head = typeof title === "string" ? cardHeader({ title }) : title instanceof Node ? h("div", { class: "card-header" }, h("span", { class: "card-title" }, title)) : cardHeader(title);
  return h("section", { class: "card" }, head, ...children);
}

export function empty(text: string): HTMLElement {
  return h("div", { class: "empty dim" }, text);
}

/** A byte count as B, KB (one decimal under 10 KB) or MB. */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ago(iso: unknown): string {
  if (typeof iso !== "string" || !iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 0) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Keep a view's scroll position across a full re-render. */
export function rerender(scroller: HTMLElement, render: () => void) {
  const top = scroller.scrollTop;
  render();
  scroller.scrollTop = top;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
