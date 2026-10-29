// Save and Save as… (File menu, the Commands palette, Ctrl+S): the pure parts, so Node runs
// them with its types stripped (scripts/savepath.test.mjs). ADR 2026-10-24 amend
// (2026-10-29, Explorer file operations) points 2 and 3.

/** The shortcuts the window's keyboard handler binds (src/main.ts), shown in the palette
 *  rows and tooltips; the native menu shows none (menu.rs: GTK would take the keys). */
export const SHORTCUTS: Readonly<Record<string, string>> = {
  save: "Ctrl+S",
  "open-folder": "Ctrl+O",
  "quick-open": "Ctrl+P",
  commands: "Ctrl+Shift+P",
  "open-in-editor": "Ctrl+Shift+E",
  "new-terminal": "Ctrl+Shift+T",
  terminal: "Ctrl+`",
};

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
