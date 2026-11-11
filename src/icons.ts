// Chrome icons of the native Mission Control views, drawn as crisp 1px lines (plan
// colony-sidebar-native-kit s4). Same SVG shell everywhere: viewBox 0 0 16 16, stroke 1,
// butt caps and miter joins, sized by CSS at 16px (.rail-icon, .tab-svg, .space-icon)
// so one SVG unit is one device pixel at 1x and two at 2x.
//
// Grid rules (what keeps a 1px stroke on the pixel grid):
// - horizontal and vertical lines run on half coordinates (y=4.5 covers the pixel row 4);
//   their endpoints sit on whole coordinates, so a butt cap ends on a pixel edge;
// - <rect> x and y are half coordinates and width and height whole numbers;
// - <circle> centres and radii are chosen so cx±r and cy±r land on half coordinates;
// - curves and diagonals anti-alias whatever the grid; filled marks (queue's play mark, the
//   More dots) keep their straight edges on whole coordinates.
// Icons inlined in text at 12px (.btn-icon, .now-meta-icon) scale by 0.75 and soften; the
// chrome sizes are the crisp ones. The kinds began as copies of the kit's web Mission
// Control glyphs (dashboard.html spaceIconSvg and nowMetaIconSvg, stroke 1.5); the web MC
// icon set does not follow this restyle (Colony-only, the plan's default).
// Static markup only: never concatenate untrusted text into these strings.

import { enterPlays, markMotion, phaseDelay, type StateGroup, stateRow } from "./drivermotion";

