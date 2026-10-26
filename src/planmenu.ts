// The plan CRUD dropdown button (Mission card, Plans view rows): one shared popover, built
// like the top bar's Plans menu (.menu, keyboard reachable). Its items come from
// ./plancrud.ts; a pick only hands `/<command> <file>` to the interactive agent (`ask`, the
// cockpit host's interactive()), where the kit command asks its own confirmation.
import { h } from "./api";
import { type PlanAction, type PlanLists, planActions } from "./plancrud";

interface Spec {
  file: string;
  acts: PlanAction[];
  note: string;
  ask: (prompt: string, why: string) => unknown;
}

/** The spec of every dropdown button (a re-render replaces the buttons). */
const specs = new WeakMap<HTMLButtonElement, Spec>();
let menu: HTMLElement | null = null;
let from: HTMLButtonElement | null = null;
let placing = 0;

/** Close this popover (main.ts closes it when the Plans or More menu opens). */
export function closePlanMenu(refocus = false) {
  if (!menu || menu.hidden) return;
  // The button may have been replaced by a re-render: refocus the one on screen.
  if (refocus && !from?.isConnected) anchorNow();
  menu.hidden = true;
  from?.setAttribute("aria-expanded", "false");
  if (refocus && from?.isConnected) from.focus();
  from = null;
}

/** The shown button of the open menu's plan (the one it opened from, or its replacement). */
function anchorNow(): HTMLButtonElement | undefined {
  const plan = menu?.dataset.plan ?? "";
  if (from?.isConnected && from.offsetParent) return from;
  const b = [...document.querySelectorAll<HTMLButtonElement>('[data-act="plan-crud"]')].find((x) => x.dataset.plan === plan && x.offsetParent);
  if (b) from = b;
  return b;
}

/** The items of `spec`, keeping the focused item's place. */
function fill(m: HTMLElement, spec: Spec) {
  const sig = `${spec.file}|${spec.acts.map((a) => a.id).join()}|${spec.note}`;
  if (m.dataset.sig === sig) return;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.crud;
  m.dataset.sig = sig;
  m.dataset.plan = spec.file;
  m.replaceChildren(
    ...spec.acts.map((a) => {
      const item = h("button", { role: "menuitem", "data-crud": a.id, title: a.title }, a.label);
      item.addEventListener("click", () => {
        closePlanMenu();
        void spec.ask(a.prompt, a.why);
      });
      return item;
    }),
    ...(spec.note ? [h("div", { class: "menu-label" }, spec.note)] : []),
  );
  if (focused) m.querySelector<HTMLButtonElement>(`[data-crud="${focused}"]`)?.focus();
}

/** Under its button, right edges aligned; follows a scroll and a re-render (the replaced
 *  button's actions, which may have changed), closes once the button is gone or off screen. */
function place() {
  if (!menu || menu.hidden) return;
  const anchor = anchorNow();
  const spec = anchor && specs.get(anchor);
  if (!anchor || !spec?.acts.length) return closePlanMenu();
  const r = anchor.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight) return closePlanMenu();
  anchor.setAttribute("aria-expanded", "true");
  fill(menu, spec);
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  menu.style.left = menu.style.bottom = "auto";
}
function placeSoon() {
  if (placing) return;
  placing = requestAnimationFrame(() => {
    placing = 0;
    place();
  });
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
    }
  });
  m.addEventListener("focusout", (ev) => {
    const to = ev.relatedTarget as Node | null;
    if (to && !m.contains(to) && to !== from) closePlanMenu();
  });
  // Closed by a click elsewhere, a resize, the window losing focus and Escape (back to its
  // button); a scroll moves it with its button.
  for (const ev of ["click", "resize", "blur"]) window.addEventListener(ev, () => closePlanMenu());
  window.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || m.hidden) return;
    ev.preventDefault();
    closePlanMenu(true);
  });
  window.addEventListener("scroll", (ev) => !m.hidden && !m.contains(ev.target as Node) && placeSoon(), true);
  document.body.append(m);
  menu = m;
  return m;
}

/**
 * The dropdown of plan `file`. `lists`: where HANDOFF lists it. `active`: the HANDOFF plan
 * or the one Colony is running (Edit only); `note` says why the remove actions are missing.
 */
export function planCrudButton(file: string, lists: PlanLists, active: boolean, ask: (prompt: string, why: string) => unknown, note = ""): HTMLButtonElement {
  const spec: Spec = { file, acts: planActions(file, lists, active), note: active ? note : "", ask };
  const b = h(
    "button",
    { class: "status-bar-btn plan-crud-btn", "data-act": "plan-crud", "aria-haspopup": "menu", "aria-expanded": "false", title: `Edit${active ? "" : ", archive, cancel or delete"} this plan: each opens your agent with the kit command, which asks before it changes anything` },
    "Plan",
    chevron(),
  );
  b.dataset.plan = file;
  specs.set(b, spec);
  if (!spec.acts.length) b.disabled = true;
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const m = popover();
    if (!m.hidden && from === b) return closePlanMenu();
    closePlanMenu();
    // One popover at a time: the top bar's Plans menu and More close (main.ts).
    window.dispatchEvent(new CustomEvent("colony:popover", { detail: "plan-crud" }));
    from = b;
    m.dataset.sig = "";
    m.hidden = false;
    place();
    // Opened from the keyboard (no pointer: detail 0): focus its first item.
    if (ev.detail === 0) m.querySelector<HTMLButtonElement>("button")?.focus();
  });
  // A re-render while this plan's menu is open: the menu moves to this button next frame.
  if (menu && !menu.hidden && menu.dataset.plan === file) placeSoon();
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
