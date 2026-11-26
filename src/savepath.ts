// Save and Save as… (File menu, the Commands palette, Ctrl+S): the pure parts, so Node runs
// them with its types stripped (scripts/savepath.test.mjs). ADR 2026-10-24 amend
// (2026-10-29, Explorer file operations) points 2 and 3.

/** The shortcuts the window's keyboard handler binds (src/main.ts), shown in the palette
 *  rows and tooltips; the native menu shows none (menu.rs: GTK would take the keys). */
export const SHORTCUTS: Readonly<Record<string, string>> = {
  save: "Ctrl+S",
  "open-folder": "Ctrl+O",
  "new-window": "Ctrl+Shift+N",
  "quick-open": "Ctrl+P",
  commands: "Ctrl+Shift+P",
  "open-in-editor": "Ctrl+Shift+E",
  "new-terminal": "Ctrl+Shift+T",
  terminal: "Ctrl+`",
  "nav-back": "Alt+Left",
  "nav-forward": "Alt+Right",
  // The split tree (View → Splits; kit ADR 2026-10-24 amend 2026-11-19 point 4): Ctrl+Alt,
  // clear of Alt+arrows (Back / Forward), Ctrl+digits (the rail), Ctrl+Shift+C / V (terminal
  // copy and paste) and Monaco's Linux keys. paneKey maps the key events to these ids.
  "split-right": "Ctrl+Alt+\\",
  "split-down": "Ctrl+Alt+-",
  "pane-focus-left": "Ctrl+Alt+Left",
  "pane-focus-right": "Ctrl+Alt+Right",
  "pane-focus-up": "Ctrl+Alt+Up",
  "pane-focus-down": "Ctrl+Alt+Down",
  "pane-focus-next": "Ctrl+Alt+PageDown",
  "pane-focus-prev": "Ctrl+Alt+PageUp",
  "tab-to-pane-left": "Ctrl+Alt+Shift+Left",
  "tab-to-pane-right": "Ctrl+Alt+Shift+Right",
  "tab-to-pane-up": "Ctrl+Alt+Shift+Up",
  "tab-to-pane-down": "Ctrl+Alt+Shift+Down",
  "pane-equalize": "Ctrl+Alt+0",
  "pane-zoom": "Ctrl+Alt+Z",
};

const ARROW: Readonly<Record<string, string>> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

/** The split-tree action a Ctrl+Alt key press runs (`code`: KeyboardEvent.code, so the key
 *  position counts, not the layout), or null. Ctrl+Alt+Shift+Up / Down are left to a focused
 *  editor (`inEditor`), where Monaco copies the line up / down. */
export function paneKey(code: string, shift: boolean, inEditor: boolean): string | null {
  const dir = ARROW[code];
  if (dir && !shift) return `pane-focus-${dir}`;
  if (dir) return inEditor && (dir === "up" || dir === "down") ? null : `tab-to-pane-${dir}`;
  if (shift) return null;
  const plain: Record<string, string> = { PageDown: "pane-focus-next", PageUp: "pane-focus-prev", Digit0: "pane-equalize", KeyZ: "pane-zoom", Backslash: "split-right", Minus: "split-down" };
  return plain[code] ?? null;
}

export interface ShortcutRow { keys: string; name: string }

/** Help → Keyboard shortcuts…: one row per key the window's keyboard handler binds. First the
 *  menu actions of SHORTCUTS, in the order of `items` (the menu order, each with its menu
 *  label), then Ctrl+1..9 for the first nine rail items (`rail`: their labels, in rail order)
 *  and Ctrl+W, which are no menu action. */
export function shortcutRows(items: readonly { id: string; label: string }[], rail: readonly string[]): ShortcutRow[] {
  return [
    ...items.flatMap((i) => (SHORTCUTS[i.id] ? [{ keys: SHORTCUTS[i.id], name: i.label.replace(/…$/, "") }] : [])),
    ...rail.slice(0, 9).map((label, n) => ({ keys: `Ctrl+${n + 1}`, name: `Go to ${label}` })),
    { keys: "Ctrl+W", name: "Close the active tab" },
  ];
}

export type SaveAsTarget = { path: string } | { error: string };

/** The absolute path for the name typed in Save as…: relative to the workspace `root`, or
 *  absolute inside it. Refused here with a plain reason (the Rust jail refuses them again):
 *  an empty name, a name ending in `/`, a `.` or `..` segment, a path outside the root, and
 *  the active file itself (that is Save). An existing target is left to `create_text_file`. */
export function saveAsTarget(root: string, from: string, typed: string): SaveAsTarget {
  const name = typed.trim();
  if (!name) return { error: "type a file name" };
  if (name.endsWith("/")) return { error: "that is a folder name; end with a file name" };
  const abs = name.startsWith("/") ? name : `${root}/${name}`;
  const segments = abs.split("/").filter((s) => s.length);
  if (segments.some((s) => s === "." || s === "..")) return { error: "no . or .. segments" };
  const path = `/${segments.join("/")}`;
  if (path !== root && !path.startsWith(`${root}/`)) return { error: `outside the workspace: ${path}` };
  if (path === root) return { error: "type a file name" };
  if (path === from) return { error: "that is the file itself (use Save)" };
  return { path };
}

/** The name Save as… starts with: the file's path inside the workspace, else its base name. */
export function saveAsInitial(root: string, from: string): string {
  return from.startsWith(`${root}/`) ? from.slice(root.length + 1) : (from.split("/").pop() ?? from);
}
