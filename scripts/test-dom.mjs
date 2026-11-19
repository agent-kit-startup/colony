// Render harness for scripts/*.test.mjs that build Colony views with h() (not a test file:
// `pnpm test` runs scripts/*.test.mjs only). It loads src/*.ts through the TypeScript
// compiler (Node's type stripping cannot read parameter properties), skips the style sheets
// views import for Vite, stubs the Tauri modules (`invoke` answers through `setInvoke`), and installs a small DOM whose markup
// sinks (innerHTML, outerHTML, insertAdjacentHTML, srcdoc, and href / src / action / on*
// set as a property or an attribute) record every write in `sinks` instead of parsing it.
import { createRequire, registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const SRC = new URL("../src/", import.meta.url).href;
const TAURI_STUB = [
  "export const invoke = (cmd, args) => globalThis.__colonyInvoke(cmd, args);",
  "export class Channel { onmessage = null; }",
  "export const open = async () => null;",
  "export const openUrl = async () => {};",
  "export const getCurrentWindow = () => ({ setTitle: async () => {}, isFocused: async () => true });",
  "export const onAction = async () => ({ unregister() {} });",
  "export const sendNotification = () => {};",
].join("\n");

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@tauri-apps/")) return { url: `colony-test:${spec}`, shortCircuit: true };
    if (spec.startsWith(".") && !/\.[cm]?[jt]s$/.test(spec) && ctx.parentURL?.endsWith(".ts")) {
      const u = new URL(`${spec}.ts`, ctx.parentURL);
      if (existsSync(fileURLToPath(u))) return next(u.href, ctx);
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url.startsWith("colony-test:@tauri-apps/")) return { format: "module", source: TAURI_STUB, shortCircuit: true };
    // Style sheets and other assets a view imports for Vite: nothing to evaluate here.
    if (url.startsWith(SRC) && /\.(css|svg|png|json\?raw)$/.test(url)) return { format: "module", source: 'export default "";', shortCircuit: true };
    if (url.startsWith(SRC) && url.endsWith(".ts")) {
      const file = fileURLToPath(url);
      const out = ts.transpileModule(readFileSync(file, "utf8"), {
        fileName: file,
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, useDefineForClassFields: true },
      });
      return { format: "module", source: out.outputText, shortCircuit: true };
    }
    return next(url, ctx);
  },
});

let invokeHandler = async (cmd) => {
  throw new Error(`no invoke handler for ${cmd}`);
};
/** Answer `invoke(cmd, args)` calls (the Tauri commands) with `fn`. */
export function setInvoke(fn) {
  invokeHandler = fn;
}
globalThis.__colonyInvoke = (cmd, args) => invokeHandler(cmd, args);

/** Every markup or URL sink written while rendering: { tag, sink, value }. */
export const sinks = [];
const URL_ATTRS = new Set(["href", "src", "srcdoc", "action", "formaction", "xlink:href", "data", "poster"]);
const sink = (el, name, value) => sinks.push({ tag: el.tagName, sink: name, value: String(value) });

class FakeNode {
  constructor() {
    this.childNodes = [];
    this.parentNode = null;
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  append(...xs) {
    for (const x of xs) {
      const n = typeof x === "string" ? new FakeText(x) : x;
      if (n.nodeType === 11) {
        for (const c of [...n.childNodes]) this.append(c);
        continue;
      }
      n.parentNode?.removeChild?.(n);
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }
  appendChild(n) {
    this.append(n);
    return n;
  }
  prepend(...xs) {
    const rest = this.childNodes;
    this.childNodes = [];
    this.append(...xs);
    this.childNodes.push(...rest);
  }
  insertBefore(n, ref) {
    this.append(n);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i >= 0) this.childNodes.splice(i, 0, this.childNodes.pop());
    return n;
  }
  removeChild(n) {
    this.childNodes = this.childNodes.filter((c) => c !== n);
    n.parentNode = null;
    return n;
  }
  replaceChildren(...xs) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...xs);
  }
  replaceWith(...xs) {
    const p = this.parentNode;
    if (!p) return;
    const i = p.childNodes.indexOf(this);
    p.removeChild(this);
    const tmp = new FakeElement("#tmp");
    tmp.append(...xs);
    for (const c of tmp.childNodes) c.parentNode = p;
    p.childNodes.splice(i, 0, ...tmp.childNodes);
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this.replaceChildren(String(v ?? ""));
  }
}

class FakeText extends FakeNode {
  constructor(data) {
    super();
    this.nodeType = 3;
    this.data = String(data);
  }
  get textContent() {
    return this.data;
  }
  set textContent(v) {
    this.data = String(v);
  }
}

