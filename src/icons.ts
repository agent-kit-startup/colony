// Chrome icons of the native Mission Control views. The glyphs are copied from the kit's
// web Mission Control (agent-kit dashboard/dashboard.html: spaceIconSvg and nowMetaIconSvg,
// kit commit 485f599a) so card headers and metadata rows read the same in both. Same SVG
// shell: viewBox 0 0 16 16, stroke 1.5, round caps and joins, sized by CSS
// (.space-icon = --mc-chrome-icon-size, .now-meta-icon = --mc-chrome-subtitle-size).
// Kinds marked "Colony" have no dashboard counterpart. Static markup only: never
// concatenate untrusted text into these strings.

const PATHS = {
  // dashboard spaceIconSvg
  "current-mission":
    '<path d="M8 2c1.4 2 2.5 4 2.5 6a2.5 2.5 0 01-5 0C5.5 6 6.6 4 8 2z"/><circle cx="8" cy="7.5" r="1" fill="currentColor" stroke="none"/><path d="M6 10.5l-1 2M10 10.5l1 2M7 13h2"/>',
  monitor: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2.75"/><path d="M8 8L12.8 4.2A5.5 5.5 0 0 1 13.3 7.2Z"/>',
  "field-report": '<rect x="4.5" y="3.5" width="7" height="10" rx="1.2"/><path d="M6.5 3.5V2.5a1.5 1.5 0 013 0v1"/><path d="M6.5 7h3M6.5 9.5h3"/>',
  checklist: '<path d="M3.5 4.5h9M3.5 8h6.5M3.5 11.5h5.5"/><path d="M10.5 10.5l1.2 1.2L14 9.5"/>',
  overview: '<path d="M2.5 7.5L8 2.75l5.5 4.75"/><path d="M4.25 7.75v6.5h7.5v-6.5"/><path d="M6.5 14.25v-3.25h3v3.25"/>',
  plans: '<path d="M4.5 2.5h5l4 4v8.5a1 1 0 01-1 1h-8a1 1 0 01-1-1v-12a1 1 0 011-1z"/><path d="M9.5 2.5v4h4"/>',
  activity: '<polyline points="1.5 8.5 5 8.5 6.5 4 8 12 9.5 7 11 10 14.5 10"/>',
  agents: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 14.5c0-3 2.2-5 5-5s5 2 5 5"/>',
  commands: '<path d="M2.5 3.5l5 5-5 5"/><path d="M9 13.5h5"/>',
  health: '<path d="M8 13.5l-4.5-4.5a3 3 0 014.5-3.5 3 3 0 014.5 3.5L8 13.5z"/>',
  git: '<path d="M10.5 4.5a2 2 0 100-4 2 2 0 000 4z"/><path d="M10.5 4.5v7a2 2 0 01-2 2h-2"/><path d="M6.5 11.5a2 2 0 100-4 2 2 0 000 4z"/><path d="M10.5 6.5v2"/>',
  devops: '<circle cx="5" cy="8" r="2.25"/><circle cx="11" cy="8" r="2.25"/><path d="M7.25 8h1.5"/>',
  terminals: '<path d="M1.5 3.5h13a1 1 0 011 1v7a1 1 0 01-1 1H1.5a1 1 0 01-1-1v-7a1 1 0 011-1z"/><path d="M5.5 12.5v2M10.5 12.5v2M4 14.5h8"/>',
  processes: '<path d="M8 2.5l6 3-6 3-6-3 6-3z"/><path d="M2 7.5l6 3 6-3"/><path d="M2 10.5l6 3 6-3"/>',
  config: '<path d="M2.5 4.5h3M11 4.5h3"/><circle cx="7.5" cy="4.5" r="1.5"/><path d="M2.5 11.5h5M13 11.5h1"/><circle cx="10" cy="11.5" r="1.5"/>',
  skins: '<rect x="2.5" y="3.5" width="7" height="7" rx="1.25"/><rect x="6.5" y="5.5" width="7" height="7" rx="1.25"/>',
  // Colony: inbox tray (Needs you, Live gates, Attention)
  inbox: '<path d="M2.5 9.5l1.6-5.2a1 1 0 011-.8h5.8a1 1 0 011 .8l1.6 5.2"/><path d="M2.5 9.5v3.5a1 1 0 001 1h9a1 1 0 001-1V9.5h-3l-1 1.5h-3l-1-1.5z"/>',
  // Colony: run queue (stacked rows with a play mark)
  queue: '<path d="M7.5 4h6M7.5 8h6M2.5 12h11"/><path d="M2.5 2.75L5.25 4.5 2.5 6.25z" fill="currentColor"/>',
  // Colony: diff / review (plus and minus in a document)
  review: '<rect x="3" y="2.5" width="10" height="11" rx="1.2"/><path d="M6 6h4M8 4v4M6 10.5h4"/>',
  // Colony: shield (production promotion)
  shield: '<path d="M8 2l5 2v4c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4z"/>',
  // dashboard nowMetaIconSvg
  mode: '<circle cx="8" cy="8" r="2.25"/><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M12.6 3.4l-1.06 1.06M4.46 11.54l-1.06 1.06"/>',
  elapsed: '<path d="M6.25 2.25h3.5M8 2.25v1.5"/><circle cx="8" cy="9" r="4.25"/><path d="M8 9V6.75"/>',
  updated: '<circle cx="8" cy="8" r="5.25"/><path d="M8 5.25V8l1.75 1.75"/>',
  // Colony: branch-less metadata (folder, engine)
  folder: '<path d="M2 4.5a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1z"/>',
  // Colony: refresh (circular arrow), replaces the unicode ↻ on reload buttons
  refresh: '<path d="M13 8a5 5 0 11-1.46-3.54"/><path d="M13 2.5v3h-3"/>',
  // Colony: run / hold marks, in place of the unicode ▶ and ⏸ on buttons and rows
  play: '<path d="M5 3.25l7.5 4.75L5 12.75z"/>',
  pause: '<path d="M5.75 3.5v9M10.25 3.5v9"/>',
  // Colony: Back / Forward in the main pane's history
  back: '<path d="M10 3.5L5.5 8l4.5 4.5"/>',
  forward: '<path d="M6 3.5L10.5 8 6 12.5"/>',
  // Colony: More (three dots)
  more: '<circle cx="3.5" cy="8" r="0.9" fill="currentColor"/><circle cx="8" cy="8" r="0.9" fill="currentColor"/><circle cx="12.5" cy="8" r="0.9" fill="currentColor"/>',
  engine: '<rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M6.5 2v2M9.5 2v2M6.5 12v2M9.5 12v2M2 6.5h2M2 9.5h2M12 6.5h2M12 9.5h2"/>',
} as const;

export type IconKind = keyof typeof PATHS;

/** A 16px chrome icon (decorative: aria-hidden, the label sits next to it). */
export function icon(kind: IconKind, cls = "space-icon"): SVGSVGElement {
  const t = document.createElement("template");
  t.innerHTML = `<svg class="${cls}" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[kind]}</svg>`;
  return t.content.firstElementChild as SVGSVGElement;
}
