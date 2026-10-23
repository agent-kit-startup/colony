// Window skins. One design token set (src/tokens.css, named as in the kit dashboard) with
// two palettes for the whole window, Colony chrome, native views and the Mission Control
// web panel alike:
// "Bare Metal" (default, neutral greys) and "Legacy" (the kit panel's original slate
// palette). The choice lives in settings.json (`ui.skin`).
import * as monaco from "monaco-editor";
import { api } from "./api";

export type Skin = "bare-metal" | "legacy";
export const SKINS: { id: Skin; label: string }[] = [
  { id: "bare-metal", label: "Bare Metal" },
  { id: "legacy", label: "Legacy" },
];

/**
 * The kit panel stores its skin in localStorage `agent-kit:dashboard-skin` as 'bare-metal'
 * or 'legacy'. Kits before the rename (agent-kit #1260) spelled Bare Metal 'cursor'; newer
 * kits still read 'cursor' as an alias, and older ones fall back to their default (Bare
 * Metal) on 'bare-metal' (parseSkin accepts both spellings).
 */
const KIT_SPELLS_BARE_METAL = true;

export function kitSkinValue(s: Skin): "cursor" | "bare-metal" | "legacy" {
  if (s === "legacy") return "legacy";
  return KIT_SPELLS_BARE_METAL ? "bare-metal" : "cursor";
}

export function parseSkin(v: unknown): Skin {
  return v === "legacy" ? "legacy" : "bare-metal"; // 'bare-metal', 'cursor', unset, unknown
}

let current: Skin = "bare-metal";
const listeners = new Set<(s: Skin) => void>();

export function skin(): Skin {
  return current;
}

export function onSkin(fn: (s: Skin) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A resolved token value of the current skin (for xterm and Monaco, which need colors). */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** A token as #rrggbb[aa] (Monaco only takes hex colors; tokens may be rgba()). */
export function hexToken(name: string, fallback: string): string {
  const v = token(name);
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v)) return v;
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(v);
  if (!m) return fallback;
  const hx = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${hx(+m[1])}${hx(+m[2])}${hx(+m[3])}${m[4] !== undefined ? hx(+m[4] * 255) : ""}`;
}

/** Monaco on the skin's surfaces (editor, gutter, widgets, selection, scrollbars). */
function defineMonacoTheme() {
  const t = (n: string, f: string) => hexToken(n, f);
  const bg = t("--bg-primary", "#141414");
  monaco.editor.defineTheme("colony-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": bg,
      "editor.foreground": t("--text-primary", "#e4e4e4"),
      "editorGutter.background": bg,
      "minimap.background": bg,
      "editorLineNumber.foreground": t("--text-muted", "#8b8b8b"),
      "editorLineNumber.activeForeground": t("--text-secondary", "#a0a0a0"),
      "editor.lineHighlightBackground": t("--bg-secondary", "#181818"),
      "editor.lineHighlightBorder": t("--bg-secondary", "#181818"),
      "editor.selectionBackground": t("--mc-selection", "#3b82f64d"),
      "editorCursor.foreground": t("--text-primary", "#e4e4e4"),
      "editorIndentGuide.background1": t("--border", "#2a2a2a"),
      "editorIndentGuide.activeBackground1": t("--border-active", "#3a3a3a"),
      "editorWidget.background": t("--bg-secondary", "#181818"),
      "editorWidget.border": t("--border", "#2a2a2a"),
      "editorHoverWidget.background": t("--bg-secondary", "#181818"),
      "editorHoverWidget.border": t("--border", "#2a2a2a"),
      "editorSuggestWidget.background": t("--bg-secondary", "#181818"),
      "editorSuggestWidget.border": t("--border", "#2a2a2a"),
      "editorSuggestWidget.selectedBackground": t("--bg-card-hover", "#242424"),
      "input.background": bg,
      "input.border": t("--border", "#2a2a2a"),
      "focusBorder": t("--blue", "#3b82f6"),
      "scrollbarSlider.background": `${t("--border", "#2a2a2a").slice(0, 7)}cc`,
      "scrollbarSlider.hoverBackground": t("--border-active", "#3a3a3a"),
      "scrollbarSlider.activeBackground": t("--border-active", "#3a3a3a"),
      "diffEditor.insertedTextBackground": t("--green-bg", "#22c55e1f"),
      "diffEditor.removedTextBackground": t("--red-bg", "#ef44441f"),
      "diffEditor.insertedLineBackground": t("--green-bg", "#22c55e1f"),
      "diffEditor.removedLineBackground": t("--red-bg", "#ef44441f"),
    },
  });
  monaco.editor.setTheme("colony-dark");
}

export function applySkin(s: Skin) {
  current = s;
  document.documentElement.dataset.skin = s;
  defineMonacoTheme();
  for (const fn of listeners) fn(s);
}

/** Read the skin from settings.json and apply it. */
export async function loadSkin(): Promise<Skin> {
  const info = await api.settingsGet().catch(() => null);
  const ui = (info?.settings as { ui?: { skin?: string } } | null)?.ui;
  applySkin(parseSkin(ui?.skin));
  return current;
}

/** Apply and remember a skin. */
export async function setSkin(s: Skin) {
  applySkin(s);
  await api.settingsSetSkin(s);
}
