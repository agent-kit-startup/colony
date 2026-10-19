// Colony window: Mission Control home, explorer, editor tabs, terminals, agent and git panels.
import { ask, open } from "@tauri-apps/plugin-dialog";
import { AgentPanel } from "./agent";
import { api, errText, focusPolicy, h, type StartupInfo, type WorkspaceInfo } from "./api";
import { Editors } from "./editor";
import { FileTree } from "./filetree";
import { GitPanel } from "./git";
import { decide, type McRecord } from "./mcactions";
import { InboxPanel } from "./inbox";
import { ReviewView } from "./review";
import { type Run, runs } from "./runs";
import "./styles.css";
import { Terminals } from "./terminal";

const RECENTS_KEY = "colony.recentWorkspaces";
const HOME_TAB = "__home__";
const REVIEW_TAB = "__review__";
const isFileTab = (id: string) => id !== HOME_TAB && id !== REVIEW_TAB;

document.getElementById("app")!.innerHTML = `
<div id="shell" class="no-right">
  <header id="top">
    <span class="brand"><img src="./colony-icon.svg" alt="" width="18" height="18" /> Colony</span>
    <button id="btn-open" title="Open folder (Ctrl+O)">Open folder</button>
    <span id="ws-name" class="dim">No folder open</span>
    <span class="spacer"></span>
    <button id="btn-quick" title="Quick open (Ctrl+P)">Go to file</button>
    <button id="btn-editor" title="Open the current file (or the folder, from Mission Control) in your editor (Ctrl+Shift+E). Right-click a file in the Explorer for that file.">Open in editor</button>
    <button id="btn-term" class="toggle on" title="Terminal (Ctrl+\`)">Terminal</button>
    <button id="btn-agent" class="toggle" title="Agent panel">Agent</button>
    <button id="btn-inbox" class="toggle" title="Inbox: open decisions from every agent run">Inbox <span id="inbox-badge" class="badge warn" hidden></span></button>
    <button id="btn-git" class="toggle" title="Git panel">Git</button>
    <button id="btn-settings" class="icon" title="Colony settings (settings.json)">⚙</button>
  </header>
  <aside id="side">
    <div class="side-head"><span>Explorer</span><button id="tree-refresh" class="icon" title="Refresh">↻</button></div>
    <div id="tree"></div>
  </aside>
  <main id="center">
    <div id="tabs" class="tabbar"></div>
    <div id="views">
      <div id="view-home" class="view">
        <iframe id="mc" title="Mission Control" allow="clipboard-read; clipboard-write"></iframe>
        <div id="welcome">
          <h1><img src="./colony-icon.svg" alt="" width="40" height="40" /> Colony</h1>
          <p class="dim">Open a folder to start. Mission Control becomes the home tab for it.</p>
          <button id="welcome-open" class="primary">Open folder</button>
          <div id="recents"></div>
        </div>
      </div>
      <div id="view-editor" class="view" hidden></div>
      <div id="view-review" class="view" hidden></div>
    </div>
  </main>
  <aside id="right">
    <div class="tabbar"><button class="tab" data-panel="agent">Agent</button><button class="tab" data-panel="inbox">Inbox</button><button class="tab" data-panel="git">Git</button></div>
    <div id="panel-agent" class="panel"></div>
    <div id="panel-inbox" class="panel" hidden></div>
    <div id="panel-git" class="panel" hidden></div>
  </aside>
  <div id="resizer" title="Drag to resize"></div>
  <section id="bottom">
    <div id="term-tabs" class="tabbar"><button class="tab-add" title="New terminal">+</button></div>
    <div id="terms"></div>
  </section>
  <footer id="status"><span id="st-ws"></span><span id="st-msg"></span><span class="spacer"></span><span id="st-mc"></span><span id="st-env"></span></footer>
</div>
<div id="quick" hidden><div class="quick-box"><input id="quick-input" placeholder="Type a file name" autocomplete="off" spellcheck="false" /><div id="quick-list"></div></div></div>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const shell = $("shell");
let msgTimer = 0;
const status = (msg: string) => {
  $("st-msg").textContent = msg;
  window.clearTimeout(msgTimer);
  msgTimer = window.setTimeout(() => ($("st-msg").textContent = ""), 8000);
};

let workspace: WorkspaceInfo | null = null;
let mcOrigin = "";
let activeTab = HOME_TAB;
let reviewCount = 0;

// ---- editor + tabs ---------------------------------------------------------------
const editors = new Editors($("view-editor"), () => renderTabs());
const tree = new FileTree($("tree"), (p) => void openFile(p), status, (p) => void openInEditor(p));

function relPath(p: string) {
  return workspace && p.startsWith(`${workspace.root}/`) ? p.slice(workspace.root.length + 1) : p;
}

function renderTabs() {
  const bar = $("tabs");
  const home = h("button", { class: `tab home ${activeTab === HOME_TAB ? "active" : ""}`, title: "Mission Control" }, "◉ Mission Control");
  home.addEventListener("click", () => showTab(HOME_TAB));
  const n = reviewCount;
  const review = h("button", { class: `tab home ${activeTab === REVIEW_TAB ? "active" : ""}`, title: "Per-tick review of agent runs" }, "◇ Review", ...(n ? [h("span", { class: "badge" }, String(n))] : []));
  review.addEventListener("click", () => showTab(REVIEW_TAB));
  const tabs = editors.paths().map((p) => {
    const name = p.split("/").pop() ?? p;
    const dirty = editors.isDirty(p);
    const t = h("button", { class: `tab ${activeTab === p ? "active" : ""} ${dirty ? "dirty" : ""}`, title: relPath(p) }, name);
    const close = h("span", { class: "tab-close", title: "Close (Ctrl+W)" }, dirty ? "●" : "×");
    t.append(close);
    t.addEventListener("click", (ev) => (ev.target === close ? void closeFile(p) : showTab(p)));
    return t;
  });
  bar.replaceChildren(home, review, ...tabs);
}

function showTab(id: string) {
  activeTab = id;
  const home = id === HOME_TAB;
  $("view-home").hidden = !home;
  $("view-review").hidden = id !== REVIEW_TAB;
  $("view-editor").hidden = !isFileTab(id);
  if (id === REVIEW_TAB) requestAnimationFrame(() => reviewView.layout());
  if (isFileTab(id)) {
    editors.activate(id);
    tree.setActive(id);
    requestAnimationFrame(() => editors.layout());
  }
  renderTabs();
}

async function openFile(path: string) {
  try {
    await editors.open(path);
    showTab(path);
  } catch (e) {
    status(`${relPath(path)}: ${errText(e)}`);
  }
}

async function closeFile(path: string) {
  if (editors.isDirty(path)) {
    const ok = await ask(`${relPath(path)} has unsaved changes. Close without saving?`, { title: "Colony", kind: "warning" });
    if (!ok) return;
  }
  editors.close(path);
  const rest = editors.paths();
  showTab(rest.length ? rest[rest.length - 1] : HOME_TAB);
}

async function saveActive() {
  if (!isFileTab(activeTab)) return;
  try {
    const p = await editors.save(activeTab);
    if (p) status(`Saved ${relPath(p)}`);
    void gitPanel.refresh();
  } catch (e) {
    status(`Save failed: ${errText(e)}`);
  }
}

// ---- open in my editor -------------------------------------------------------------
/** Hand `path` (default: the active file, else the folder) to the user's own editor. */
async function openInEditor(path?: string) {
  if (!workspace) return status("Open a folder first");
  const target = path ?? (isFileTab(activeTab) ? activeTab : workspace.root);
  if (editors.isDirty(target)) status(`${relPath(target)} has unsaved changes in Colony: save first (Ctrl+S)`);
  try {
    const launch = await api.openInEditor(target);
    if (launch.mode === "terminal") {
      toggleTerminal(true);
      await terminals.create(launch.argv, launch.label);
    }
    status(`Opened ${relPath(target)} in ${launch.label.split(" ")[0]} (${launch.source}${launch.mode === "terminal" ? ", terminal tab" : ""})`);
    return launch;
  } catch (e) {
    status(`Open in editor: ${errText(e)}`);
  }
}
$("btn-editor").addEventListener("click", () => void openInEditor());
$("btn-settings").addEventListener("click", async () => {
  try {
    await openFile(await api.settingsEnsure());
    status("Colony settings: editor.command / editor.terminal; workspaces.<folder>.backend is remembered by the Agent panel");
  } catch (e) {
    status(`Settings: ${errText(e)}`);
  }
});

// ---- panels ------------------------------------------------------------------------
const terminals = new Terminals($("term-tabs"), $("terms"), status);
$("term-tabs").querySelector(".tab-add")!.addEventListener("click", () => void terminals.create());
const agentPanel = new AgentPanel($("panel-agent"), status);
const reviewView = new ReviewView(
  $("view-review"),
  (n) => {
    reviewCount = n;
    renderTabs();
  },
  (p) => void openFile(p),
  status,
);
const gitPanel = new GitPanel($("panel-git"), status, () => void tree.refresh());

type RightPanel = "agent" | "inbox" | "git";
const RIGHT_PANELS: RightPanel[] = ["agent", "inbox", "git"];
function currentRight(): RightPanel | null {
  if (shell.classList.contains("no-right")) return null;
  return RIGHT_PANELS.find((p) => !$(`panel-${p}`).hidden) ?? null;
}
/** Show `panel` on the right; the same panel again hides the column (unless `keep`). */
function setRight(panel: RightPanel | null, keep = false) {
  const next = panel === currentRight() && !keep ? null : panel;
  shell.classList.toggle("no-right", next === null);
  for (const p of RIGHT_PANELS) {
    $(`panel-${p}`).hidden = next !== p;
    $(`btn-${p}`).classList.toggle("on", next === p);
  }
  for (const t of $("right").querySelectorAll<HTMLElement>(".tabbar .tab")) t.classList.toggle("active", t.dataset.panel === next);
  if (next === "git") void gitPanel.refresh();
  requestAnimationFrame(() => editors.layout());
}
for (const p of RIGHT_PANELS) $(`btn-${p}`).addEventListener("click", () => setRight(p));
for (const t of $("right").querySelectorAll<HTMLElement>(".tabbar .tab")) {
  t.addEventListener("click", () => setRight(t.dataset.panel as RightPanel, true));
}
const inbox = new InboxPanel(
  $("panel-inbox"),
  (n) => {
    const badge = $("inbox-badge");
    badge.hidden = n === 0;
    badge.textContent = String(n);
    const tab = $("right").querySelector<HTMLElement>('.tabbar .tab[data-panel="inbox"]');
    if (tab) tab.textContent = n ? `Inbox (${n})` : "Inbox";
  },
  (runId) => {
    agentPanel.select(runId);
    setRight("agent", true);
  },
  status,
);
void inbox;

function toggleTerminal(force?: boolean) {
  const show = force ?? shell.classList.contains("no-bottom");
  shell.classList.toggle("no-bottom", !show);
  $("btn-term").classList.toggle("on", show);
  if (show) {
    if (workspace && terminals.count === 0) void terminals.create();
    requestAnimationFrame(() => {
      terminals.fitActive();
      terminals.focus();
    });
  }
  requestAnimationFrame(() => editors.layout());
}
$("btn-term").addEventListener("click", () => toggleTerminal());

// Bottom panel resize.
$("resizer").addEventListener("pointerdown", (down) => {
  const startY = down.clientY;
  const startH = $("bottom").getBoundingClientRect().height;
  const move = (ev: PointerEvent) => {
    const hgt = Math.max(80, Math.min(window.innerHeight - 200, startH + (startY - ev.clientY)));
    shell.style.setProperty("--bottom-h", `${hgt}px`);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    terminals.fitActive();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
});

// ---- quick open ------------------------------------------------------------------
let quickFiles: string[] = [];
let quickSel = 0;
async function showQuick() {
  if (!workspace) return status("Open a folder first");
  $("quick").hidden = false;
  const input = $<HTMLInputElement>("quick-input");
  input.value = "";
  input.focus();
  quickFiles = await api.listFiles().catch(() => []);
  renderQuick();
}
function quickMatches(): string[] {
  const q = $<HTMLInputElement>("quick-input").value.trim().toLowerCase();
  if (!q) return quickFiles.slice(0, 50);
  const scored: [number, string][] = [];
  for (const f of quickFiles) {
    const lf = f.toLowerCase();
    const base = lf.split("/").pop() ?? lf;
    const idx = lf.indexOf(q);
    if (idx < 0) continue;
    scored.push([(base.startsWith(q) ? 0 : base.includes(q) ? 1 : 2) * 10000 + lf.length, f]);
  }
  scored.sort((a, b) => a[0] - b[0]);
  return scored.slice(0, 50).map((s) => s[1]);
}
function renderQuick() {
  const list = quickMatches();
  quickSel = Math.min(quickSel, Math.max(0, list.length - 1));
  $("quick-list").replaceChildren(
    ...list.map((f, i) => {
      const r = h("div", { class: `quick-item ${i === quickSel ? "sel" : ""}` }, f);
      r.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        pickQuick(f);
      });
      return r;
    }),
  );
}
function hideQuick() {
  $("quick").hidden = true;
}
function pickQuick(rel: string) {
  hideQuick();
  if (workspace) void openFile(`${workspace.root}/${rel}`);
}
$("quick-input").addEventListener("input", () => {
  quickSel = 0;
  renderQuick();
});
$("quick-input").addEventListener("keydown", (ev) => {
  const list = quickMatches();
  if (ev.key === "ArrowDown") quickSel = Math.min(quickSel + 1, list.length - 1);
  else if (ev.key === "ArrowUp") quickSel = Math.max(quickSel - 1, 0);
  else if (ev.key === "Enter") return list[quickSel] && pickQuick(list[quickSel]);
  else if (ev.key === "Escape") return hideQuick();
  else return;
  ev.preventDefault();
  renderQuick();
});
$("quick-input").addEventListener("blur", () => setTimeout(hideQuick, 100));
$("btn-quick").addEventListener("click", () => void showQuick());

// ---- workspace ---------------------------------------------------------------------
function recents(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function remember(root: string) {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify([root, ...recents().filter((r) => r !== root)].slice(0, 8)));
  } catch {
    /* storage unavailable */
  }
}
function renderRecents() {
  const list = recents();
  $("recents").replaceChildren(
    ...(list.length ? [h("div", { class: "dim" }, "Recent")] : []),
    ...list.map((r) => {
      const b = h("button", { class: "recent" }, r);
      b.addEventListener("click", () => void openWorkspace(r));
      return b;
    }),
  );
}

async function pickFolder() {
  const picked = await open({ directory: true, multiple: false, title: "Open folder" });
  if (typeof picked === "string") await openWorkspace(picked);
}
$("btn-open").addEventListener("click", () => void pickFolder());
$("welcome-open").addEventListener("click", () => void pickFolder());
$("tree-refresh").addEventListener("click", () => void tree.refresh());

async function openWorkspace(path: string) {
  if (workspace) {
    const dirty = editors.paths().filter((p) => editors.isDirty(p));
    if (dirty.length && !(await ask(`${dirty.length} file(s) have unsaved changes. Switch folder anyway?`, { title: "Colony", kind: "warning" }))) return;
  }
  try {
    workspace = await api.openWorkspace(path);
  } catch (e) {
    return status(errText(e));
  }
  remember(workspace.root);
  editors.closeAll();
  terminals.closeAll();
  document.title = `${workspace.name} · Colony`;
  $("ws-name").textContent = workspace.root;
  $("st-ws").textContent = workspace.name;
  $("welcome").hidden = true;
  showTab(HOME_TAB);
  await tree.setRoot(workspace.root);
  await agentPanel.loadWorkspace();
  if (!shell.classList.contains("no-bottom")) void terminals.create();
  void gitPanel.refresh();
  if (!workspace.hasKit) status("No Agent Kit in this folder: Mission Control shows git and repo data only (agent-kit install adds plans and HANDOFF)");
  $("st-mc").textContent = "Mission Control: starting…";
  try {
    const mc = await api.dashboardStart();
    mcOrigin = new URL(mc.url).origin;
    $<HTMLIFrameElement>("mc").src = mc.url;
    $("st-mc").textContent = `Mission Control ${mc.url}`;
    $("st-mc").title = `${mc.servePath}\nlog: ${mc.logPath}`;
  } catch (e) {
    $("st-mc").textContent = "Mission Control: failed";
    status(`Mission Control: ${errText(e)}`);
  }
}

// Mission Control action seam (src-tauri/src/lib.rs hook, src/mcactions.ts allowlist): the
// frame offers each copy record here first; `handled: false` makes the frame copy as before.
type McReply = { handled: boolean; ok?: boolean; message?: string };
let confirmMcRun = async (plan: string | null) => {
  const engine = agentPanel.backend.value;
  const named = plan ? ` Mission Control named ${plan}; agent-kit run-plan runs the folder's active plan.` : "";
  return ask(`Start an Agent run of the active plan in ${workspace?.name ?? "this folder"} with ${engine}?${named}`, { title: "Mission Control", kind: "info" });
};
async function hostMcAction(record: McRecord): Promise<McReply> {
  const d = decide(record);
  if (d.action === "open-file" && workspace) {
    const abs = `${workspace.root}/${d.path}`;
    try {
      await editors.open(abs);
      showTab(abs);
      return { handled: true, message: `Opened ${d.path} in Colony` };
    } catch {
      return { handled: false };
    }
  }
  if (d.action === "run-plan" && workspace) {
    setRight("agent", true);
    void confirmMcRun(d.plan).then(async (yes) => {
      if (!yes) return status("Mission Control: run not started");
      await agentPanel.start();
    });
    return { handled: true, message: "Confirm the run in Colony" };
  }
  const where = record.destination === "terminal" ? "paste it in a Colony terminal (Ctrl+Shift+V)" : `paste it in the ${record.destination || "target"}`;
  status(`Mission Control copied ${record.subject || "text"}: ${where}`);
  return { handled: false };
}
window.addEventListener("message", (ev) => {
  const frame = $<HTMLIFrameElement>("mc");
  if (!mcOrigin || ev.origin !== mcOrigin || ev.source !== frame.contentWindow || ev.data?.colony !== "mc-action") return;
  const port = ev.ports[0];
  const a = ev.data.action ?? {};
  const record: McRecord = { kind: String(a.kind ?? ""), text: String(a.text ?? ""), subject: String(a.subject ?? ""), destination: String(a.destination ?? "") };
  void hostMcAction(record).then(
    (reply) => port?.postMessage(reply),
    () => port?.postMessage({ handled: false }),
  );
});

