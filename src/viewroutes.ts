// Old view ids that moved (kit ADR 2026-10-24, amend 2026-11-19, points 2 and 5): Health
// folded into Activity and left Workspace, so `view:health` (palette, deep links, a focus by
// id) opens Activity at its health part. The ids of views that still exist route to
// themselves. Pure, so scripts/viewroutes.test.mjs runs it under Node.

/** Where an old id lands: the view, and the part of it to scroll into sight. */
export interface ViewRoute {
  view: string;
  part?: string;
}

/** Old id -> its new place. An id that is a view of its own never appears here. */
export const VIEW_ROUTES: Readonly<Record<string, ViewRoute>> = {
  health: { view: "activity", part: "health" },
};

/** The view `id` opens: its route when it moved, else itself. */
export function routeView(id: string): ViewRoute {
  return VIEW_ROUTES[id] ?? { view: id };
}
