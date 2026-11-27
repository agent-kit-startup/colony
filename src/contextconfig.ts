// Settings → Kit config, second file (kit ADR 2026-10-24 amend 2026-11-19 point 7, amended
// 2026-11-27: both files): the open folder's `.cursor/context/config.json`, the kit's operator
// settings, as a form below the profile form of kitconfig.ts. src-tauri/src/contextconfig.rs
// owns the file and the rules: its FIELDS mirror the Mission Control Config allowlist leaf by
// leaf (keys, types, ranges, enums, model ids, the roles capability matrix), each row change is
// one targeted text edit of the file, and keys outside the allowlist are never written, so
// there is no raw JSON editor here. "Unset" removes a clearable key (persona modes, roles).
import { api, errText, h, type ContextConfigField, type ContextConfigInfo } from "./api";
import { btn } from "./ui";
import { valueAt } from "./kitconfig";

const UNSET = "\u0000unset";

/** The value a row sends for what the operator picked or typed (null: unset), or why nothing is sent. */
export function rowValue(f: ContextConfigField, raw: string): { value: unknown } | { error: string } {
  if (raw === UNSET) return { value: null };
  if (f.kind === "bool") return { value: raw === "true" };
  if (f.kind === "int") {
    const t = raw.trim();
    if (!/^-?\d+$/.test(t)) return { error: `${f.path} must be an integer ${f.min}..${f.max}` };
    return { value: Number(t) };
  }
  if (f.kind === "model") return { value: f.clearable && !raw.trim() ? null : raw.trim() };
  return { value: raw };
}

export class ContextConfig {
  readonly el = h("div", { id: "settings-context-config", class: "settings-body" });
  private readonly msg = h("div", { class: "settings-msg dim" });
  private info: ContextConfigInfo | null = null;
  private folder: string | null = null;

  constructor(private readonly report: (message: string) => void) {}

  private note(text: string, bad = false) {
    this.msg.textContent = text;
    this.msg.classList.toggle("bad", bad);
  }

  /** Re-read the file (every time Settings shows; `folder`: the open folder's root, null for none). */
  async load(folder: string | null) {
    this.folder = folder;
    this.note("");
    if (!folder) {
      this.info = null;
      this.el.replaceChildren(h("div", { class: "settings-msg dim" }, "Open a folder to edit its .cursor/context/config.json."));
      return;
    }
    try {
      this.info = await api.contextConfigRead();
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
    const path = h("div", { class: "settings-msg dim", title: info.path }, ".cursor/context/config.json");
    const actions = h("div", { class: "settings-actions" }, btn("Reload", () => void this.load(this.folder)));
    if (!info.canCreate) {
      this.el.replaceChildren(path, h("div", { class: "settings-msg dim" }, "No .cursor folder here: not an Agent Kit folder."), this.msg);
      return;
    }
    let doc: unknown = {};
    if (info.text !== null) {
      try {
        doc = JSON.parse(info.text);
      } catch (e) {
        this.el.replaceChildren(path, h("div", { class: "settings-msg bad" }, `The file is not valid JSON (${errText(e)}). Fix it in an editor; Colony writes nothing to it until then.`), actions, this.msg);
        return;
      }
    }
    const rows: HTMLElement[] = [];
    let group = "";
    for (const f of info.fields) {
      if (f.group !== group) {
        group = f.group;
        rows.push(h("div", { class: "settings-subtitle" }, group));
      }
      rows.push(...this.fieldRow(f, valueAt(doc, f.path)));
    }
    this.el.replaceChildren(
      path,
      ...rows,
      h("div", { class: "settings-msg dim" }, info.exists ? "The kit's operator settings, checked as Mission Control checks them." : "No file yet: the first change creates it."),
      actions,
      this.msg,
    );
  }

  private fieldRow(f: ContextConfigField, value: unknown): HTMLElement[] {
    const label = h("div", { class: "menu-label", title: f.path }, f.label);
    let input: HTMLInputElement | HTMLSelectElement;
    if (f.kind === "bool" || f.kind === "choice") {
      const options = f.kind === "bool" ? ["true", "false"] : f.options;
      const text = (o: string) => (f.kind === "bool" ? (o === "true" ? "On" : "Off") : o);
      const current = value === undefined ? UNSET : String(value);
      const known = options.includes(current);
      const sel = h(
        "select",
        { "aria-label": f.label },
        ...(f.clearable || value === undefined ? [h("option", { value: UNSET, ...(f.clearable ? {} : { disabled: "" }) }, f.clearable ? "Unset" : "Not set")] : []),
        ...(known || current === UNSET ? [] : [h("option", { value: current, disabled: "" }, `${current} (unknown)`)]),
        ...options.map((o) => h("option", { value: o }, text(o))),
      );
      sel.value = current;
      input = sel;
    } else {
      const inp = h("input", { type: f.kind === "int" ? "number" : "text", spellcheck: "false", autocomplete: "off", "aria-label": f.label, ...(f.kind === "int" ? { min: String(f.min), max: String(f.max), step: "1" } : {}), placeholder: value === undefined ? "Not set" : "" });
      inp.value = value === undefined || value === null ? "" : String(value);
      input = inp;
    }
    input.dataset.path = f.path;
    input.addEventListener("change", () => {
      const picked = rowValue(f, input.value);
      if ("error" in picked) return this.note(picked.error, true);
      void this.set(f, picked.value);
    });
    return [label, h("div", { class: "settings-field" }, input)];
  }

  private async set(f: ContextConfigField, value: unknown) {
    try {
      this.info = await api.contextConfigSet(f.path, value);
      this.render();
      const text = `Kit settings: ${f.path} ${value === null ? "unset" : "saved"}`;
      this.note(text);
      this.report(text);
    } catch (e) {
      this.render();
      this.note(`${f.path}: ${errText(e)}`, true);
    }
  }
}