/** COLONY_SMOKE: run `perform()` inside the Mission Control frame and wait for its result. */
function mcPerformInFrame(action: Record<string, string>): Promise<unknown> {
  const frame = $<HTMLIFrameElement>("mc");
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), 4000);
    const onMsg = (ev: MessageEvent) => {
      if (ev.origin !== mcOrigin || ev.data?.colony !== "mc-smoke-result" || ev.data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMsg);
      resolve(ev.data.error ? { error: ev.data.error } : ev.data.result);
    };
    window.addEventListener("message", onMsg);
    frame.contentWindow?.postMessage({ colony: "mc-smoke-perform", id, action }, mcOrigin);
  });
}

// ---- keyboard ----------------------------------------------------------------------
window.addEventListener(
  "keydown",
  (ev) => {
    if (!ev.ctrlKey || ev.altKey || ev.metaKey) return;
    const inTerm = terminals.hasFocus();
    const key = ev.key.toLowerCase();
    let handled = true;
    if (ev.code === "Backquote") toggleTerminal(inTerm ? false : true);
    else if (key === "s" && !ev.shiftKey) void saveActive();
    else if (key === "o" && !ev.shiftKey && !inTerm) void pickFolder();
    else if (key === "p" && !ev.shiftKey && !inTerm) void showQuick();
    else if (key === "w" && !ev.shiftKey && !inTerm && isFileTab(activeTab)) void closeFile(activeTab);
    else if (key === "e" && ev.shiftKey) void openInEditor();
    else if (key === "t" && ev.shiftKey) {
      toggleTerminal(true);
      void terminals.create();
    } else handled = false;
    if (handled) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  },
  true,
);