const PATHS = {
  // Cockpit: a rocket
  "current-mission":
    '<path d="M8 1c1.5 2 2.5 4 2.5 6.5v3h-5v-3C5.5 5 6.5 3 8 1z"/><circle cx="8" cy="6" r="1.5"/><path d="M5.5 9L3 12.5M10.5 9L13 12.5M6 12.5h4"/>',
  // Queue: stacked rows behind a play mark
  queue: '<path d="M7 3.5h7M7 8.5h7M3 12.5h11"/><path d="M3 2l3 2.5L3 7z" fill="currentColor" stroke="none"/>',
  // Inbox: a tray
  inbox: '<path d="M4 3.5h8l1.5 6v4h-11v-4z"/><path d="M2.5 9.5h3l1 2h3l1-2h3"/>',
  // Chats: two speech bubbles
  chats: '<path d="M1.5 2.5h9v6h-5l-2 2v-2h-2z"/><path d="M12.5 5.5h2v6h-2l-2 2v-2h-2"/>',
  // Flight Log: a bound log book
  "flight-log": '<rect x="3.5" y="1.5" width="10" height="13" rx="1"/><path d="M2 4.5h3M2 8.5h3M2 12.5h3M8 5.5h3M8 10.5h3"/>',
  // Review: plus and minus in a document
  review: '<rect x="2.5" y="1.5" width="11" height="13" rx="1"/><path d="M5 5.5h5M7.5 3v5M5 10.5h5"/>',
  // Ship: a paper plane
  ship: '<path d="M14.5 1.5L1.5 6.5l5.5 2 2 5.5z"/><path d="M14.5 1.5L7 8.5"/>',
  // Activity: a pulse line
  activity: '<path d="M1 8.5h3.5L6.5 3l3 10 2-4.5h3.5"/>',
  // Terminals: a window with a prompt
  terminals: '<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M4 6l2.5 2L4 10M8 10.5h3"/>',
  // Processes: stacked layers
  processes: '<path d="M8 2.5l6 3-6 3-6-3z"/><path d="M2 7.5l6 3 6-3M2 10.5l6 3 6-3"/>',
  // Workspace: a 2x2 grid of panes
  workspace: '<rect x="1.5" y="1.5" width="5" height="5" rx="1"/><rect x="9.5" y="1.5" width="5" height="5" rx="1"/><rect x="1.5" y="9.5" width="5" height="5" rx="1"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/>',
  // Colony: a habitat dome on the ground
  colony: '<path d="M2.5 11.5V9a5.5 5.5 0 0111 0v2.5"/><path d="M1 11.5h14M6.5 11.5v-3h2v3"/>',
  // Workspace sections and cards (the former dashboard spaceIconSvg kinds)
  monitor: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2.5"/><path d="M8 8l4.5-4.5"/>',
  "field-report": '<rect x="3.5" y="3.5" width="9" height="11" rx="1"/><path d="M5.5 3.5v-1a2.5 2.5 0 015 0v1"/><path d="M6 7.5h4M6 10.5h4"/>',
  checklist: '<path d="M3 4.5h9M3 8.5h6M3 12.5h5"/><path d="M10.5 10.5l1.5 1.5L15 9"/>',
  overview: '<path d="M2 7.5L8 2.5l6 5"/><path d="M3.5 7v7.5h9V7"/><path d="M6.5 14.5v-4h3v4"/>',
  plans: '<path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3"/>',
  agents: '<circle cx="8" cy="5" r="2.5"/><path d="M3.5 14.5v-1a4.5 4.5 0 019 0v1"/>',
  commands: '<path d="M2 3.5l5 4.5-5 4.5"/><path d="M8 12.5h6"/>',
  health: '<path d="M8 13.5L3.5 9a3 3 0 014.5-3.5A3 3 0 0112.5 9z"/>',
  git: '<circle cx="11.5" cy="3.5" r="2"/><circle cx="4.5" cy="12.5" r="2"/><path d="M4.5 10.5V9a1.5 1.5 0 011.5-1.5h4A1.5 1.5 0 0011.5 6V5.5"/>',
  devops: '<circle cx="5" cy="8" r="2.5"/><circle cx="11" cy="8" r="2.5"/>',
  config: '<path d="M2 4.5h3.5M9.5 4.5h4.5"/><circle cx="7.5" cy="4.5" r="2"/><path d="M2 11.5h5.5M13.5 11.5h1.5"/><circle cx="9.5" cy="11.5" r="2"/>',
  skins: '<rect x="1.5" y="2.5" width="8" height="8" rx="1"/><rect x="6.5" y="5.5" width="8" height="8" rx="1"/>',
  // Rules: a shield
  shield: '<path d="M8 1.5l5.5 2v4c0 3.5-2.5 6-5.5 7-3-1-5.5-3.5-5.5-7v-4z"/>',
  // Metadata rows (the former dashboard nowMetaIconSvg kinds)
  mode: '<circle cx="7.5" cy="7.5" r="2"/><path d="M7.5 1v2M7.5 12v2M1 7.5h2M12 7.5h2M3 3l1.5 1.5M10.5 10.5L12 12M12 3l-1.5 1.5M4.5 10.5L3 12"/>',
  elapsed: '<path d="M5 1.5h5M7.5 2v3.5"/><circle cx="7.5" cy="9.5" r="4"/><path d="M7.5 9.5V6"/>',
  updated: '<circle cx="7.5" cy="7.5" r="5"/><path d="M7.5 4v3.5l2 2"/>',
  folder: '<path d="M1.5 3.5h4l2 2h7v8h-13z"/>',
  // Refresh: a circular arrow, in place of the unicode ↻ on reload buttons
  refresh: '<path d="M13.5 8a5.5 5.5 0 11-1.6-3.9"/><path d="M13.5 2v3.5H10"/>',
  // Run, hold and stop marks (buttons and rows): the same 10px extent, all three stroked
  play: '<path d="M4.5 3l8 5-8 5z"/>',
  pause: '<path d="M5.5 3v10M10.5 3v10"/>',
  stop: '<rect x="3.5" y="3.5" width="9" height="9"/>',
  // Driver state marks (kit ADR 2026-10-29_colony-driver-motion-contract.md): a gate waiting
  // for you (the bar and triangle of the old U+23EF), done, failed, idle (the old U+25CB)
  gate: '<path d="M2.5 3l7 5-7 5z"/><path d="M12.5 3v10"/>',
  check: '<path d="M3 8.5l3.5 3.5L13 4.5"/>',
  cross: '<path d="M4 4l8 8M12 4l-8 8"/>',
  idle: '<circle cx="8" cy="8" r="4.5"/>',
  // Back / Forward in the main pane's history
  back: '<path d="M10 3.5L5.5 8l4.5 4.5"/>',
  forward: '<path d="M6 3.5L10.5 8 6 12.5"/>',
  // More: three dots
  more: '<circle cx="4" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="8" r="1" fill="currentColor" stroke="none"/>',
  // Engine: a chip
  engine: '<rect x="3.5" y="3.5" width="9" height="9" rx="1"/><path d="M6.5 1v2.5M9.5 1v2.5M6.5 12.5V15M9.5 12.5V15M1 6.5h2.5M1 9.5h2.5M12.5 6.5H15M12.5 9.5H15"/>',
} as const;

