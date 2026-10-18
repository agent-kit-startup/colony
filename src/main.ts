// Colony window: Mission Control home, explorer, editor tabs, terminals, agent and git panels.
import { ask, open } from "@tauri-apps/plugin-dialog";
import { AgentPanel } from "./agent";
import { api, Channel, errText, focusPolicy, h, type AgentEvent, type StartupInfo, type WorkspaceInfo } from "./api";
import { Editors } from "./editor";
import { FileTree } from "./filetree";
import { GitPanel } from "./git";
import "./styles.css";
import { Terminals } from "./terminal";

const RECENTS_KEY = "colony.recentWorkspaces";
const HOME_TAB = "__home__";

document.getElementById("app")!.innerHTML = `
<div id="shell" class="no-right">
  <header id="top">
    <span class="brand"><img src="./colony-icon.svg" alt="" width="18" height="18" /> Colony</span>
    <button id="btn-open" title="Open folder (Ctrl+O)">Open folder</button>
    <span id="ws-name" class="dim">No folder open</span>
    <span class="spacer"></span>
    <button id="btn-quick" title="Quick open (Ctrl+P)">Go to file</button>
    <button id="btn-term" class="toggle on" title="Terminal (Ctrl+\`)">Terminal</button>
    <button id="btn-agent" class="toggle" title="Agent panel">Agent</button>
    <button id="btn-git" class="toggle" title="Git panel">Git</button>
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
    </div>
  </main>
  <aside id="right">
    <div class="tabbar"><button class="tab" data-panel="agent">Agent</button><button class="tab" data-panel="git">Git</button></div>
    <div id="panel-agent" class="panel"></div>
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

// ---- editor + tabs ---------------------------------------------------------------
const editors = new Editors($("view-editor"), () => renderTabs());
const tree = new FileTree($("tree"), (p) => void openFile(p), status);

function relPath(p: string) {
  return workspace && p.startsWith(`${workspace.root}/`) ? p.slice(workspace.root.length + 1) : p;
}

function renderTabs() {
  const bar = $("tabs");
  const home = h("button", { class: `tab home ${activeTab === HOME_TAB ? "active" : ""}`, title: "Mission Control" }, "◉ Mission Control");
  home.addEventListener("click", () => showTab(HOME_TAB));
  const tabs = editors.paths().map((p) => {
    const name = p.split("/").pop() ?? p;
    const dirty = editors.isDirty(p);
    const t = h("button", { class: `tab ${activeTab === p ? "active" : ""} ${dirty ? "dirty" : ""}`, title: relPath(p) }, name);
    const close = h("span", { class: "tab-close", title: "Close (Ctrl+W)" }, dirty ? "●" : "×");
    t.append(close);
    t.addEventListener("click", (ev) => (ev.target === close ? void closeFile(p) : showTab(p)));
    return t;
  });
  bar.replaceChildren(home, ...tabs);
}

function showTab(id: string) {
  activeTab = id;
  const home = id === HOME_TAB;
  $("view-home").hidden = !home;
  $("view-editor").hidden = home;
  if (!home) {
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
  if (activeTab === HOME_TAB) return;
  try {
    const p = await editors.save(activeTab);
    if (p) status(`Saved ${relPath(p)}`);
    void gitPanel.refresh();
  } catch (e) {
    status(`Save failed: ${errText(e)}`);
  }
}

// ---- panels ------------------------------------------------------------------------
const terminals = new Terminals($("term-tabs"), $("terms"), status);
$("term-tabs").querySelector(".tab-add")!.addEventListener("click", () => void terminals.create());
new AgentPanel($("panel-agent"), status);
const gitPanel = new GitPanel($("panel-git"), status, () => void tree.refresh());

function setRight(panel: "agent" | "git" | null) {
  const current = shell.classList.contains("no-right") ? null : $("panel-agent").hidden ? "git" : "agent";
  const next = panel === current ? null : panel;
  shell.classList.toggle("no-right", next === null);
  $("panel-agent").hidden = next !== "agent";
  $("panel-git").hidden = next !== "git";
  $("btn-agent").classList.toggle("on", next === "agent");
  $("btn-git").classList.toggle("on", next === "git");
  for (const t of $("right").querySelectorAll<HTMLElement>(".tabbar .tab")) t.classList.toggle("active", t.dataset.panel === next);
  if (next === "git") void gitPanel.refresh();
  requestAnimationFrame(() => editors.layout());
}
$("btn-agent").addEventListener("click", () => setRight("agent"));
$("btn-git").addEventListener("click", () => setRight("git"));
for (const t of $("right").querySelectorAll<HTMLElement>(".tabbar .tab")) {
  t.addEventListener("click", () => setRight(t.dataset.panel as "agent" | "git"));
}

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

// Mission Control action seam: the frame posts each copy record here (src-tauri/src/lib.rs).
window.addEventListener("message", (ev) => {
  if (!mcOrigin || ev.origin !== mcOrigin || ev.data?.colony !== "mc-action") return;
  const a = ev.data.action ?? {};
  const where = a.destination === "terminal" ? "paste it in a Colony terminal (Ctrl+Shift+V)" : `paste it in the ${a.destination || "target"}`;
  status(`Mission Control copied ${a.subject || "text"}: ${where}`);
});

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
    else if (key === "w" && !ev.shiftKey && !inTerm && activeTab !== HOME_TAB) void closeFile(activeTab);
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
    const gs = await api.gitStatus();
    await log("git-status", gs.isRepo, { branch: gs.branch, files: gs.files.map((f) => `${f.xy} ${f.path}`) });
    const events: string[] = [];
    let exitCode: number | null | undefined;
    const ch = new Channel<AgentEvent>();
    ch.onmessage = (m) => {
      if (m.kind === "event") events.push(String(JSON.parse(m.line).type));
      if (m.kind === "exit") exitCode = m.code;
    };
    const cmd = await api.agentStart("claude", 1, ch);
    for (let i = 0; i < 100 && exitCode === undefined; i++) await wait(200);
    await log("agent-driver", events.includes("run_end") && exitCode !== undefined, { cmd, events, exitCode });
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