window.addEventListener("beforeunload", (ev) => {
  if (editors.paths().some((p) => editors.isDirty(p))) ev.preventDefault();
});

// ---- code-path smoke (COLONY_SMOKE=<log>): no human input, every step logged -------------
async function runSmoke(root: string) {
  const log = (step: string, ok: boolean, detail: unknown = "") =>
    api.smokeLog(JSON.stringify({ t: new Date().toISOString(), step, ok, detail }));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    await log("workspace", true, root);
    await log("tree", $("tree").querySelectorAll(".tree-row").length > 0, `${$("tree").querySelectorAll(".tree-row").length} rows`);
    const frame = $<HTMLIFrameElement>("mc");
    const loaded = await Promise.race([
      new Promise<boolean>((r) => frame.addEventListener("load", () => r(true), { once: true })),
      wait(8000).then(() => false),
    ]);
    await log("mission-control", !!frame.src && (loaded || frame.src.startsWith("http://127.0.0.1:")), { src: frame.src, loadEvent: loaded });
    const file = `${root}/README.md`;
    await openFile(file);
    await log("editor-open", editors.active === file, relPath(file));
    const model = editors.editor.getModel();
    const line = `\nEdited in Colony (code-path smoke ${Date.now()}).\n`;
    model?.setValue(`${model.getValue()}${line}`);
    await log("editor-dirty", editors.isDirty(file));
    await saveActive();
    const onDisk = await api.readTextFile(file);
    await log("editor-save", onDisk.endsWith(line) && !editors.isDirty(file), onDisk.slice(-80));
    if (terminals.count === 0) await terminals.create();
    await wait(1500);
    await terminals.sendToActive("echo colony-ok-$((6*7)) > smoke.txt\n");
    let out = "";
    for (let i = 0; i < 25 && !out; i++) {
      await wait(200);
      out = await api.readTextFile(`${root}/smoke.txt`).catch(() => "");
    }
    await log("terminal-command", out.trim() === "colony-ok-42", out.trim());
    // Open in my editor (run the smoke with EDITOR=packaging/smoke/fake-editor.sh).
    const launch = await openInEditor(file);
    let proof = "";
    for (let i = 0; i < 25 && !proof; i++) {
      await wait(200);
      proof = await api.readTextFile(`${root}/editor-proof.txt`).catch(() => "");
    }
    await log("open-in-editor", proof.trim() === `opened ${file}`, { launch, proof: proof.trim() });
    // Mission Control host actions: the allowlist, then the real frame -> host round trip.
    const cases: [McRecord, string][] = [
      [{ kind: "copy", text: "README.md", subject: "path", destination: "filePicker" }, "open-file"],
      [{ kind: "copy", text: "../etc/passwd", subject: "path", destination: "filePicker" }, "copy"],
      [{ kind: "copy", text: "/run-plan", subject: "/run-plan", destination: "chatInput" }, "run-plan"],
      [{ kind: "copy", text: "/run-plan mission.plan.md", subject: "", destination: "chatInput" }, "run-plan"],
      [{ kind: "copy", text: "/run-plan-all", subject: "", destination: "chatInput" }, "copy"],
      [{ kind: "copy", text: "/git-prod", subject: "", destination: "chatInput" }, "copy"],
      [{ kind: "copy", text: "/run-plan x; rm -rf ~", subject: "", destination: "chatInput" }, "copy"],
      [{ kind: "copy", text: "git diff", subject: "", destination: "terminal" }, "copy"],
    ];
    const verdicts = cases.map(([r, want]) => ({ text: r.text, got: decide(r).action, want }));
    await log("mc-allowlist", verdicts.every((v) => v.got === v.want), verdicts);
    showTab(HOME_TAB);
    const opened = await mcPerformInFrame({ kind: "copy", text: "smoke.txt", subject: "path smoke.txt", destination: "filePicker" });
    await log("mc-open-file", editors.active === `${root}/smoke.txt` && activeTab === `${root}/smoke.txt`, { result: opened, active: editors.active ? relPath(editors.active) : null });
    let asked = "";
    const realConfirm = confirmMcRun;
    confirmMcRun = async (plan) => {
      asked = `asked (plan ${plan ?? "none"})`;
      return false; // the smoke never starts a run from Mission Control
    };
    const runReply = await mcPerformInFrame({ kind: "copy", text: "/run-plan demo.plan.md", subject: "/run-plan", destination: "chatInput" });
    await wait(200);
    confirmMcRun = realConfirm;
    await log("mc-run-plan", asked === "asked (plan demo.plan.md)" && runs.list().length === 0, { result: runReply, asked });
    // Harmless text: the fallback may really write the clipboard.
    const copied = await mcPerformInFrame({ kind: "copy", text: "colony smoke copy fallback", subject: "smoke text", destination: "terminal", toastMessage: "Copied smoke text" });
    await log("mc-copy-fallback", JSON.stringify(copied).includes("Colony") && !JSON.stringify(copied).includes("Opened"), copied);
    const gs = await api.gitStatus();
    await log("git-status", gs.isRepo, { branch: gs.branch, files: gs.files.map((f) => `${f.xy} ${f.path}`) });
    const seen = new Map<number, string[]>();
    const off = runs.on((c) => {
      if (c.kind === "event") seen.set(c.run.id, [...(seen.get(c.run.id) ?? []), String(c.ev.type)]);
    });
    // Engine picker: choose through the controls (DOM change events), then read back the
    // per-folder memory from the settings file.
    const pick = (el: HTMLInputElement | HTMLSelectElement, v: string) => {
      el.value = v;
      el.dispatchEvent(new Event("change"));
    };
    pick(agentPanel.backend, "codex");
    pick(agentPanel.onLimit, "claude");
    pick(agentPanel.model, "smoke-model");
    pick(agentPanel.ticks, "1");
    await wait(300);
    const remembered = await api.settingsWorkspace();
    await log("engine-remembered", remembered.backend === "codex" && remembered.onLimit === "claude" && remembered.model === "smoke-model", remembered);
    const run = await agentPanel.start();
    if (!run) throw new Error("agent run did not start");
    for (let i = 0; i < 100 && run.running && !run.gate; i++) await wait(200);
    // Fixture driver (COLONY_AGENT_KIT_BIN=packaging/smoke/fake-agent-kit.sh): answer its
    // gate through the same button the operator clicks.
    const fixture = run.plan === "smoke-fixture.plan.md";
    const second: { run?: Run; root: string } = { root: root.replace(/\/repo$/, "/repo2") };
    if (run.gate && fixture) {
      // A second run (another folder, another engine) so the Inbox aggregates two gates.
      const dup = await runs.start({ backend: "claude", maxTicks: 1 }).then(
        () => "started",
        (e) => errText(e),
      );
      await log("one-run-per-folder", dup.includes("already active"), dup);
      second.run = await runs.start({ backend: "claude", maxTicks: 1, cwd: second.root }).catch(() => undefined);
      for (let i = 0; i < 50 && second.run?.running && !second.run.gate; i++) await wait(200);
    }
    if (run.gate) {
      // Answer from the Inbox cards (same handler as the operator's click).
      setRight("inbox", true);
      const badge = $("inbox-badge");
      const cards = [...$("panel-inbox").querySelectorAll<HTMLElement>(".inbox-card")];
      await log("inbox-open", !badge.hidden && Number(badge.textContent) === cards.length && cards.length === (second.run ? 2 : 1), {
        badge: badge.textContent,
        cards: cards.map((c) => `${c.dataset.run}:${c.dataset.ask} ${c.querySelector(".inbox-meta span")?.textContent}`),
      });
      const answer = (r: Run, n: number) =>
        $("panel-inbox").querySelector<HTMLButtonElement>(`.inbox-card[data-run="${r.id}"] .gate-buttons button[data-reply="${n}"]`)?.click();
      if (second.run) answer(second.run, 2);
      answer(run, 1);
      await wait(400);
      await log("inbox-cleared", !run.gate && !second.run?.gate && badge.hidden && !$("panel-inbox").querySelector(".inbox-card"), { badgeHidden: badge.hidden });
    }
    for (let i = 0; i < 100 && run.running; i++) await wait(200);
    off();
    const events = seen.get(run.id) ?? [];
    await log("agent-driver", events.includes("run_end") && !run.running, { cmd: run.cmd, events, exitCode: run.exitCode });
    if (fixture) {
      const args = run.rows.find((r) => r.text.startsWith("fixture args:"))?.text ?? "";
      await log("engine-used", run.backend === "codex" && args === "fixture args: backend=codex on-limit=claude model=smoke-model", { backend: run.backend, args });
      const reply = await api.readTextFile(`${root}/gate-reply.json`).catch((e) => `missing: ${errText(e)}`);
      let sent: Record<string, unknown> = {};
      try {
        sent = JSON.parse(reply);
      } catch {
        /* logged below */
      }
      await log("gate-answer", sent.type === "hitl_reply" && sent.askId === "smoke-gate" && sent.reply === 1 && !run.gate, reply.trim());
      if (second.run) {
        for (let i = 0; i < 50 && second.run.running; i++) await wait(200);
        const r2 = second.run.rows.find((r) => r.text.startsWith("fixture reply:"))?.text ?? "";
        await log("gate-answer-second-run", r2.includes('"reply":2') && r2.includes('"askId":"smoke-gate"') && second.run.backend === "claude", { reply: r2, backend: second.run.backend, exit: second.run.exitCode });
      }
      const rv = run.reviews[0];
      const files = (rv?.files ?? []).map((f) => `${f.status} ${f.path}`).sort();
      await log("tick-review", !!rv && rv.finished && files.join(",") === "A fixture-tick.txt,A gate-reply.json,M README.md", { tick: rv?.tick, files, result: rv?.resultLine });
      if (rv) {
        showTab(REVIEW_TAB);
        const v = await reviewView.show(rv, rv.files.find((f) => f.path === "fixture-tick.txt") ?? rv.files[0]);
        await wait(500);
        await log("review-diff", v.before === null && v.after === "written by the fixture tick\nanswered\n", { before: v.before, after: v.after, rows: $("view-review").querySelectorAll(".rv-file").length });
      }
    }
    await log("done", true);
  } catch (e) {
    await log("error", false, errText(e));
  }
  await wait(1500);
  await api.smokeExit();
}

// ---- boot --------------------------------------------------------------------------
renderTabs();
renderRecents();
api
  .appInfo()
  .then(async (info: StartupInfo) => {
    $("st-env").textContent = `v${info.version} · DMA-BUF ${info.webkitDmabuf}`;
    $("st-env").title = [`agent-kit: ${info.agentKit ?? "not found"}`, `node: ${info.node ?? "not found"}`, `git: ${info.git ?? "not found"}`, `PATH added: ${info.pathAdded.join(", ") || "none"}`].join("\n");
    if (!info.agentKit) status("agent-kit CLI not found on PATH: Mission Control and the Agent panel need it");
    if (info.smoke) focusPolicy.enabled = false;
    const start = info.initialWorkspace ?? recents()[0];
    if (start) await openWorkspace(start);
    if (info.smoke && workspace) await runSmoke(workspace.root);
  })
  .catch((e) => status(errText(e)));
