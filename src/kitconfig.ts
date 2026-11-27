// Settings → Kit config (kit ADR 2026-10-24 amend 2026-11-19 point 7): the open folder's
// `.cursor/agent-kit.config.json` as a form plus a raw JSON editor, beside Colony's own
// settings.json. src-tauri/src/kitconfig.rs owns the file: the one fixed path inside the open
// folder, the form's fields (FIELDS: the values the kit reads back as confirmed on a rescan;
// see its module comment for the source), a form edit as a targeted text patch (every other
// byte of the file stays), and the raw save written verbatim only once it parses.
// Invalid JSON is never written: the raw editor parses here first and Rust parses again.
// A missing file is created only from the raw editor, and only inside an existing `.cursor/`.
import { api, errText, h, type KitConfigField, type KitConfigInfo } from "./api";
import { btn } from "./ui";

/** The value at a dotted path of a parsed object (undefined when a key is missing). */
export function valueAt(doc: unknown, path: string): unknown {
  let v: unknown = doc;
  for (const k of path.split(".")) {
    if (!v || typeof v !== "object" || Array.isArray(v) || !Object.prototype.hasOwnProperty.call(v, k)) return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

/** Parse the raw editor's text: the object, or an error saying why nothing is written. */
export function parseRaw(text: string): { ok: true } | { ok: false; error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Invalid JSON (${errText(e)}); nothing was written` };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "The kit config must be a JSON object; nothing was written" };
  return { ok: true };
}

const NEW_FILE = "{\n}\n";

export class KitConfig {
  readonly el = h("div", { id: "settings-kit-config", class: "settings-body" });
  private readonly msg = h("div", { class: "settings-msg dim" });
  private info: KitConfigInfo | null = null;
  /** The raw editor's starting text while it is open (null: closed). */
  private raw: string | null = null;
  /** The folder the shown file belongs to. */
  private folder: string | null = null;

  constructor(private readonly report: (message: string) => void) {}

  private note(text: string, bad = false) {
    this.msg.textContent = text;
    this.msg.classList.toggle("bad", bad);
  }

  /** Re-read the file (every time Settings shows; `folder`: the open folder's root, null for
   *  none). An open raw editor on the same folder is kept: Settings shown again (the gear,
   *  Back and forth) never drops what is being typed. */
  async load(folder: string | null) {
    if (this.raw !== null && folder !== null && folder === this.folder) return;
    this.folder = folder;
    this.raw = null;
    this.note("");
    if (!folder) {
      this.info = null;
      this.el.replaceChildren(h("div", { class: "settings-msg dim" }, "Open a folder to edit its .cursor/agent-kit.config.json."));
      return;
    }
    try {
      this.info = await api.kitConfigRead();
    } catch (e) {
      this.info = null;
      this.el.replaceChildren(h("div", { class: "settings-msg bad" }, errText(e)));
      return;
    }
    this.render();
  }

  private render() {
    const info = this.info;
    if (!info) return;
    if (this.raw !== null) return this.renderRaw(info);
    const path = h("div", { class: "settings-msg dim", title: info.path }, ".cursor/agent-kit.config.json");
    if (!info.exists || info.text === null) {
      this.el.replaceChildren(
        path,
        h("div", { class: "settings-msg dim" }, info.canCreate ? "This folder has no kit config file yet." : "No .cursor folder here: not an Agent Kit folder."),
        ...(info.canCreate ? [h("div", { class: "settings-actions" }, btn("Create in raw JSON", () => this.openRaw(NEW_FILE)))] : []),
        this.msg,
      );
      return;
    }
    let doc: unknown;
    let parseError = "";
    try {
      doc = JSON.parse(info.text);
    } catch (e) {
      parseError = errText(e);
    }
    const actions = h("div", { class: "settings-actions" }, btn("Raw JSON", () => this.openRaw(info.text ?? "")), btn("Reload", () => void this.load(this.folder)));
    if (parseError) {
      this.el.replaceChildren(path, h("div", { class: "settings-msg bad" }, `The file is not valid JSON (${parseError}). Fix it in the raw JSON.`), actions, this.msg);
      return;
    }
    this.el.replaceChildren(
      path,
      ...info.fields.flatMap((f) => this.fieldRow(f, valueAt(doc, f.path))),
      h("div", { class: "settings-msg dim" }, "The values the kit keeps on a rescan. Other keys: Raw JSON."),
      actions,
      this.msg,
    );
  }

  private fieldRow(f: KitConfigField, value: unknown): HTMLElement[] {
    const label = h("div", { class: "menu-label", title: f.path }, f.label);
    const fixed = (text: string) => [label, h("div", { class: "settings-msg dim" }, text)];
    if (value === undefined) return fixed("Not set. Add it in the raw JSON.");
    let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    let read: () => unknown;
    if (f.kind === "lines") {
      if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) return fixed("Not a list of strings. Edit it in the raw JSON.");
      const ta = h("textarea", { rows: String(Math.max(2, value.length + 1)), spellcheck: "false", "aria-label": `${f.label}, one per line` });
      ta.value = value.join("\n");
      input = ta;
      read = () => ta.value.split("\n").map((l) => l.trim()).filter(Boolean);
    } else if (typeof value !== "string") {
      return fixed("Not a string. Edit it in the raw JSON.");
    } else if (f.kind === "choice") {
      const sel = h("select", { "aria-label": f.label }, ...(f.options.includes(value) ? [] : [h("option", { value }, `${value} (unknown)`)]), ...f.options.map((o) => h("option", { value: o }, o)));
      sel.value = value;
      input = sel;
      read = () => sel.value;
    } else {
      const inp = h("input", { type: "text", spellcheck: "false", autocomplete: "off", "aria-label": f.label });
      inp.value = value;
      input = inp;
      read = () => inp.value;
    }
    input.dataset.path = f.path;
    input.addEventListener("change", () => void this.set(f, read()));
    return [label, h("div", { class: "settings-field" }, input)];
  }

  private async set(f: KitConfigField, value: unknown) {
    try {
      this.info = await api.kitConfigSet(f.path, value);
      this.render();
      const text = `Kit config: ${f.path} saved`;
      this.note(text);
      this.report(text);
    } catch (e) {
      this.note(`${f.path}: ${errText(e)}`, true);
    }
  }

  private openRaw(text: string) {
    this.raw = text;
    this.note("");
    this.render();
  }

  private renderRaw(info: KitConfigInfo) {
    const ta = h("textarea", { class: "settings-raw", rows: "18", spellcheck: "false", "aria-label": "agent-kit.config.json" });
    ta.value = this.raw ?? "";
    const save = async () => {
      const checked = parseRaw(ta.value);
      if (!checked.ok) return this.note(checked.error, true);
      try {
        this.info = await api.kitConfigWriteRaw(ta.value, info.text);
        this.raw = null;
        this.render();
        const text = "Kit config saved";
        this.note(text);
        this.report(text);
      } catch (e) {
        this.note(errText(e), true);
      }
    };
    this.el.replaceChildren(
      h("div", { class: "settings-msg dim", title: info.path }, ".cursor/agent-kit.config.json (raw JSON)"),
      ta,
      h(
        "div",
        { class: "settings-actions" },
        btn("Save", () => void save()),
        btn("Cancel", () => {
          this.raw = null;
          this.note("");
          this.render();
        }),
      ),
      this.msg,
    );
  }
}
