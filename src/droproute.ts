// Where a file dropped on the window from the desktop goes. WebKit's HTML5 drop has no
// filesystem paths, so the window keeps Tauri's native handler (src-tauri/src/dragdrop.rs)
// and listens to its drag-drop event (paths and a position) instead:
//  - a terminal: the quoted paths are typed in (nothing runs);
//  - an Explorer row or the Explorer: the files are copied into that folder (or the
//    folder of the row's file; the workspace root below the rows);
//  - anywhere else in the centre: the editor opens each file.
// Pure: no DOM types, so Node runs it with its types stripped (scripts/droproute.test.mjs).

/** The part of a DOM element the routing reads. */
export interface DropHit {
  closest(selector: string): DropHit | null;
  readonly dataset: { readonly [key: string]: string | undefined };
  readonly classList: { contains(token: string): boolean };
}

export type DropZone = { kind: "terminal" } | { kind: "explorer"; dir: string } | { kind: "editor" } | { kind: "none" };

/** The zone under the element `hit` (`document.elementFromPoint` at the drop). */
export function dropZone(hit: DropHit | null, root: string | null): DropZone {
  if (!hit) return { kind: "none" };
  if (hit.closest(".xterm")) return { kind: "terminal" };
  if (root) {
    const row = hit.closest(".tree-row");
    const p = row?.dataset.path;
    if (row && p) return { kind: "explorer", dir: row.classList.contains("dir") ? p : parentDir(p) };
    if (hit.closest("#side")) return { kind: "explorer", dir: root };
    if (hit.closest("#center")) return { kind: "editor" };
  }
  return { kind: "none" };
}

export function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "/";
}

/** `p` as one POSIX shell word: as is when it is plain, else single-quoted. */
export function shellQuote(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

/** What a drop on a terminal types: the quoted paths, a space after the last one. */
export function terminalText(paths: string[]): string {
  return paths.length ? `${paths.map(shellQuote).join(" ")} ` : "";
}

/**
 * The drop position in CSS pixels. Tauri types it physical, but on Linux wry hands over
 * GTK widget coordinates (`wry src/webkitgtk/drag_drop.rs`), which are already the page's
 * CSS pixels at zoom 1; elsewhere it is device pixels.
 */
export function dropPoint(pos: { x: number; y: number }, linux: boolean, scale: number): { x: number; y: number } {
  const s = linux || !(scale > 0) ? 1 : scale;
  return { x: pos.x / s, y: pos.y / s };
}
