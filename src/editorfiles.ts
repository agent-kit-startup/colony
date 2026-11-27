// Settings → Editor and files (kit ADR 2026-10-24 amend 2026-11-19 point 7): rows for the
// settings.json fields `editor.command`, `editor.terminal` and `fileManager`
// (src-tauri/src/settings.rs `apply_editor`; launch.rs and filemanager.rs read them).
// A command is a string split on whitespace, or a JSON array of strings; empty clears it.
import { api, type CommandSetting, errText, h, type SettingsInfo } from "./api";
import { btn } from "./ui";

/** The input text for a command setting. */
export function commandText(v: CommandSetting | undefined): string {
  if (Array.isArray(v)) return JSON.stringify(v);
  return typeof v === "string" ? v : "";
}

/** The value to save for an input: null (clear), a string, or an array when the text is a
 *  JSON array of strings. Throws on a malformed array. */
export function commandValue(text: string): CommandSetting | null {
  const t = text.trim();
  if (!t) return null;
  if (!t.startsWith("[")) return t;
  const v: unknown = JSON.parse(t);
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x !== "")) throw new Error("a JSON array of non-empty strings");
  return v as string[];
}

const TERMINAL_CHOICES: { value: boolean | null; label: string; title: string }[] = [
  { value: null, label: "Decided per source", title: "$VISUAL or $EDITOR opens in a terminal tab; editor.command runs detached unless it is a known terminal editor (default)" },
  { value: true, label: "Terminal tab", title: "Always run the editor in a Colony terminal tab" },
  { value: false, label: "Detached", title: "Always run the editor as its own window" },
];

export class EditorFiles {
  readonly el = h("div", { id: "settings-editor-files", class: "settings-body" });
  private readonly msg = h("div", { class: "settings-msg dim" });

  constructor(private readonly report: (message: string) => void) {}

  async load() {
    try {
      this.render(await api.settingsGet());
    } catch (e) {
      this.el.replaceChildren(h("div", { class: "settings-msg bad" }, errText(e)));
    }
  }

  private async save(key: "editor.command" | "editor.terminal" | "fileManager", value: unknown, done: string) {
    this.msg.classList.remove("bad");
    try {
      this.render(await api.settingsSetEditor(key, value));
      this.msg.textContent = done;
      this.report(done);
    } catch (e) {
      this.msg.textContent = `${key}: ${errText(e)}`;
      this.msg.classList.add("bad");
    }
  }

  private commandRow(key: "editor.command" | "fileManager", label: string, placeholder: string, current: CommandSetting | undefined): HTMLElement[] {
    const input = h("input", { type: "text", "data-key": key, placeholder, spellcheck: "false", autocomplete: "off", "aria-label": label });
    input.value = commandText(current);
    input.addEventListener("change", () => {
      let value: CommandSetting | null;
      try {
        value = commandValue(input.value);
      } catch (e) {
        this.msg.textContent = `${key}: ${errText(e)}; nothing was saved`;
        this.msg.classList.add("bad");
        return;
      }
      void this.save(key, value, value === null ? `${key}: cleared (saved in settings.json)` : `${key} saved in settings.json`);
    });
    return [h("div", { class: "menu-label" }, label), h("div", { class: "settings-field" }, input)];
  }

  private render(info: SettingsInfo) {
    if (!info.settings) {
      this.el.replaceChildren(h("div", { class: "settings-msg bad" }, info.error ?? "settings.json cannot be read"));
      return;
    }
    const s = info.settings;
    const terminal = s.editor?.terminal;
    const choices = TERMINAL_CHOICES.map((c) => {
      const on = (terminal ?? null) === c.value;
      const b = btn(`${on ? "✓ " : ""}${c.label}`, () => void this.save("editor.terminal", c.value, `editor.terminal: ${c.label} (saved in settings.json)`), { title: c.title, "data-editor-terminal": String(c.value) });
      b.classList.toggle("on", on);
      return b;
    });
    this.el.replaceChildren(
      ...this.commandRow("editor.command", "Editor command", "unset: $VISUAL, $EDITOR, then xdg-open", s.editor?.command),
      h("div", { class: "menu-label" }, "Editor runs in"),
      ...choices,
      ...this.commandRow("fileManager", "Terminal file manager", "unset: yazi, lf, nnn, ranger or broot on PATH", s.fileManager),
      this.msg,
    );
  }
}
