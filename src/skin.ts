// Window skins. One design token set (src/tokens.css, named as in the kit dashboard) with
// palettes for the whole window, Colony chrome and native views alike:
// "Bare Metal" (default, neutral greys), "Legacy" (the kit panel's original slate
// palette) and, on Omarchy only, "Omarchy": the live system theme and monospace font
// (src-tauri/src/omarchy.rs maps colors.toml onto the same tokens and reports every
// theme or font switch). The choice lives in settings.json (`ui.skin`); with none saved,
// Omarchy picks "Omarchy".
import * as monaco from "monaco-editor";
import { api, Channel, type OmarchyTheme } from "./api";

export type { OmarchyTheme };

export type Skin = "bare-metal" | "legacy" | "omarchy";
export const SKINS: { id: Skin; label: string }[] = [
  { id: "bare-metal", label: "Bare Metal" },
  { id: "legacy", label: "Legacy" },
  { id: "omarchy", label: "Omarchy (system theme)" },
];

let omarchy: OmarchyTheme | null = null;
/** Omarchy is installed and its theme is readable. */
export function omarchyDetected(): boolean {
  return omarchy !== null;
}
export function omarchyTheme(): OmarchyTheme | null {
  return omarchy;
}

/** A saved skin; unset or unknown is the platform default (Omarchy there, else Bare Metal). */
export function parseSkin(v: unknown, onOmarchy = omarchyDetected()): Skin {
  if (v === "legacy") return "legacy";
  if (v === "omarchy" || v === undefined || v === null || v === "") return onOmarchy ? "omarchy" : "bare-metal";
  return "bare-metal"; // 'bare-metal', 'cursor', unknown
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
function defineMonacoTheme(light: boolean) {
  const t = (n: string, f: string) => hexToken(n, f);
  const bg = t("--bg-primary", "#141414");
  monaco.editor.defineTheme("colony", {
    base: light ? "vs" : "vs-dark",
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
  monaco.editor.setTheme("colony");
}

/** Inline token values the Omarchy skin set on the root (removed for the other skins). */
let inlineTokens: string[] = [];
const DEFAULT_MONO = () => getComputedStyle(document.documentElement).getPropertyValue("--mc-font-mono").trim();

export function applySkin(s: Skin) {
  if (s === "omarchy" && !omarchy) s = "bare-metal";
  current = s;
  const root = document.documentElement;
  for (const k of inlineTokens) root.style.removeProperty(k);
  inlineTokens = [];
  let light = false;
  if (s === "omarchy" && omarchy) {
    const base = DEFAULT_MONO();
    for (const [k, v] of Object.entries(omarchy.tokens)) {
      if (!k.startsWith("--")) continue;
      root.style.setProperty(k, v);
      inlineTokens.push(k);
    }
    if (omarchy.font) {
      root.style.setProperty("--mc-font-mono", `"${omarchy.font}", ${base}`);
      inlineTokens.push("--mc-font-mono");
    }
    light = omarchy.mode === "light";
  }
  root.dataset.skin = s;
  root.dataset.mode = light ? "light" : "dark";
  defineMonacoTheme(light);
  for (const fn of listeners) fn(s);
}

/** The monospace stack of the current skin (Omarchy's font first on that skin). */
export function monoFont(): string {
  return token("--mc-font-mono");
}

/** The terminal font: Omarchy's font on that skin, then the Nerd Font prompt themes need. */
export function termFont(): string {
  const sys = current === "omarchy" && omarchy?.font ? `"${omarchy.font}", ` : "";
  return `${sys}"JetBrainsMono Nerd Font", "JetBrains Mono", ${monoFont()}`;
}

/** Follow Omarchy: the first report decides detection, later ones re-apply the skin live. */
function watchOmarchy(): Promise<void> {
  return new Promise((resolve) => {
    let first = true;
    const ch = new Channel<OmarchyTheme | null>();
    ch.onmessage = (t) => {
      if (t || first) omarchy = t;
      if (first) {
        first = false;
        return resolve();
      }
      // Only a readable theme comes after the first report (omarchy.rs skips the moment
      // theme-set has removed the old directory and not yet moved the new one in).
      if (t && current === "omarchy") applySkin("omarchy");
    };
    api.omarchySubscribe(ch).catch(() => resolve());
    // Never hold the window on a slow first report.
    setTimeout(resolve, 1500);
  });
}

let watching: Promise<void> | null = null;

/** Read the skin from settings.json and apply it. */
export async function loadSkin(): Promise<Skin> {
  watching ??= watchOmarchy();
  const [info] = await Promise.all([api.settingsGet().catch(() => null), watching]);
  const ui = (info?.settings as { ui?: { skin?: string } } | null)?.ui;
  applySkin(parseSkin(ui?.skin));
  return current;
}

/** Apply and remember a skin. */
export async function setSkin(s: Skin) {
  applySkin(s);
  await api.settingsSetSkin(s);
}
