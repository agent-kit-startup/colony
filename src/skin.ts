// Window skins. One design token set (`--mc-*` in styles.css) with two palettes for the
// whole window, Colony chrome, native views and the Mission Control web panel alike:
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
 * The kit panel stores its skin in localStorage `agent-kit:dashboard-skin` as 'cursor'
 * (= Bare Metal) or 'legacy'. The kit will rename 'cursor' to 'bare-metal'; flip this
 * then (parseSkin already accepts both spellings).
 */
const KIT_SPELLS_BARE_METAL = false;

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

function defineMonacoTheme() {
  const bg = token("--mc-bg-primary") || "#141414";
  monaco.editor.defineTheme("colony-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: { "editor.background": bg, "editorGutter.background": bg, "minimap.background": bg },
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
