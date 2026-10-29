// Monaco editor with one model per open file.
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { api, focusPolicy } from "./api";
import { monoFont, onSkin } from "./skin";

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

interface Doc {
  model: monaco.editor.ITextModel;
  saved: number;
  view: monaco.editor.ICodeEditorViewState | null;
}

export class Editors {
  readonly editor: monaco.editor.IStandaloneCodeEditor;
  private docs = new Map<string, Doc>();
  active: string | null = null;

  constructor(el: HTMLElement, private onChange: () => void) {
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
    // The Omarchy skin follows the system monospace font.
    onSkin(() => this.editor.updateOptions({ fontFamily: monoFont() }));
    // No Ctrl+S command here: the window's capture-phase keyboard handler (main.ts) is the one
    // save path (File → Save, the palette and Ctrl+S), so a save never fails silently.
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

  async open(path: string) {
    if (!this.docs.has(path)) {
      const text = await api.readTextFile(path);
      const model = monaco.editor.createModel(text, undefined, monaco.Uri.file(path));
      const doc: Doc = { model, saved: model.getAlternativeVersionId(), view: null };
      model.onDidChangeContent(() => this.onChange());
      this.docs.set(path, doc);
    }
    this.activate(path);
  }

  activate(path: string) {
    const doc = this.docs.get(path);
    if (!doc) return;
    if (this.active && this.active !== path) {
      const cur = this.docs.get(this.active);
      if (cur) cur.view = this.editor.saveViewState();
    }
    this.active = path;
    this.editor.setModel(doc.model);
    if (doc.view) this.editor.restoreViewState(doc.view);
    if (focusPolicy.enabled) this.editor.focus();
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

  close(path: string) {
    const doc = this.docs.get(path);
    if (!doc) return;
    doc.model.dispose();
    this.docs.delete(path);
    if (this.active === path) {
      this.active = null;
      this.editor.setModel(null);
    }
    this.onChange();
  }

  closeAll() {
    for (const p of this.paths()) this.close(p);
  }

  layout() {
    this.editor.layout();
  }
}