class FakeClassList {
  constructor(el) {
    this.el = el;
  }
  get list() {
    return this.el.className.split(/\s+/).filter(Boolean);
  }
  add(...cs) {
    this.el.className = [...new Set([...this.list, ...cs])].join(" ");
  }
  remove(...cs) {
    this.el.className = this.list.filter((c) => !cs.includes(c)).join(" ");
  }
  toggle(c, force) {
    const on = force ?? !this.contains(c);
    on ? this.add(c) : this.remove(c);
    return on;
  }
  contains(c) {
    return this.list.includes(c);
  }
}

export class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.nodeType = tag === "#fragment" ? 11 : 1;
    this.tagName = tag.toUpperCase();
    this.attributes = {};
    this.listeners = {};
    this.className = "";
    this.classList = new FakeClassList(this);
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.checked = false;
    this.title = "";
  }
  setAttribute(k, v) {
    const name = String(k).toLowerCase();
    if (URL_ATTRS.has(name) || name.startsWith("on")) sink(this, `attr:${name}`, v);
    if (name === "class") this.className = String(v);
    else if (name === "hidden") this.hidden = true;
    else if (name === "disabled") this.disabled = true;
    else if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
    this.attributes[name] = String(v);
  }
  getAttribute(k) {
    return this.attributes[String(k).toLowerCase()] ?? null;
  }
  hasAttribute(k) {
    return String(k).toLowerCase() in this.attributes;
  }
  removeAttribute(k) {
    delete this.attributes[String(k).toLowerCase()];
  }
  addEventListener(t, f) {
    (this.listeners[t] ??= []).push(f);
  }
  removeEventListener(t, f) {
    this.listeners[t] = (this.listeners[t] ?? []).filter((x) => x !== f);
  }
  dispatchEvent(ev) {
    for (const f of this.listeners[ev.type] ?? []) f(ev);
    return true;
  }
  click() {
    this.dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {} });
  }
  focus() {}
  blur() {}
  scrollIntoView() {}
  getBoundingClientRect() {
    return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  closest() {
    return null;
  }
  get content() {
    return this;
  }
  set innerHTML(v) {
    sink(this, "innerHTML", v);
    // icons.ts parses its static SVG through a <template>: give it an element to return.
    if (this.tagName === "TEMPLATE") this.replaceChildren(new FakeElement("svg"));
  }
  get innerHTML() {
    return "";
  }
  set outerHTML(v) {
    sink(this, "outerHTML", v);
  }
  insertAdjacentHTML(_where, v) {
    sink(this, "insertAdjacentHTML", v);
  }
}
for (const prop of ["href", "src", "srcdoc", "action", "formAction"]) {
  Object.defineProperty(FakeElement.prototype, prop, {
    set(v) {
      sink(this, prop, v);
    },
    get() {
      return "";
    },
  });
}

const body = new FakeElement("body");
globalThis.document = {
  createElement: (t) => new FakeElement(t),
  createElementNS: (_ns, t) => new FakeElement(t),
  createTextNode: (d) => new FakeText(d),
  createDocumentFragment: () => new FakeElement("#fragment"),
  addEventListener() {},
  removeEventListener() {},
  body,
  documentElement: new FakeElement("html"),
  activeElement: body,
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  hasFocus: () => true,
  write: (v) => sink(body, "document.write", v),
};
globalThis.window ??= globalThis;
// Defined, not read: Node's own localStorage getter warns when it has no backing file.
Object.defineProperty(globalThis, "localStorage", { value: { getItem: () => null, setItem() {}, removeItem() {} }, configurable: true, writable: true });
globalThis.performance ??= { now: () => 0 };
globalThis.requestAnimationFrame ??= (f) => setTimeout(f, 0);
globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => "" });

/**
 * The one innerHTML the views may write: src/icons.ts's static 16px SVG, parsed through a
 * <template> (a class name from the code, the shared shell, path data from its own table).
 */
export const STATIC_ICON = /^<svg class="[a-z][a-z -]*" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="2" aria-hidden="true">(<(path|rect|circle|line|polyline|polygon|ellipse)( [a-z-]+="[-0-9A-Za-z. ,]*")+\/>)*<\/svg>$/;

/** The sinks written so far, less the static icon markup of src/icons.ts. */
export function liveSinks() {
  return sinks.filter((x) => !(x.tag === "TEMPLATE" && x.sink === "innerHTML" && STATIC_ICON.test(x.value)));
}

/** Every element under `root`, depth first. */
export function elements(root) {
  const out = [];
  const walk = (n) => {
    if (n.nodeType === 1) out.push(n);
    for (const c of n.childNodes) walk(c);
  };
  walk(root);
  return out;
}
