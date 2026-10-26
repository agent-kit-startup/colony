// The plan CRUD dropdown button (Mission card, Plans view rows): one shared popover, built
// like the top bar's Plans menu (.menu, keyboard reachable). Its items come from
// ./plancrud.ts; a pick only hands `/<command> <file>` to the interactive agent (`ask`, the
// cockpit host's interactive()), where the kit command asks its own confirmation.
import { h } from "./api";
import { planActions } from "./plancrud";

let menu: HTMLElement | null = null;
let from: HTMLButtonElement | null = null;

function close(refocus = false) {
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  from?.setAttribute("aria-expanded", "false");
  if (refocus && from?.isConnected) from.focus();
  from = null;
}

/** Under its button, right edges aligned. A re-render replaces the button: then the shown
 *  button of the same plan anchors it. */
function place() {
  if (!menu) return;
  const plan = menu.dataset.plan ?? "";
  const anchor = from?.isConnected && from.offsetParent ? from : [...document.querySelectorAll<HTMLButtonElement>('[data-act="plan-crud"]')].find((b) => b.dataset.plan === plan && b.offsetParent);
  if (!anchor) return close();
  from = anchor;
  anchor.setAttribute("aria-expanded", "true");
  const r = anchor.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight) return close();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  menu.style.left = menu.style.bottom = "auto";
}

function popover(): HTMLElement {
  if (menu) return menu;
  const m = h("div", { id: "plan-crud-menu", class: "menu", role: "menu", "aria-label": "Plan actions", hidden: "" });
  m.addEventListener("click", (ev) => ev.stopPropagation());
  m.addEventListener("keydown", (ev) => {
    const items = [...m.querySelectorAll<HTMLButtonElement>("button")];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      items[(at + (ev.key === "ArrowDown" ? 1 : items.length - 1) + items.length) % items.length]?.focus();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      close(true);
    }
  });
  m.addEventListener("focusout", (ev) => {
    const to = ev.relatedTarget as Node | null;
    if (to && !m.contains(to) && to !== from) close();
  });
  // Closed by a click elsewhere, a resize, the window losing focus and Escape.
  for (const ev of ["click", "resize", "blur"]) window.addEventListener(ev, () => close());
  // A scroll (the operator's, or a re-render restoring a view's scroll) moves the button: the
  // popover follows it, or closes once the button is out of view.
  window.addEventListener("scroll", (ev) => !m.hidden && !m.contains(ev.target as Node) && place(), true);
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && menu && !menu.hidden) close(true);
  });
  document.body.append(m);
  menu = m;
  return m;
}

/** The dropdown of plan `file`; `active`: the HANDOFF plan (Edit only). */
export function planCrudButton(file: string, lifecycle: string, active: boolean, ask: (prompt: string, why: string) => unknown): HTMLButtonElement {
  const acts = planActions(file, lifecycle, active);
  const b = h(
    "button",
    { class: "status-bar-btn plan-crud-btn", "data-act": "plan-crud", "aria-haspopup": "menu", "aria-expanded": "false", title: `Edit${active ? "" : ", archive, cancel or delete"} this plan: each opens your agent with the kit command, which asks before it changes anything` },
    "Plan",
    chevron(),
  );
  b.dataset.plan = file;
  if (!acts.length) b.disabled = true;
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const m = popover();
    if (!m.hidden && from === b) return close();
    close();
    m.replaceChildren(
      ...acts.map((a) => {
        const item = h("button", { role: "menuitem", "data-crud": a.id, title: a.title }, a.label);
        item.addEventListener("click", () => {
          close();
          void ask(a.prompt, a.why);
        });
        return item;
      }),
      ...(active ? [h("div", { class: "menu-label" }, "Archive, cancel and delete stop on the active plan: park or finish it first.")] : []),
    );
    m.dataset.plan = file;
    m.hidden = false;
    from = b;
    b.setAttribute("aria-expanded", "true");
    place();
    // Opened from the keyboard (no pointer: detail 0): focus its first item.
    if (ev.detail === 0) m.querySelector<HTMLButtonElement>("button")?.focus();
  });
  return b;
}

function chevron(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", "M4.5 6.5 8 10l3.5-3.5");
  svg.append(p);
  return svg;
}
