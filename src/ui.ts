// Small DOM helpers shared by the cockpit views.
import { h } from "./api";

export function btn(label: string, onClick: () => void, attrs: Record<string, string> = {}): HTMLButtonElement {
  const b = h("button", attrs, label);
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return b;
}

export function chip(text: string, cls = ""): HTMLElement {
  return h("span", { class: `chip ${cls}` }, text);
}

export function bar(done: number, total: number): HTMLElement {
  const pct = total > 0 ? Math.round((100 * done) / total) : 0;
  const fill = h("span", { class: "bar-fill" });
  fill.style.width = `${pct}%`;
  return h("span", { class: "bar", title: `${done} of ${total} (${pct}%)` }, fill);
}

export function card(title: string | Node, ...children: (Node | string)[]): HTMLElement {
  return h("section", { class: "card" }, h("div", { class: "card-title" }, title), ...children);
}

export function empty(text: string): HTMLElement {
  return h("div", { class: "empty dim" }, text);
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

export const LIFECYCLE_CLASS: Record<string, string> = {
  executing: "chip-running",
  awaiting_user: "chip-gate",
  backlog: "chip-backlog",
  parked: "chip-parked",
  incomplete: "chip-failed",
  completed: "chip-done",
};

export function lifecycleChip(lc: string): HTMLElement {
  return chip(lc.replace(/_/g, " "), LIFECYCLE_CLASS[lc] ?? "");
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