export type IconKind = keyof typeof PATHS;

/** The SVG shell every icon shares (also read by scripts/icons.test.mjs). */
export const ICON_SHELL = 'width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="2"';

/** A 16px chrome icon (decorative: aria-hidden, the label sits next to it). */
export function icon(kind: IconKind, cls = "space-icon"): SVGSVGElement {
  const t = document.createElement("template");
  t.innerHTML = `<svg class="${cls}" ${ICON_SHELL} aria-hidden="true">${PATHS[kind]}</svg>`;
  return t.content.firstElementChild as SVGSVGElement;
}

/** The activity ring of a running mark: a 1px three-quarter arc at r 7.5 (cx±r on half
 *  coordinates), clear of every glyph, which styles.css scales inside it while it turns. */
const RING = '<path d="M8 0.5A7.5 7.5 0 1 1 0.5 8"/>';

/** Last state drawn per key, so a one-shot (the mark's enter, a pill's crossfade) plays on a
 *  change only. */
const markState = new Map<string, string>();

/** Records `state` for `key` and says whether it changed since the key was last drawn (never on
 *  a first sighting: a first render or a stored transcript stays still). */
export function stateChanged(key: string, state: string): boolean {
  const prev = markState.get(key);
  markState.set(key, state);
  return enterPlays(prev, state);
}

/**
 * Adds a one-shot animation class and drops it once the animation ends or is cancelled. A
 * hidden view shown again re-attaches its old nodes, and CSS restarts every animation of a node
 * that comes back from display: none: without this a state change would replay on each visit.
 * `on`: the element that runs the animation (default `el`); `after`: the class left in its place.
 */
export function oneShot<T extends Element>(el: T, cls: string, on: Element = el, after = ""): T {
  el.classList.add(cls);
  const done = (e: Event) => {
    if (e.target !== on) return;
    if (after) el.classList.replace(cls, after);
    else el.classList.remove(cls);
    on.removeEventListener("animationend", done);
    on.removeEventListener("animationcancel", done);
  };
  on.addEventListener("animationend", done);
  on.addEventListener("animationcancel", done);
  return el;
}

/** The state-change crossfade of a pill, chip or line (ADR point 5): `el` fades in over
 *  --motion-fast when the thing `key` names changed state since it was last drawn. Keys are
 *  per surface (the same launch in two cards has two keys), so each copy plays its own fade. */
export function crossfade<T extends Element>(el: T, key: string, state: string): T {
  return stateChanged(`fade:${key}`, state) ? oneShot(el, "state-fade") : el;
}

/**
 * A driver state mark (12px, inline in a pill or chip): the state's icon with its motion
 * class from src/drivermotion.ts. `key` names the thing whose state it shows (a run tab, the
 * mission, the queue hero) and enables the one-shot enter on a state change. `still` draws the
 * icon without motion: a card has one loop at most, on its status mark (ADR point 2).
 */
export function stateMark(group: StateGroup, state: string, opts: { key?: string; still?: boolean } = {}): HTMLElement {
  const row = stateRow(group, state);
  // A still mark neither reads nor records the key: a still copy of a run's state drawn earlier
  // in the same render must not use up the enter of the mark that animates it.
  const key = opts.still ? "" : (opts.key ?? "");
  const changed = key ? stateChanged(key, state) : false;
  const motion = markMotion(row, !!opts.still, changed);
  const el = document.createElement("span");
  el.className = `state-mark motion-${motion}`;
  el.dataset.state = `${group}:${row.known ? state : "idle"}`;
  el.dataset.motion = row.motion;
  el.setAttribute("aria-hidden", "true");
  const glyph = icon(row.icon, "state-icon");
  el.append(glyph);
  // The enter is the icon's animation: once it ends the mark is static, so a view shown again
  // does not replay it.
  if (motion === "enter") oneShot(el, "motion-enter", glyph, "motion-none");
  const delay = phaseDelay(motion, performance.now());
  if (motion === "pulse") glyph.style.animationDelay = delay;
  if (motion === "loop") {
    const t = document.createElement("template");
    t.innerHTML = `<svg class="state-ring" ${ICON_SHELL} aria-hidden="true">${RING}</svg>`;
    const ring = t.content.firstElementChild as SVGSVGElement;
    ring.style.animationDelay = delay;
    el.append(ring);
  }
  return el;
}
