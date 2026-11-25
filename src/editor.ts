// Monaco: one model per open file, one editor view per pane of the centre split tree.
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { api, focusPolicy } from "./api";
import { openInBrowser } from "./browser";
import { monoFont, onSkin } from "./skin";
import { editorLink } from "./weblink";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

// Boot placeholder until src/skin.ts defines "colony" from the skin tokens.
monaco.editor.defineTheme("colony", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: { "editor.background": "#141414", "editorGutter.background": "#141414" },
});

/** Where the editor reports a link it opened or refused (main.ts points it at the status bar). */
export const editorStatus = { show: (_msg: string): void => {} };

// Links in the editor (kit ADR 2026-10-15, amend 2026-11-07): Monaco underlines http(s)
// addresses and, as in VS Code, opens one on Ctrl+click (Cmd+click on macOS; a plain click
// places the cursor). Its default opener ends in window.open(), which the webview drops, so
// the address goes through ./browser.ts like the terminal's and the doc preview's. One
// opener for every editor (Monaco keeps it in its global services); ./weblink.ts editorLink
// decides.
monaco.editor.registerLinkOpener({
  open(uri) {
    // toString(true): the address as written (toString() would encode `?q=1` as `?q%3D1`).
    const act = editorLink(uri.toString(true));
    if (!act) return false;
    if ("open" in act) void openInBrowser(act.open).then((m) => editorStatus.show(m));
    else editorStatus.show(act.refuse);
    return true;
  },
});

interface Doc {
  model: monaco.editor.ITextModel;
  saved: number;
}

/** One Monaco editor in one pane of the centre split tree (kit ADR 2026-10-24 amend
 *  2026-11-19): it shows one file at a time and keeps its own view state (cursor, scroll,
 *  folds) per file. A file open in two panes is one model in two views. */
export class EditorView {
  readonly editor: monaco.editor.IStandaloneCodeEditor;
  /** The file this view shows (null: none). */
  active: string | null = null;
  readonly states = new Map<string, monaco.editor.ICodeEditorViewState | null>();

  constructor(readonly el: HTMLElement) {
    this.editor = monaco.editor.create(el, {
      model: null,
      theme: "colony",
      automaticLayout: true,
      fontFamily: monoFont(),
      fontSize: 13,
      minimap: { enabled: true },
      smoothScrolling: true,
      renderWhitespace: "selection",
    });
    // No Ctrl+S command here: the window's capture-phase keyboard handler (main.ts) is the one
    // save path (File → Save, the palette and Ctrl+S), so a save never fails silently. Never
    // editor.addCommand either: Monaco keeps one keybinding service for every editor, so a
    // command added to two editors runs the last one's handler in both (plan t0 spike);
    // per-editor keys use addAction.
  }

  /** Remember where this view stood in the file it shows. */
  saveState() {
    if (this.active) this.states.set(this.active, this.editor.saveViewState());
  }
}

/** The open files (one model each) and the editor views of the panes that show them. */
export class Editors {
  private docs = new Map<string, Doc>();
  private views = new Set<EditorView>();
  /** The view of the focused pane (main.ts sets it): `editor`, `active` and the one-argument
   *  calls act on it. */
  current: EditorView | null = null;

  constructor(private onChange: () => void) {
    // The Omarchy skin follows the system monospace font.
    onSkin(() => {
      for (const v of this.views) v.editor.updateOptions({ fontFamily: monoFont() });
    });
  }

  /** A new editor view in `el` (a new pane). */
  createView(el: HTMLElement): EditorView {
    const v = new EditorView(el);
    this.views.add(v);
    this.current ??= v;
    return v;
  }

  /** A pane went away: its editor goes with it (the models stay while another pane or tab
   *  holds them). */
  disposeView(v: EditorView) {
    v.editor.dispose();
    this.views.delete(v);
    if (this.current === v) this.current = this.views.values().next().value ?? null;
  }

  /** The focused pane's editor. */
  get editor(): monaco.editor.IStandaloneCodeEditor {
    const v = this.current ?? this.views.values().next().value;
    if (!v) throw new Error("no editor view");
    return v.editor;
  }

  /** The file the focused pane's editor shows. */
  get active(): string | null {
    return this.current?.active ?? null;
  }

  paths(): string[] {
    return [...this.docs.keys()];
  }

  /** Changes with every edit of the file's model, and with a new model for the same path
   *  ("": not open). */
  version(path: string): string {
    const m = this.docs.get(path)?.model;
    return m ? `${m.id}:${m.getAlternativeVersionId()}` : "";
  }

  /** The file's current text in its model (unsaved edits included). */
  text(path: string): string | null {
    return this.docs.get(path)?.model.getValue() ?? null;
  }

  isDirty(path: string): boolean {
    const d = this.docs.get(path);
    return !!d && d.model.getAlternativeVersionId() !== d.saved;
  }

  /** Load `path` into a model (once) and show it in `view` (the focused pane's by default). */
  async open(path: string, view = this.current) {
    if (!this.docs.has(path)) {
      const text = await api.readTextFile(path);
      if (this.docs.has(path)) return this.activate(path, view);
      const model = monaco.editor.createModel(text, undefined, monaco.Uri.file(path));
      const doc: Doc = { model, saved: model.getAlternativeVersionId() };
      model.onDidChangeContent(() => this.onChange());
      this.docs.set(path, doc);
    }
    this.activate(path, view);
  }

  /** Show `path` in `view`, where that view last stood in it. */
  activate(path: string, view = this.current) {
    const doc = this.docs.get(path);
    if (!doc || !view) return;
    if (view.active !== path) {
      view.saveState();
      view.active = path;
      view.editor.setModel(doc.model);
      const st = view.states.get(path);
      if (st) view.editor.restoreViewState(st);
    }
    if (focusPolicy.enabled) view.editor.focus();
    this.onChange();
  }

  async save(path = this.active): Promise<string | null> {
    if (!path) return null;
    const doc = this.docs.get(path);
    if (!doc) return null;
    await api.writeTextFile(path, doc.model.getValue());
    doc.saved = doc.model.getAlternativeVersionId();
    this.onChange();
    return path;
  }

  /** `view` stops showing `path` (its tab closed in that pane; the model stays). */
  release(path: string, view: EditorView) {
    view.states.delete(path);
    if (view.active === path) {
      view.active = null;
      view.editor.setModel(null);
    }
  }

  /** Close the file everywhere: its model goes, and every view that showed it is empty. */
  close(path: string) {
    const doc = this.docs.get(path);
    if (!doc) return;
    for (const v of this.views) this.release(path, v);
    doc.model.dispose();
    this.docs.delete(path);
    this.onChange();
  }

  closeAll() {
    for (const p of this.paths()) this.close(p);
  }

  layout() {
    for (const v of this.views) v.editor.layout();
  }
}
