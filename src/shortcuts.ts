// Keyboard shortcuts panel (Help → Keyboard shortcuts…): the keys the window's keyboard
// handler binds (src/main.ts), listed from the same table the palette rows read
// (src/savepath.ts SHORTCUTS). The native menu shows no keys (menu.rs: GTK would take them).
import { h } from "./api";
import type { ShortcutRow } from "./savepath";
import { btn } from "./ui";

let overlay: HTMLElement | null = null;

export function closeShortcutsPanel() {
  overlay?.remove();
  overlay = null;
  window.removeEventListener("keydown", esc);
}

function esc(ev: KeyboardEvent) {
  if (ev.key === "Escape") closeShortcutsPanel();
}

export function openShortcutsPanel(rows: readonly ShortcutRow[]) {
  closeShortcutsPanel();
  const box = h(
    "div",
    { class: "engine-box", role: "dialog", "aria-label": "Keyboard shortcuts" },
    h("div", { class: "card-title" }, "Keyboard shortcuts", h("span", { class: "spacer" }), btn("✕", closeShortcutsPanel, { class: "icon", title: "Close" })),
    ...rows.map((r) => h("div", { class: "engine-row shortcut-row" }, h("kbd", { class: "palette-key" }, r.keys), h("span", {}, r.name))),
    h("div", { class: "engine-msg dim" }, "Inside a terminal, the editor or a text field, Alt+Left and Alt+Right move the cursor instead. With a terminal focused, Ctrl+O, Ctrl+P, Ctrl+W and Ctrl+1 to Ctrl+9 go to the terminal."),
  );
  overlay = h("div", { id: "shortcuts-panel" }, box);
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) closeShortcutsPanel();
  });
  window.addEventListener("keydown", esc);
  document.body.append(overlay);
}
