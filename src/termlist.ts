// The terminal drawer's list of the centre terminal tabs (pure: no DOM, no imports at run
// time). The drawer runs its own shells; the interactive vendor CLIs, resumed chats and
// old-engine queue runners stay centre tabs (their context strip, gate badge and launch
// tracking live there) and the drawer lists them as links. Driver runs (`run:<id>`) are
// not TTYs and have no PTY: they never appear here.
import type { IconKind } from "./icons";

export interface LinkedTerm {
  id: string;
  label: string;
  icon: IconKind;
  tip: string;
  /** The process ended; the tab stays open with its output until it is closed. */
  exited: boolean;
  /** Its output shows an open HITL_GATE line. */
  gate: boolean;
  /** The centre tab shown right now. */
  current: boolean;
}

/** The centre tabs that hold a PTY, in tab order. A PTY whose tab is gone is skipped. */
export function linkedTerms(
  order: readonly string[],
  tab: (id: string) => { label: string; icon: IconKind | ""; tip: string } | undefined,
  pty: (id: string) => { exited: boolean } | undefined,
  gate: (id: string) => string | null,
  active: string,
): LinkedTerm[] {
  const out: LinkedTerm[] = [];
  for (const id of order) {
    const t = tab(id);
    const p = pty(id);
    if (!t || !p) continue;
    out.push({ id, label: t.label, icon: t.icon || "terminals", tip: t.tip, exited: p.exited, gate: !p.exited && !!gate(id), current: id === active });
  }
  return out;
}
