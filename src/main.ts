// Colony window: the cockpit. A vertical rail holds the primary views (Mission, Inbox,
// Review, Git, Terminal, Pipelines) and More (Plans, Flight Log, Activity, commands); the
// tab strip holds documents only: one tab per agent run (its transcript), terminal tabs for
// the interactive vendor CLI and the queue runner, the editor files and the kit's web panel
// (a fallback under More). Explorer next to the rail, shell terminals at the bottom.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { RunControls } from "./agent";
import { chats } from "./chats";
import { chatSmoke } from "./chatsmoke";
import { api, Channel, errText, focusPolicy, h, type InstanceEvent, type LayoutSettings, type StartupInfo, type TickReview, type WorkspaceInfo } from "./api";
import { ActivityView, type CockpitHost, FlightLogView, MissionView, PlansView, QueueView } from "./cockpit";
import { ContextStrip } from "./contextstrip";
import { Editors } from "./editor";
import { openAboutPanel } from "./about";
import { closeEnginePanel, openEnginePanel, refreshEngineBadge } from "./engine";
import { FileTree } from "./filetree";
import { CicdView, PullRequestsSection } from "./forge";
import { GateAlerts, pendingGates } from "./gates";
import { openOmarchyPanel, publishShellStatus } from "./omarchy";
import { GitView } from "./git";
import { hostApi, hostRequests, inboxRequests, RequestsSection } from "./hostreq";
import { gitCicdSmoke, hostSmoke } from "./hostsmoke";
import { InboxView } from "./inbox";
import { launches, promptPlan } from "./launches";
import { decide, type McRecord } from "./mcactions";
import { CommandPalette } from "./palette";
import { readiness } from "./readiness";
import { ReviewView } from "./review";
import { type Run, runs } from "./runs";
import { kitSkinValue, loadSkin, omarchyDetected, omarchyTheme, onSkin, setSkin, type Skin, SKINS, skin, termFont } from "./skin";
import { smokeLive } from "./smoke-live";
import { snapshot } from "./snapshot";
import "./styles.css";
import { Terminals } from "./terminal";
import { TermView } from "./termview";
import { AgentTab } from "./transcript";
import { icon, type IconKind } from "./icons";
import menuSpec from "./menu.json";
import { ago, copyText } from "./ui";

const RECENTS_KEY = "colony.recentWorkspaces";

// Content-Security-Policy violations (tauri.conf.json app.security.csp), kept so the smoke
// can prove the policy blocks nothing Colony itself needs.
const cspViolations: string[] = [];
document.addEventListener("securitypolicyviolation", (e) => {
  if (cspViolations.length < 50) cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`.trim());
});

document.getElementById("app")!.innerHTML = `
<div id="shell">
  <header id="top">
    <span class="brand"><img src="./colony-icon.svg" alt="" width="18" height="18" /> Colony</span>
    <span id="top-menus" hidden></span>
    <button id="btn-open" title="Open folder (Ctrl+O)">Open folder</button>
    <span id="ws-name" class="dim">No folder open</span>
    <span class="spacer"></span>
    <button id="btn-quick" title="Quick open (Ctrl+P)">Go to file</button>
    <button id="btn-editor" title="Open the current file (or the folder) in your editor (Ctrl+Shift+E). Right-click a file in the Explorer for that file.">Open in editor</button>
    <button id="btn-settings" class="icon" title="Colony settings (settings.json)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button>
    <span id="win-controls" hidden>
      <button class="win-min" title="Minimize" aria-label="Minimize"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M3 8h10"/></svg></button>
      <button class="win-max" title="Maximize" aria-label="Maximize"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9"/></svg></button>
      <button class="win-close" title="Close" aria-label="Close"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
    </span>
  </header>
  <nav id="rail" aria-label="Views"></nav>
  <aside id="side">
    <div class="side-head"><span>Explorer</span><button id="tree-refresh" class="icon" title="Refresh"></button></div>
    <div id="tree"></div>
  </aside>
  <div id="side-resizer" title="Drag to resize the Explorer"></div>
  <main id="center">
    <div id="tabs" class="tabbar"></div>
    <div id="views">
      <div id="welcome" class="view">
        <h1><img src="./colony-icon.svg" alt="" width="40" height="40" /> Colony</h1>
        <p class="dim">Open a folder to start. Its Mission Control becomes the cockpit.</p>
        <button id="welcome-open" class="primary">Open folder</button>
        <div id="recents"></div>
      </div>
      <div id="view-editor" class="view" hidden></div>
      <div id="view-review" class="view" hidden></div>
    </div>
  </main>
  <div id="resizer" title="Drag to resize"></div>
  <section id="bottom">
    <div id="term-tabs" class="tabbar"><button class="tab-add" title="New terminal">+</button><span class="dock-group" role="group" aria-label="Terminal position"><button data-dock="bottom" title="Terminal at the bottom" aria-label="Terminal at the bottom"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M2.5 10h11"/></svg></button><button data-dock="top" title="Terminal at the top" aria-label="Terminal at the top"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M2.5 6h11"/></svg></button><button data-dock="side" title="Terminal at the side" aria-label="Terminal at the side"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M10 2.5v11"/></svg></button></span></div>
    <div id="terms"></div>
  </section>
  <footer id="status"><span id="st-ws"></span><span id="st-msg"></span><span class="spacer"></span><span id="st-mc"></span><span id="st-engine" class="clickable"></span><span id="st-env"></span></footer>
</div>
<div id="more-menu" class="menu" hidden>
  <div class="menu-label">Views</div>
  <button data-cmd="view:plans" title="Ctrl+7">Plans</button>
  <button data-cmd="view:flight" title="Ctrl+8">Flight Log</button>
  <button data-cmd="view:activity" title="Ctrl+9">Activity</button>
  <div class="menu-sep"></div>
  <button data-cmd="commands" title="Ctrl+Shift+P">Commands…</button>
  <button data-cmd="web">Mission Control (web panel)</button>
  <button data-cmd="run-elsewhere">Run plan in another folder…</button>
  <button data-cmd="refresh">Reload Mission Control data</button>
  <button data-cmd="new-terminal">New shell terminal</button>
  <button data-cmd="engine">Engine…</button>
  <button data-cmd="about">About Colony…</button>
  <button data-cmd="omarchy" hidden title="Bar widget and menu entries for omarchy-shell (opt-in, removable)">Omarchy integration…</button>
  <div class="menu-sep"></div>
  <div class="menu-label">Skin</div>
  <button data-more="skin" data-skin="bare-metal">Bare Metal</button>
  <button data-more="skin" data-skin="legacy">Legacy</button>
  <button data-more="skin" data-skin="omarchy" hidden title="The Omarchy theme and monospace font, live">Omarchy (system theme)</button>
  <div class="menu-sep" data-title-bar-menu></div>
  <div class="menu-label" data-title-bar-menu>Title bar (on the next start)</div>
  <button data-more="title-bar" data-title-bar-menu data-mode="native" title="The system or window manager draws the title bar and the window controls; the menu bar sits under it">Native</button>
  <button data-more="title-bar" data-title-bar-menu data-mode="custom" title="Colony draws the title bar: menus, drag, double-click to maximize, minimize / maximize / close">Custom</button>
</div>
<div id="quick" hidden><div class="quick-box"><input id="quick-input" placeholder="Type a file name" autocomplete="off" spellcheck="false" /><div id="quick-list"></div></div></div>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const shell = $("shell");
let msgTimer = 0;
const status = (msg: string) => {
  $("st-msg").textContent = msg;
  $("st-msg").title = msg;
  window.clearTimeout(msgTimer);
  msgTimer = window.setTimeout(() => ($("st-msg").textContent = ""), 9000);
};

let workspace: WorkspaceInfo | null = null;
let mcUrl = "";
let mcOrigin = "";
/** The folder's Mission Control server log (~/.cache/colony/dashboard-<port>.log), once known. */
let mcLog = "";

// ---- tabs and rail --------------------------------------------------------------------
interface Tab {
  id: string;
  label: string;
  /** Kit SVG icon of the tab ("" for none: editor files). */
  icon: IconKind | "";
  tip: string;
  /** A view of the rail or of More, not a document: never in the tab strip, never closed. */
  pinned: boolean;
  el: HTMLElement;
  /** `extra`: a second, separate count next to the first (the Inbox: gates, then attention). */
  badge?: () => { text: string; cls: string; tip?: string; extra?: { text: string; cls: string; tip?: string } } | null;
  cls?: () => string;
  show?: () => void;
  hide?: () => void;
  /** Return false to keep the tab open. */
  close?: () => Promise<boolean> | boolean;
}
const tabs = new Map<string, Tab>();
const order: string[] = [];
let activeTab = "mission";

/**
 * Primary navigation (desktop IDE study: Mission, Inbox, Review, Git, Terminal and
 * Pipelines; everything else under More). A rail item shows one view, or a group of views
 * with a switch at the head of the tab strip; Terminal toggles the bottom panel.
 */
interface RailItem { id: string; label: string; icon: IconKind; tip: string; views: string[] }
const RAIL: RailItem[] = [
  { id: "mission", label: "Mission", icon: "current-mission", tip: "Mission: the active plan, what needs you, agent runs and the queue (Ctrl+1)", views: ["mission"] },
  { id: "inbox", label: "Inbox", icon: "inbox", tip: "Inbox: live gates from every run, attention items, gate exits (Ctrl+2)", views: ["inbox"] },
  { id: "review", label: "Review", icon: "review", tip: "Review: per-tick diffs of agent runs (Ctrl+3)", views: ["review"] },
  { id: "git", label: "Git", icon: "git", tip: "Git: host requests, pull requests, branch flow, working tree, commit, push (Ctrl+4)", views: ["git"] },
  { id: "terminal", label: "Terminal", icon: "terminals", tip: "Show or hide the shell terminals (Ctrl+5 or Ctrl+`)", views: [] },
  { id: "pipelines", label: "Pipelines", icon: "devops", tip: "Pipelines: the run-plan-all queue and the CI/CD runs of this branch (Ctrl+6)", views: ["queue", "cicd"] },
];
/** Views under More, after the rail in the Ctrl+<n> order (Ctrl+7, 8, 9). */
const MORE_VIEWS = ["plans", "flight", "activity"];
/** The member a group's rail item opens: the one shown last. */
const lastInGroup = new Map<string, string>();

function addTab(t: Tab, focus = true) {
  if (!tabs.has(t.id)) order.push(t.id);
  tabs.set(t.id, t);
  if (t.el.parentElement !== $("views")) $("views").append(t.el);
  t.el.classList.add("view");
  t.el.hidden = true;
  if (focus) showTab(t.id);
  else renderTabs();
}

function badges(t: Tab | undefined): HTMLElement[] {
  const b = t?.badge?.();
  if (!t || !b) return [];
  return [
    h("span", { class: `badge ${b.cls}`, ...(b.tip ? { title: b.tip } : {}), ...(t.id === "inbox" && b.cls === "warn" ? { id: "inbox-badge" } : {}) }, b.text),
    ...(b.extra ? [h("span", { class: `badge ${b.extra.cls}`, ...(b.extra.tip ? { title: b.extra.tip } : {}) }, b.extra.text)] : []),
  ];
}

function renderRail() {
  const rail = $("rail");
  if (!workspace) return rail.replaceChildren();
  const terminalOn = !shell.classList.contains("no-bottom");
  const items = RAIL.map((r) => {
    const on = r.id === "terminal" ? terminalOn : r.views.includes(activeTab);
    const el = h(
      "button",
      // Terminal is a toggle (the bottom panel), not a view: "on", never "active".
      { class: `tab rail-item ${on ? (r.id === "terminal" ? "on" : "active") : ""}`, title: r.tip, ...(r.id === "terminal" ? { "aria-pressed": String(on) } : { "aria-current": on ? "page" : "false" }) },
      h("span", { class: "rail-icon-wrap" }, icon(r.icon, "rail-icon"), ...r.views.flatMap((v) => badges(tabs.get(v)))),
      h("span", { class: "lbl" }, r.label),
    );
    el.dataset.tab = r.id;
    el.addEventListener("click", () => openRail(r));
    return el;
  });
  const more = h("button", { id: "btn-more", class: `tab rail-item ${MORE_VIEWS.includes(activeTab) ? "active" : ""}`, title: "More: Plans, Flight Log, Activity, commands, engine, skin", "aria-haspopup": "menu" }, h("span", { class: "rail-icon-wrap" }, icon("more", "rail-icon")), h("span", { class: "lbl" }, "More"));
  more.dataset.tab = "more";
  more.addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleMore(more);
  });
  rail.replaceChildren(...items, h("span", { class: "spacer" }), more);
}

function openRail(r: RailItem) {
  if (r.id === "terminal") return toggleTerminal();
  showTab(lastInGroup.get(r.id) ?? r.views[0]);
}

/** The tab strip: documents only (runs, terminals, files, the web panel), after the switch of
 *  a rail group with more than one view (Pipelines: Queue | CI/CD). */
function renderTabs() {
  renderRail();
  const bar = $("tabs");
  if (!workspace) return bar.replaceChildren();
  const docs = order
    .map((id) => tabs.get(id))
    .filter((t): t is Tab => !!t && !t.pinned)
    .map((t) => {
      const el = h(
        "button",
        { class: `tab ${activeTab === t.id ? "active" : ""} ${t.cls?.() ?? ""}`, title: t.tip },
        ...(t.icon ? [h("span", { class: "tab-icon" }, icon(t.icon, "tab-svg"))] : []),
        h("span", { class: "lbl" }, t.label),
        ...badges(t),
      );
      el.dataset.tab = t.id;
      const close = h("span", { class: "tab-close", title: "Close (Ctrl+W)" }, t.cls?.().includes("dirty") ? "●" : "×");
      close.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void closeTab(t.id);
      });
      el.append(close);
      el.addEventListener("click", () => showTab(t.id));
      return el;
    });
  const group = RAIL.find((r) => r.views.length > 1 && r.views.includes(activeTab));
  const sw = group
    ? [
        h(
          "div",
          { class: "view-switch", role: "tablist", "aria-label": group.label },
          ...group.views.map((id) => {
            const t = tabs.get(id);
            const b = h("button", { class: `view-switch-btn ${activeTab === id ? "active" : ""}`, role: "tab", "aria-selected": String(activeTab === id), title: t?.tip ?? id }, ...(t?.icon ? [icon(t.icon, "tab-svg")] : []), t?.label ?? id);
            b.dataset.view = id;
            b.addEventListener("click", () => showTab(id));
            return b;
          }),
        ),
      ]
    : [];
  // Only the document tabs scroll.
  const docBar = h("div", { class: "tabs-docs" }, ...docs);
  bar.replaceChildren(...sw, ...(sw.length && docs.length ? [h("span", { class: "tab-sep" })] : []), docBar);
  // No document and no switch: the strip takes no room.
  bar.classList.toggle("tabbar-empty", !docs.length && !sw.length);
  docBar.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function showTab(id: string) {
  const t = tabs.get(id);
  if (!t || !workspace) return;
  const prev = tabs.get(activeTab);
  if (prev && prev !== t) {
    prev.el.hidden = true;
    prev.hide?.();
  }
  for (const other of tabs.values()) if (other !== t && other.el !== t.el) other.el.hidden = true;
  activeTab = id;
  const group = RAIL.find((r) => r.views.length > 1 && r.views.includes(id));
  if (group) lastInGroup.set(group.id, id);
  t.el.hidden = false;
  $("welcome").hidden = true;
  t.show?.();
  renderTabs();
}

async function closeTab(id: string) {
  const t = tabs.get(id);
  if (!t || t.pinned) return;
  if (t.close && !(await t.close())) return;
  tabs.delete(id);
  order.splice(order.indexOf(id), 1);
  if (t.el !== $("view-editor")) t.el.remove();
  if (activeTab === id) {
    const rest = order.filter((x) => !tabs.get(x)?.pinned);
    showTab(rest.length ? rest[rest.length - 1] : "mission");
  } else renderTabs();
}

// ---- editor ----------------------------------------------------------------------------
const editors = new Editors($("view-editor"), () => renderTabs());
const tree = new FileTree($("tree"), (p) => void openFile(p), status, (p) => void openInEditor(p));
const isFile = (id: string) => id.startsWith("/");

function relPath(p: string) {
  return workspace && p.startsWith(`${workspace.root}/`) ? p.slice(workspace.root.length + 1) : p;
}

async function openFile(path: string) {
  try {
    await editors.open(path);
  } catch (e) {
    return status(`${relPath(path)}: ${errText(e)}`);
  }
  if (!tabs.has(path)) {
    addTab(
      {
        id: path,
        label: path.split("/").pop() ?? path,
        icon: "",
        tip: relPath(path),
        pinned: false,
        el: $("view-editor"),
        cls: () => (editors.isDirty(path) ? "dirty" : ""),
        show: () => {
          editors.activate(path);
          tree.setActive(path);
          requestAnimationFrame(() => editors.layout());
        },
        close: async () => {
          if (editors.isDirty(path) && !(await ask(`${relPath(path)} has unsaved changes. Close without saving?`, { title: "Colony", kind: "warning" }))) return false;
          editors.close(path);
          return true;
        },
      },
      true,
    );
  } else showTab(path);
}

async function saveActive() {
  if (!isFile(activeTab)) return;
  try {
    const p = await editors.save(activeTab);
    if (p) status(`Saved ${relPath(p)}`);
    if (p && p.endsWith("/settings.json") && !p.startsWith(`${workspace?.root}/`)) void loadSkin();
    void gitView.panel.refresh();
  } catch (e) {
    status(`Save failed: ${errText(e)}`);
  }
}

/** Hand `path` (default: the active file, else the folder) to the user's own editor. */
async function openInEditor(path?: string) {
  if (!workspace) return status("Open a folder first");
  const target = path ?? (isFile(activeTab) ? activeTab : workspace.root);
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
async function openSettings() {
  try {
    await openFile(await api.settingsEnsure());
    status("Colony settings: editor.command / editor.terminal; workspaces.<folder>.backend is remembered by the engine picker");
  } catch (e) {
    status(`Settings: ${errText(e)}`);
  }
}
$("btn-settings").addEventListener("click", () => void openSettings());

// ---- terminals (bottom) ----------------------------------------------------------------
const terminals = new Terminals($("term-tabs"), $("terms"), status);
$("term-tabs").querySelector(".tab-add")!.addEventListener("click", () => void terminals.create());

function toggleTerminal(force?: boolean) {
  const show = force ?? shell.classList.contains("no-bottom");
  shell.classList.toggle("no-bottom", !show);
  renderRail();
  if (show) {
    if (workspace && terminals.count === 0) void terminals.create();
    requestAnimationFrame(() => terminals.focus());
  }
  relayout();
  layoutChanged();
}

// ---- panels: the Explorer and the terminal dock ---------------------------------------
type Dock = "bottom" | "top" | "side";
const DOCK_LABEL: Record<Dock, string> = { bottom: "at the bottom", top: "at the top", side: "at the side" };
const dock = (): Dock => (shell.dataset.dock === "top" || shell.dataset.dock === "side" ? shell.dataset.dock : "bottom");
/** Set by the layout persistence: called after every panel change. */
let layoutChanged = () => {};

/** After a panel change: xterm and Monaco measure again (a moved terminal keeps its old
 *  columns and rows until fit() runs). */
function relayout() {
  requestAnimationFrame(() => {
    terminals.fitActive();
    centerTerms.get(activeTab)?.fit();
    editors.layout();
  });
}

function renderDock() {
  for (const b of $("term-tabs").querySelectorAll<HTMLElement>(".dock-group button")) {
    const on = b.dataset.dock === dock();
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  }
}

/** Put the terminal panel at the bottom, the top or the side (and show it). */
function setDock(d: Dock) {
  shell.dataset.dock = d;
  renderDock();
  if (shell.classList.contains("no-bottom")) toggleTerminal(true);
  else {
    relayout();
    layoutChanged();
  }
  status(`Terminal ${DOCK_LABEL[d]}`);
}

function toggleExplorer(force?: boolean) {
  const show = force ?? shell.classList.contains("no-side");
  shell.classList.toggle("no-side", !show);
  relayout();
  layoutChanged();
}

// Layout persistence (settings.json ui.layout): saved after every panel change (debounced),
// applied when the window opens. A size is saved only once a splitter set it.
const px = (name: string) => {
  const v = Number.parseFloat(shell.style.getPropertyValue(name));
  return Number.isFinite(v) ? Math.round(v) : null;
};
function layoutNow(): Required<{ [K in keyof LayoutSettings]: LayoutSettings[K] | null }> {
  return {
    terminalDock: dock(),
    terminalVisible: !shell.classList.contains("no-bottom"),
    explorerVisible: !shell.classList.contains("no-side"),
    explorerWidth: px("--side-w"),
    terminalHeight: px("--bottom-h"),
    terminalWidth: px("--term-w"),
  };
}
/** Put a saved layout on the window (no save back). */
function applyLayout(l: LayoutSettings) {
  shell.dataset.dock = l.terminalDock === "top" || l.terminalDock === "side" ? l.terminalDock : "bottom";
  shell.classList.toggle("no-bottom", l.terminalVisible === false);
  shell.classList.toggle("no-side", l.explorerVisible === false);
  const size = (name: string, v: number | undefined) => (typeof v === "number" && v > 0 ? shell.style.setProperty(name, `${v}px`) : shell.style.removeProperty(name));
  size("--side-w", l.explorerWidth);
  size("--bottom-h", l.terminalHeight);
  size("--term-w", l.terminalWidth);
  renderDock();
  renderRail();
  relayout();
}
async function loadLayout(): Promise<LayoutSettings> {
  const info = await api.settingsGet().catch(() => null);
  const l = ((info?.settings as { ui?: { layout?: LayoutSettings } } | null)?.ui?.layout ?? {}) as LayoutSettings;
  applyLayout(l);
  return l;
}
let layoutTimer = 0;
let layoutSaved: Promise<unknown> = Promise.resolve();
layoutChanged = () => {
  window.clearTimeout(layoutTimer);
  layoutTimer = window.setTimeout(() => {
    layoutSaved = api.settingsSetLayout(layoutNow()).catch((e) => status(`Layout: ${errText(e)}`));
  }, 400);
};

$("term-tabs").querySelector(".dock-group")!.addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("button[data-dock]");
  if (b?.dataset.dock) runAction(`dock:${b.dataset.dock}`);
});

/** A splitter drag: `size(dx, dy)` sets the panel size from the pointer offset. */
function splitter(el: HTMLElement, size: (dx: number, dy: number) => void) {
  el.addEventListener("pointerdown", (down) => {
    const move = (ev: PointerEvent) => size(ev.clientX - down.clientX, ev.clientY - down.clientY);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      terminals.fitActive();
      for (const v of centerTerms.values()) v.fit();
      editors.layout();
      layoutChanged();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}
const clamp = (lo: number, hi: number, v: number) => Math.round(Math.max(lo, Math.min(Math.max(lo, hi), v)));
splitter($("resizer"), (() => {
  let start = 0;
  $("resizer").addEventListener("pointerdown", () => {
    const r = $("bottom").getBoundingClientRect();
    start = dock() === "side" ? r.width : r.height;
  });
  return (dx: number, dy: number) => {
    const d = dock();
    if (d === "side") shell.style.setProperty("--term-w", `${clamp(240, window.innerWidth - 420, start - dx)}px`);
    else shell.style.setProperty("--bottom-h", `${clamp(80, window.innerHeight - 200, start + (d === "top" ? dy : -dy))}px`);
  };
})());
splitter($("side-resizer"), (() => {
  let start = 0;
  $("side-resizer").addEventListener("pointerdown", () => (start = $("side").getBoundingClientRect().width));
  return (dx: number) => shell.style.setProperty("--side-w", `${clamp(140, Math.min(640, window.innerWidth * 0.5), start + dx)}px`);
})());

// ---- center terminal tabs: interactive vendor CLI, queue runner ------------------------
const centerTerms = new Map<string, TermView>();
let termCounter = 0;
new ResizeObserver(() => centerTerms.get(activeTab)?.fit()).observe($("views"));

/** An agent in a terminal tab: listed under Agent runs, with its context sources strip. */
type TermAgent = { kind: "interactive" | "queue"; plan: string; backend: string; engine: string };

async function openTermTab(argv: string[], label: string, tip: string, icon: IconKind, agent?: TermAgent): Promise<{ id: string; view: TermView } | undefined> {
  const id = `term:${++termCounter}`;
  const el = h("div", { class: "term-center" });
  const pane = h("div", { class: "term-pane" });
  if (agent && workspace) el.append(new ContextStrip(workspace.root, agent.engine, (p) => void openInEditor(p)).el);
  el.append(h("div", { class: "term-wrap" }, pane));
  $("views").append(el);
  const view = new TermView(pane);
  centerTerms.set(id, view);
  addTab({
    id,
    label,
    icon,
    tip,
    pinned: false,
    el,
    cls: () => (view.exited ? "exited" : launches.termGate(id) ? "run-gate" : ""),
    badge: () => (launches.termGate(id) ? { text: "gate", cls: "warn" } : null),
    show: () =>
      requestAnimationFrame(() => {
        view.fit();
        view.focus();
      }),
    close: () => {
      view.dispose();
      centerTerms.delete(id);
      launches.dropTerm(id);
      return true;
    },
  });
  view.onExit = () => renderTabs();
  if (agent && workspace) launches.addTerm({ tabId: id, kind: agent.kind, plan: agent.plan, backend: agent.backend, root: workspace.root, label, view, el });
  if (agent?.kind === "interactive" && agent.engine === "claude") {
    // Claude Code has saved (or updated) the session by now: list it under Chats.
    const prevExit = view.onExit;
    view.onExit = (code) => {
      prevExit(code);
      void chats.refresh();
    };
  }
  try {
    await view.spawn(argv);
  } catch (e) {
    status(`${label}: ${errText(e)}`);
    return;
  }
  return { id, view };
}

/** Saved chat (session id) -> the terminal tab that resumed it. */
const chatTabs = new Map<string, string>();
/** Saved chats whose resume tab is still opening: a second click must not open another. */
const resuming = new Set<string>();

let confirmAction = (message: string, title: string) => ask(message, { title, kind: "info" });
let smokeDryRun = false;

// ---- cockpit host ----------------------------------------------------------------------
const controls = new RunControls(status);
const host: CockpitHost = {
  status,
  openRepoFile: (rel) => {
    if (!workspace) return;
    void openFile(rel.startsWith("/") ? rel : `${workspace.root}/${rel}`);
  },
  runPlan: async () => {
    if (!workspace) return status("Open a folder first");
    // The engine form is a dialog now (not in the Mission hero); Start in it runs the plan.
    controls.openDialog({ plan: snapshot.activePlanFile });
  },
  runQueue: async () => {
    if (!workspace) return status("Open a folder first");
    const engine = controls.backend.value;
    // Driver protocol 1.2.0+: the queue runs as a driver run (gates in the Inbox, the queue
    // in Mission). Older or unknown engine, or the smoke's --dry-run: a terminal tab.
    const mode = smokeDryRun
      ? { driver: false, protocol: null, note: "--dry-run runs in a terminal tab" }
      : await api.queueMode().catch((e) => ({ driver: false, protocol: null, note: `Queue mode: ${errText(e)}` }));
    const where = mode.driver
      ? "as an agent run; its gates appear in the Inbox"
      : "in a terminal tab; answer its numbered gates there";
    const ok = await confirmAction(`Start agent-kit run-plan-all with ${engine} in ${workspace.name}? It runs the HANDOFF queue ${where}. It never runs /git-prod.`, "Run queue");
    if (!ok) return status("Queue run not started");
    if (mode.driver) {
      try {
        const run = await runs.start({ backend: engine, maxTicks: 1, command: "run-plan-all", model: controls.model.value.trim() || undefined });
        return status(`Queue run #${run.id} started in ${run.name} (${run.backend})`);
      } catch (e) {
        return status(`Run queue: ${errText(e)}`);
      }
    }
    try {
      const l = await api.termLaunch({ kind: "run-plan-all", engine, model: controls.model.value.trim(), dryRun: smokeDryRun });
      status([mode.note, l.note].filter(Boolean).join(" · "));
      return openTermTab(l.argv, l.label, l.argv.join(" "), "queue", { kind: "queue", plan: "", backend: engine, engine });
    } catch (e) {
      status(`Run queue: ${errText(e)}`);
    }
  },
  interactive: async (prompt, why) => {
    if (!workspace) return status("Open a folder first");
    const engine = controls.backend.value;
    if (prompt) {
      const ok = await confirmAction(`${why ? `${why}\n\n` : ""}Open your agent (${engine}) in a terminal tab with ${prompt}? It runs on your own login.`, "Ask agent");
      if (!ok) return status("Agent not opened");
    }
    try {
      const l = await api.termLaunch({ kind: "interactive", engine, model: controls.model.value.trim(), prompt });
      if (l.note) status(l.note);
      const vendor = l.label.split(" ")[0];
      return openTermTab(l.argv, l.label, `${l.argv.join(" ")}\n(the vendor CLI, unmodified, on your login; Colony passes no credentials)`, "terminals", { kind: "interactive", plan: promptPlan(prompt), backend: vendor, engine: vendor });
    } catch (e) {
      status(`Open interactive: ${errText(e)}`);
    }
  },
  resumeChat: async (id, title) => {
    if (!workspace) return status("Open a folder first");
    const open = chatTabs.get(id);
    const openView = open ? centerTerms.get(open) : undefined;
    if (open && openView && tabs.has(open) && !openView.exited) {
      showTab(open);
      return { id: open, view: openView };
    }
    if (resuming.has(id)) return;
    resuming.add(id);
    try {
      const l = await api.termLaunch({ kind: "interactive", engine: "claude", resume: id });
      if (l.note) status(l.note);
      const label = !title ? l.label : title.length > 32 ? `${title.slice(0, 31)}…` : title;
      const t = await openTermTab(l.argv, label, `${title || "Untitled chat"}\n${l.argv.join(" ")}\n(the vendor CLI, unmodified, on your login; Colony passes no credentials)`, "terminals", { kind: "interactive", plan: "", backend: "claude", engine: "claude" });
      if (t) chatTabs.set(id, t.id);
      return t;
    } catch (e) {
      status(`Resume chat: ${errText(e)}`);
    } finally {
      resuming.delete(id);
    }
  },
  showTab,
  focusRun: (runId) => {
    const run = runs.runs.get(runId);
    if (!run) return;
    if (!tabs.has(`run:${runId}`)) openRunTab(run);
    else showTab(`run:${runId}`);
  },
  copy: (text, what) => {
    void copyText(text).then((ok) => status(ok ? `Copied ${what}` : `Could not copy ${what}`));
  },
  workspaceRoot: () => workspace?.root ?? "",
  installKit: async () => {
    if (!workspace) return status("Open a folder first");
    const argv = ["npx", "@dadado/agent-kit-cli@latest", "install"];
    const ok = await confirmAction(`Run ${argv.join(" ")} in ${workspace.name}? It writes the kit's files (.cursor/, AGENTS.md, ...) into this folder and asks its own questions in the terminal tab.`, "Install Agent Kit");
    if (!ok) return status("Agent Kit install not started");
    toggleTerminal(true);
    await terminals.create(argv, "agent-kit install");
    status("Agent Kit install runs in the terminal below; Mission lists the readiness checks once it is done");
  },
  retryMc: () => void startMc(),
  mcLogPath: () => mcLog,
  showMcLog: () => {
    if (!workspace || !mcLog) return status("No Mission Control server log yet");
    toggleTerminal(true);
    void terminals.create(["tail", "-n", "200", "-F", mcLog], "Mission Control log");
  },
};


// ---- views -----------------------------------------------------------------------------
const mission = new MissionView(host, controls);
const plans = new PlansView(host);
const queue = new QueueView(host);
const flight = new FlightLogView(host);
const activity = new ActivityView(host);
let inboxCount = { gates: 0, attention: 0 };
const inbox = new InboxView(host, (gates, attention) => {
  inboxCount = { gates, attention };
  renderTabs();
});
// A new gate: the window title counter and an OS notification; a click on it opens the
// Inbox on that gate.
const alerts = new GateAlerts((key) => {
  if (!workspace) return;
  showTab("inbox");
  inbox.reveal(key);
});
alerts.showing = (g) => activeTab === g.tabId || activeTab === "inbox";
// The omarchy-shell bar widget reads this window's folder, open gates and live runs.
const pushShellStatus = publishShellStatus(() => workspace?.root ?? null);
// Terminal tabs carry a gate marker while their output shows an open HITL_GATE line.
launches.on(() => renderTabs());
let reviewCount = 0;
const reviewView = new ReviewView(
  $("view-review"),
  (n) => {
    reviewCount = n;
    renderTabs();
  },
  (p) => void openFile(p),
  status,
);
// Ship lane buttons only open approval cards (host allowlist kinds); Approve runs them.
const gitView = new GitView(status, () => void tree.refresh(), host.copy, {
  request: (a, what) =>
    void hostApi.local(a.kind, a.args).then(
      (id) => {
        status(`${what}: approve it on its card under Requests`);
        requests.reveal(id);
      },
      (e) => status(errText(e)),
    ),
  copy: host.copy,
  openEngine: () => showEngine(),
});
// Host requests: approval cards for an agent's git / forge actions, the PR list, CI/CD.
// An approved request ran gh (a denied one did not): reload the PR list and the working tree.
const requests = new RequestsSection(status, (_r, d) => {
  if (d.outcome !== "denied") gitView.reload();
});
gitView.addSections(requests, new PullRequestsSection(status, (id) => requests.reveal(id)));
const cicd = new CicdView(status);
inbox.addSection(() => inboxRequests(() => showTab("git")));
hostRequests.on((fresh) => {
  renderTabs();
  inbox.invalidate();
  if (fresh.length) status(`Host request: ${fresh[0].summary}${fresh[0].reason ? ` (${fresh[0].reason})` : ""}: approve or deny it in the Git tab`);
});

/** Gates and attention items are two counts: a gate waits for an answer, attention does not. */
function inboxBadge(): ReturnType<NonNullable<Tab["badge"]>> {
  const { gates, attention } = inboxCount;
  const att = attention ? { text: String(attention), cls: "muted", tip: `${attention} attention item(s)` } : undefined;
  if (gates) return { text: String(gates), cls: "warn", tip: `${gates} gate(s) wait for Ground Control`, extra: att };
  return att ?? null;
}

function pinViews() {
  const pin = (id: string, label: string, icon: IconKind, tip: string, el: HTMLElement, v: { show(): void; hide(): void }, badge?: Tab["badge"]) =>
    addTab({ id, label, icon, tip, pinned: true, el, show: () => v.show(), hide: () => v.hide(), badge }, false);
  pin("mission", "Mission", "current-mission", "Mission: the active plan, what needs you, runs, queue", mission.el, mission);
  pin("inbox", "Inbox", "inbox", "Inbox: live gates from every run, attention items, gate exits", inbox.el, inbox, () => inboxBadge());
  pin(
    "review",
    "Review",
    "review",
    "Per-tick review of agent runs",
    $("view-review"),
    { show: () => requestAnimationFrame(() => reviewView.layout()), hide: () => {} },
    () => (reviewCount ? { text: String(reviewCount), cls: "" } : null),
  );
  pin("git", "Git", "git", "Git: host requests, pull requests, branch flow, working tree, commit, push", gitView.el, gitView, () =>
    hostRequests.count ? { text: String(hostRequests.count), cls: "warn" } : null,
  );
  pin("queue", "Queue", "queue", "run-plan-all queue", queue.el, queue);
  pin("cicd", "CI/CD", "devops", "CI/CD: workflow runs of this branch and the open pull requests, rerun failed jobs", cicd.el, cicd);
  pin("plans", "Plans", "plans", "Plans and backlog (Mission Control snapshot)", plans.el, plans);
  pin("flight", "Flight Log", "field-report", "Flight log: residuals, warnings, tick logs", flight.el, flight);
  pin("activity", "Activity", "activity", "Saved chats, recent activity and health checks", activity.el, activity);
}

// Agent tabs: every run opens (and focuses) its own tab with the transcript.
const agentTabs = new Map<number, AgentTab>();
function openRunTab(run: Run) {
  let t = agentTabs.get(run.id);
  if (!t) {
    t = new AgentTab(run, {
      openRepoFile: (rel, root) => {
        if (workspace && root === workspace.root) host.openRepoFile(rel);
        else status(`${rel} is in ${root}, outside the opened folder`);
      },
      showReview: (rv: TickReview) => {
        showTab("review");
        void reviewView.show(rv, rv.files[0] ?? { status: "M", path: "" }).catch(() => {});
      },
      status,
      openInEditor: (p) => void openInEditor(p),
    });
    agentTabs.set(run.id, t);
  }
  const tab = t;
  addTab({
    id: `run:${run.id}`,
    label: `#${run.id} ${run.command === "run-plan-all" ? "queue" : run.plan ? run.plan.replace(/\.plan\.md$/, "") : run.name}`,
    icon: run.command === "run-plan-all" ? "queue" : "play",
    tip: `${run.cmd}\n${run.root}`,
    pinned: false,
    el: tab.el,
    cls: () => (run.gate ? "run-gate" : run.running ? "run-live" : "exited"),
    badge: () => (run.gate ? { text: "gate", cls: "warn" } : null),
    show: () => {
      if (run.gate) requestAnimationFrame(() => tab.scrollToGate());
    },
    close: async () => {
      if (run.running && !(await ask(`Run #${run.id} is still running. Kill it?`, { title: "Colony", kind: "warning" }))) return false;
      if (run.running) await runs.kill(run.id).catch(() => {});
      tab.dispose();
      agentTabs.delete(run.id);
      return true;
    },
  });
}
runs.on((c) => {
  if (c.kind === "state" && runs.runs.has(c.run.id) && !agentTabs.has(c.run.id) && c.run.running) openRunTab(c.run);
  if (c.kind === "state" || c.kind === "gate") {
    const t = tabs.get(`run:${c.run.id}`);
    if (t && c.run.plan && c.run.command === "run-plan") t.label = `#${c.run.id} ${c.run.plan.replace(/\.plan\.md$/, "")}`;
    renderTabs();
  }
});

// ---- More menu (rail) ------------------------------------------------------------------
const menu = $("more-menu");
function toggleMore(anchor: HTMLElement) {
  if (!menu.hidden) return (menu.hidden = true);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${r.right + 6}px`;
  menu.style.right = "auto";
  menu.style.top = "auto";
  menu.style.bottom = `${Math.max(8, window.innerHeight - r.bottom)}px`;
  menu.hidden = false;
}
window.addEventListener("click", () => (menu.hidden = true));
menu.addEventListener("click", (ev) => {
  const el = ev.target as HTMLElement;
  menu.hidden = true;
  if (el.dataset.cmd) runAction(el.dataset.cmd);
  else if (el.dataset.more === "title-bar") void setTitleBar(el.dataset.mode === "custom" ? "custom" : "native");
  else if (el.dataset.more === "skin") {
    const next = el.dataset.skin as Skin;
    void setSkin(next).then(
      () => status(`Skin: ${SKINS.find((x) => x.id === next)?.label} (saved in settings.json)`),
      (e) => status(`Skin: ${errText(e)}`),
    );
  }
});

// ---- title bar (settings.json ui.titleBar, applied when the window opens) --------------
/** The mode this window opened with, and the saved one (they differ until a restart).
 *  On a tiling window manager the window is always native (settings::effective_title_bar):
 *  the choice is not offered and a saved `custom` is ignored. */
const titleBar = { current: "native" as "native" | "custom", saved: "native" as "native" | "custom", tiling: null as string | null };

function renderTitleBarMenu() {
  for (const el of menu.querySelectorAll<HTMLElement>("[data-title-bar-menu]")) el.hidden = !!titleBar.tiling;
  for (const b of menu.querySelectorAll<HTMLElement>('button[data-more="title-bar"]')) {
    const mode = b.dataset.mode;
    const on = mode === titleBar.saved;
    b.classList.toggle("on", on);
    const label = mode === "custom" ? "Custom (Colony draws it)" : "Native";
    b.textContent = `${on ? "✓ " : ""}${label}${on && mode !== titleBar.current ? ", after a restart" : ""}`;
  }
}

async function setTitleBar(mode: "native" | "custom") {
  try {
    await api.settingsSetTitleBar(mode);
  } catch (e) {
    return status(`Title bar: ${errText(e)}`);
  }
  titleBar.saved = mode;
  renderTitleBarMenu();
  status(mode === titleBar.current ? `Title bar: ${mode} (saved in settings.json)` : `Title bar: ${mode}, saved in settings.json; it applies when Colony starts again.`);
}

/** Custom mode: the top bar drags the window (double-click maximizes), the menus open as
 *  native popups under their buttons, and the window controls sit at the right. */
function applyTitleBar(info: StartupInfo) {
  titleBar.current = info.titleBar === "custom" ? "custom" : "native";
  titleBar.tiling = info.tilingWm;
  document.documentElement.dataset.titleBar = titleBar.current;
  if (titleBar.current !== "custom") return;
  const top = $("top");
  top.setAttribute("data-tauri-drag-region", "deep");
  const menus = $("top-menus");
  menus.replaceChildren(
    ...menuSpec.menus.map((m, i) => {
      const b = h("button", { class: "top-menu", "aria-haspopup": "menu" }, m.label);
      b.addEventListener("click", () => {
        const r = b.getBoundingClientRect();
        void api.menuPopup(i, r.left, r.bottom).catch((e) => status(`Menu: ${errText(e)}`));
      });
      return b;
    }),
  );
  menus.hidden = false;
  const controls = $("win-controls");
  controls.hidden = false;
  const win = getCurrentWindow();
  const max = controls.querySelector<HTMLButtonElement>(".win-max")!;
  const syncMax = async () => {
    const on = await win.isMaximized().catch(() => false);
    max.title = on ? "Restore" : "Maximize";
    max.setAttribute("aria-label", max.title);
    max.classList.toggle("on", on);
  };
  controls.querySelector(".win-min")!.addEventListener("click", () => void win.minimize().catch((e) => status(`Minimize: ${errText(e)}`)));
  max.addEventListener("click", () => void win.toggleMaximize().catch((e) => status(`Maximize: ${errText(e)}`)));
  controls.querySelector(".win-close")!.addEventListener("click", () => void closeWindow());
  void win.onResized(() => void syncMax());
  void syncMax();
}

// ---- actions: the native menu bar (src/menu.json) and the More menu run these ----------
const ACTIONS: Record<string, () => unknown> = {
  "open-folder": () => pickFolder(),
  "run-elsewhere": () => controls.startElsewhere(),
  "open-in-editor": () => openInEditor(),
  settings: () => openSettings(),
  "close-window": () => closeWindow(),
  terminal: () => toggleTerminal(),
  "dock:bottom": () => setDock("bottom"),
  "dock:top": () => setDock("top"),
  "dock:side": () => setDock("side"),
  explorer: () => toggleExplorer(),
  "quick-open": () => showQuick(),
  commands: () => palette.show(),
  web: () => openWebPanel(),
  refresh: () => snapshot.refresh(),
  "run-plan": () => host.runPlan(),
  "run-queue": () => host.runQueue(),
  interactive: () => host.interactive(),
  "new-terminal": () => {
    toggleTerminal(true);
    return terminals.create();
  },
  engine: () => showEngine(),
  about: () => openAboutPanel(status),
  omarchy: () => openOmarchyPanel(status),
};

/** `view:<rail item or More view>`: the rail item's own behaviour (a group opens its last view). */
function viewAction(id: string): (() => unknown) | null {
  const v = id.slice("view:".length);
  const r = RAIL.find((x) => x.id === v && x.views.length);
  if (r) return () => (workspace ? openRail(r) : status("Open a folder first"));
  if (MORE_VIEWS.includes(v)) return () => (workspace ? showTab(v) : status("Open a folder first"));
  return null;
}

function actionFor(id: string): (() => unknown) | null {
  return id.startsWith("view:") ? viewAction(id) : (ACTIONS[id] ?? null);
}

function runAction(id: string): boolean {
  const run = actionFor(id);
  if (!run) {
    status(`Unknown action: ${id}`);
    return false;
  }
  try {
    void Promise.resolve(run()).catch((e) => status(`${id}: ${errText(e)}`));
  } catch (e) {
    status(`${id}: ${errText(e)}`);
  }
  return true;
}

/** File → Close window: the same unsaved-files question as a folder switch. */
async function closeWindow() {
  const dirty = editors.paths().filter((p) => editors.isDirty(p));
  if (dirty.length && !(await ask(`${dirty.length} file(s) have unsaved changes. Close Colony anyway?`, { title: "Colony", kind: "warning" }))) return;
  await getCurrentWindow().close();
}

/** Every item id of the native menu bar, in menu order. */
const menuIds = () => menuSpec.menus.flatMap((m) => m.items.flatMap((i) => ("id" in i && i.id ? [i.id] : [])));
const unbound = menuIds().filter((id) => !actionFor(id));
if (unbound.length) console.error(`colony: menu items without an action: ${unbound.join(", ")}`);
void listen<string>("colony-menu", (ev) => {
  menu.hidden = true;
  runAction(ev.payload);
}).catch((e) => status(`Menu bar: ${errText(e)}`));

function showEngine() {
  void openEnginePanel((m) => {
    status(m);
    void refreshEngineBadge($("st-engine"));
    controls.refreshChoices();
  });
}
$("st-engine").addEventListener("click", showEngine);

// ---- command palette (Ctrl+Shift+P, More → Commands) -----------------------------------
const palette = new CommandPalette({
  status,
  hasFolder: () => !!workspace,
  interactive: (prompt, why) => host.interactive(prompt, why),
  showEngine,
  // The Claude Code section: `claude` itself, not the engine choice (which may be codex).
  openClaude: async () => {
    if (!workspace) return status("Open a folder first");
    try {
      const l = await api.termLaunch({ kind: "interactive", engine: "claude" });
      return openTermTab(l.argv, l.label, `${l.argv.join(" ")}\n(the vendor CLI, unmodified, on your login; Colony passes no credentials)`, "terminals", { kind: "interactive", plan: "", backend: "claude", engine: "claude" });
    } catch (e) {
      status(`Open Claude: ${errText(e)}`);
    }
  },
});
document.body.append(palette.el);

function renderSkinMenu() {
  // The Omarchy skin and integration exist only where Omarchy is installed.
  const integration = menu.querySelector<HTMLElement>('button[data-cmd="omarchy"]');
  if (integration) integration.hidden = !omarchyDetected();
  for (const b of menu.querySelectorAll<HTMLElement>('button[data-more="skin"]')) {
    if (b.dataset.skin === "omarchy") b.hidden = !omarchyDetected();
    const on = b.dataset.skin === skin();
    b.classList.toggle("on", on);
    b.textContent = `${on ? "✓ " : ""}${SKINS.find((x) => x.id === b.dataset.skin)?.label}`;
  }
}
let frameKitSkin = "";
onSkin((s) => {
  renderSkinMenu();
  // The web panel follows: reload it with the matching kit skin (an Omarchy theme switch
  // keeps the panel on Bare Metal, so it does not reload then).
  const kit = kitSkinValue(s);
  if (mcFrame.getAttribute("src") && kit !== frameKitSkin) mcFrame.src = webPanelUrl();
  frameKitSkin = kit;
});

/** The web panel URL; `colony-skin` makes the frame hook select the matching kit skin. */
function webPanelUrl() {
  const u = new URL(mcUrl);
  u.searchParams.set("colony-skin", kitSkinValue(skin()));
  return u.toString();
}

// Sandboxed (security review 2026-10-24, finding 3): the panel keeps its own origin
// (skin storage, clipboard) and scripts, but may not navigate Colony's window.
const mcFrame = h("iframe", { id: "mc", title: "Mission Control (web panel)", allow: "clipboard-read; clipboard-write", sandbox: "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads" });
function openWebPanel() {
  if (!workspace) return;
  if (!mcUrl) return status("Mission Control server is not running");
  if (!mcFrame.getAttribute("src")) mcFrame.src = webPanelUrl();
  if (!tabs.has("web")) addTab({ id: "web", label: "Mission Control (web)", icon: "monitor", tip: `The kit's web panel, ${mcUrl} (fallback; actions copy unless allowlisted)`, pinned: false, el: h("div", { class: "web-view" }, mcFrame) });
  else showTab("web");
}

// ---- status bar: Mission Control feed --------------------------------------------------
function renderFeed() {
  const f = snapshot.feed;
  const el = $("st-mc");
  if (!workspace) return (el.textContent = "");
  const v = snapshot.data?.dashboardDataVersion ? ` · data ${snapshot.data.dashboardDataVersion}` : "";
  el.textContent = f.error && !snapshot.data ? "Mission Control: failed" : `Mission Control ${f.connected ? "● live" : "○ offline"}${f.at ? ` · ${ago(f.at)}` : ""}${v}`;
  el.title = [f.detail, f.error ?? "", mcUrl, `${f.updates} live updates`].filter(Boolean).join("\n");
  el.classList.toggle("bad", !!f.error && !snapshot.data);
}
snapshot.on((why) => {
  renderFeed();
  if (why === "data") renderTabs();
});
setInterval(renderFeed, 5000);
// Back from the agent or a terminal elsewhere: the readiness report may have changed.
window.addEventListener("focus", () => void readiness.load(2000));

// ---- quick open ------------------------------------------------------------------------
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
    if (lf.indexOf(q) < 0) continue;
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
const hideQuick = () => ($("quick").hidden = true);
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

// ---- workspace -------------------------------------------------------------------------
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
$("tree-refresh").replaceChildren(icon("refresh", "btn-icon"));
$("tree-refresh").setAttribute("aria-label", "Refresh the Explorer");
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
  // Files, terminal tabs and the web panel belong to the folder; agent runs keep their
  // tabs (a run may be in another folder, and closing one would kill it).
  for (const id of [...order]) {
    const t = tabs.get(id);
    if (!t || t.pinned || id.startsWith("run:")) continue;
    centerTerms.get(id)?.dispose();
    centerTerms.delete(id);
    tabs.delete(id);
    order.splice(order.indexOf(id), 1);
    if (t.el !== $("view-editor")) t.el.remove();
  }
  document.getElementById("run-dialog")?.remove();
  editors.closeAll();
  terminals.closeAll();
  snapshot.reset();
  palette.reset();
  chatTabs.clear();
  resuming.clear();
  chats.reset();
  void chats.refresh();
  // The first-run missions (no kit, readiness checks) render from the folder's own files,
  // before and without the Mission Control server.
  readiness.reset(workspace.root, workspace.hasKit);
  void readiness.load();
  mcUrl = "";
  mcOrigin = "";
  mcLog = "";
  mcFrame.removeAttribute("src");
  alerts.setBase(`${workspace.name} · Colony`);
  // The folder name never truncates; its parent path ellipsizes (full path in the title).
  const parent = workspace.root.slice(0, workspace.root.length - workspace.name.length);
  $("ws-name").replaceChildren(h("span", { class: "ws-parent" }, parent), h("strong", { class: "ws-leaf" }, workspace.name));
  $("ws-name").title = workspace.root;
  $("st-ws").textContent = workspace.name;
  $("welcome").hidden = true;
  shell.classList.remove("no-folder");
  showTab("mission");
  await tree.setRoot(workspace.root);
  await controls.loadWorkspace();
  if (!shell.classList.contains("no-bottom")) void terminals.create();
  pushShellStatus();
  await startMc();
}

/**
 * Start the folder's Mission Control server (or reach the running one) and connect the
 * snapshot feed. Also the Retry of the "Waiting for the Mission Control server" state.
 */
async function startMc() {
  if (!workspace) return;
  const root = workspace.root;
  $("st-mc").textContent = "Mission Control: starting…";
  snapshot.feed.error = null;
  snapshot.feed.detail = "starting";
  for (const v of [mission, plans, queue, flight, activity]) v.invalidate();
  try {
    const mc = await api.dashboardStart();
    if (workspace?.root !== root) return;
    mcUrl = mc.url;
    mcOrigin = new URL(mc.url).origin;
    mcLog = mc.logPath;
    $("st-mc").title = `${mc.servePath}\nengine: ${mc.engine}\nlog: ${mc.logPath}`;
    void refreshEngineBadge($("st-engine"));
    await snapshot.connect();
  } catch (e) {
    if (workspace?.root !== root) return;
    // A server that never listened names its log in the error.
    mcLog = /log: (\S+\.log)/.exec(errText(e))?.[1] ?? mcLog;
    snapshot.feed.error = errText(e);
    renderFeed();
    for (const v of [mission, plans, queue, flight, activity]) v.invalidate();
    status(`Mission Control: ${errText(e)}`);
  }
}

// Mission Control web panel action seam (src-tauri/src/lib.rs hook, src/mcactions.ts
// allowlist): the frame offers each copy record here first; `handled: false` makes the
// frame copy as before.
type McReply = { handled: boolean; ok?: boolean; message?: string };
let confirmMcRun = async (plan: string | null) => {
  const engine = controls.backend.value;
  const named = plan ? ` Mission Control named ${plan}; agent-kit run-plan runs the folder's active plan.` : "";
  return ask(`Start an Agent run of the active plan in ${workspace?.name ?? "this folder"} with ${engine}?${named}`, { title: "Mission Control", kind: "info" });
};
async function hostMcAction(record: McRecord): Promise<McReply> {
  const d = decide(record);
  if (d.action === "open-file" && workspace) {
    const abs = `${workspace.root}/${d.path}`;
    try {
      await openFile(abs);
      return editors.active === abs ? { handled: true, message: `Opened ${d.path} in Colony` } : { handled: false };
    } catch {
      return { handled: false };
    }
  }
  if (d.action === "run-plan" && workspace) {
    void confirmMcRun(d.plan).then(async (yes) => {
      if (!yes) return status("Mission Control: run not started");
      await controls.start();
    });
    return { handled: true, message: "Confirm the run in Colony" };
  }
  // Only the run the Ship lane itself names (security review 2026-10-24, finding 7): a
  // script in the frame cannot fill the Requests list with arbitrary run ids.
  if (d.action === "rerun-run" && workspace && d.run === snapshot.data?.shipLane?.remote?.tagCi?.runId) {
    try {
      const id = await hostApi.local("rerun-checks", { run: d.run });
      showTab("git");
      requests.reveal(id);
      return { handled: true, message: `Approve the rerun of run ${d.run} on its card in Git` };
    } catch (e) {
      status(`Mission Control: ${errText(e)}`);
      return { handled: false };
    }
  }
  const where = record.destination === "terminal" ? "paste it in a Colony terminal (Ctrl+Shift+V)" : `paste it in the ${record.destination || "target"}`;
  status(`Mission Control copied ${record.subject || "text"}: ${where}`);
  return { handled: false };
}
window.addEventListener("message", (ev) => {
  if (!mcOrigin || ev.origin !== mcOrigin || ev.source !== mcFrame.contentWindow || ev.data?.colony !== "mc-action") return;
  const port = ev.ports[0];
  const a = ev.data.action ?? {};
  const record: McRecord = { kind: String(a.kind ?? ""), text: String(a.text ?? ""), subject: String(a.subject ?? ""), destination: String(a.destination ?? "") };
  void hostMcAction(record).then(
    (reply) => port?.postMessage(reply),
    () => port?.postMessage({ handled: false }),
  );
});

/** COLONY_SMOKE: the kit skin the web panel frame shows (data-dashboard-skin). */
function frameSkinNow(): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 3000);
    const onMsg = (ev: MessageEvent) => {
      if (ev.origin !== mcOrigin || ev.data?.colony !== "mc-smoke-skin-result") return;
      clearTimeout(timer);
      window.removeEventListener("message", onMsg);
      resolve(ev.data.skin ?? null);
    };
    window.addEventListener("message", onMsg);
    mcFrame.contentWindow?.postMessage({ colony: "mc-smoke-skin" }, mcOrigin);
  });
}

/** COLONY_SMOKE: run `perform()` inside the web panel frame and wait for its result. */
function mcPerformInFrame(action: Record<string, string>): Promise<unknown> {
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
    mcFrame.contentWindow?.postMessage({ colony: "mc-smoke-perform", id, action }, mcOrigin);
  });
}

// ---- keyboard --------------------------------------------------------------------------
window.addEventListener(
  "keydown",
  (ev) => {
    if (!ev.ctrlKey || ev.altKey || ev.metaKey) return;
    const inTerm = terminals.hasFocus() || !!centerTerms.get(activeTab)?.hasFocus();
    const key = ev.key.toLowerCase();
    let handled = true;
    if (ev.code === "Backquote") toggleTerminal(!terminals.hasFocus());
    else if (key === "s" && !ev.shiftKey) void saveActive();
    else if (key === "o" && !ev.shiftKey && !inTerm) runAction("open-folder");
    else if (key === "p" && !ev.shiftKey && !inTerm) runAction("quick-open");
    else if (key === "p" && ev.shiftKey) runAction("commands");
    else if (key === "w" && !ev.shiftKey && !inTerm && !tabs.get(activeTab)?.pinned) void closeTab(activeTab);
    else if (key === "e" && ev.shiftKey) runAction("open-in-editor");
    else if (key === "t" && ev.shiftKey) runAction("new-terminal");
    else if (!ev.shiftKey && !inTerm && /^[1-9]$/.test(key) && workspace) {
      // Ctrl+1..6: the rail (5 toggles the terminal); Ctrl+7..9: Plans, Flight Log, Activity.
      const n = Number(key) - 1;
      if (n < RAIL.length) openRail(RAIL[n]);
      else showTab(MORE_VIEWS[n - RAIL.length]);
    }
    else handled = false;
    if (handled) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  },
  true,
);

// No native WebKit context menu (Back / Reload / Open Frame) over the app or a terminal:
// it can navigate the window away. Text fields and the editor keep theirs (copy / paste),
// and handlers that open their own menu (the Explorer) run before this one.
window.addEventListener("contextmenu", (ev) => {
  const t = ev.target as HTMLElement | null;
  if (ev.defaultPrevented || t?.closest("input, textarea, [contenteditable='true'], .monaco-editor")) return;
  ev.preventDefault();
});

window.addEventListener("beforeunload", (ev) => {
  if (editors.paths().some((p) => editors.isDirty(p))) ev.preventDefault();
});

// ---- code-path smoke (COLONY_SMOKE=<log>): no human input, every step logged -------------
async function runSmoke(root: string, info: StartupInfo, bootLayout: LayoutSettings) {
  const log = (step: string, ok: boolean, detail: unknown = "") => api.smokeLog(JSON.stringify({ t: new Date().toISOString(), step, ok, detail }));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (cond: () => boolean, ms: number) => {
    for (let i = 0; i < ms / 200 && !cond(); i++) await wait(200);
    return cond();
  };
  const view = (id: string) => tabs.get(id)!.el;
  // Optional screenshots: log a `pause` step and wait for <root>/.git/colony-shot-<name> (the
  // runner takes a read-only grim capture of this window, then writes that file).
  const shot = async (name: string) => {
    if (!info.smokeShots) return;
    await log("pause", true, name);
    for (let i = 0; i < 75; i++) {
      await wait(200);
      if (await api.readTextFile(`${root}/.git/colony-shot-${name}`).then(() => true, () => false)) return;
    }
  };
  try {
    await log("workspace", true, root);
    // The layout this window opened with is the one settings.json had (a previous run's).
    {
      const now = layoutNow();
      const sideW = Math.round($("side").getBoundingClientRect().width);
      const want = Object.entries(bootLayout) as [keyof LayoutSettings, unknown][];
      const mismatch = want.filter(([k, v]) => now[k] !== v).map(([k, v]) => `${k}: saved ${v}, applied ${now[k]}`);
      const widthOk = bootLayout.explorerWidth === undefined || bootLayout.explorerVisible === false || sideW === bootLayout.explorerWidth;
      await log("layout-boot", !mismatch.length && widthOk, { saved: bootLayout, applied: now, explorerWidth: sideW, mismatch });
    }
    await log("tree", $("tree").querySelectorAll(".tree-row").length > 0, `${$("tree").querySelectorAll(".tree-row").length} rows`);
    // Native views from the kit server's snapshot (GET + SSE through the Rust proxy).
    const gotData = await until(() => !!snapshot.data, 20000);
    const d = snapshot.data ?? {};
    await log("mc-snapshot", gotData && typeof d.dashboardDataVersion === "string", { version: d.dashboardDataVersion, plans: snapshot.plans().length, branch: snapshot.git.branch, feed: snapshot.feed });
    // Managed engine (engine.rs): which engine the Mission Control server runs on.
    const eng = await api.engineStatus();
    const viaEngine = eng.source === "env" || eng.source === "managed";
    await log("engine", !!eng.dashboard && (!viaEngine || eng.dashboard === eng.label), { source: eng.source, label: eng.label, dashboard: eng.dashboard, version: eng.manifest?.version ?? null, node: eng.node, nodeVersion: eng.nodeVersion, nodeSource: eng.nodeSource, agentRuns: info.agentKit });
    showEngine();
    await until(() => !!document.querySelector("#engine-panel .engine-actions"), 5000);
    const panel = document.querySelector("#engine-panel")?.textContent ?? "";
    await log("engine-panel", panel.includes(eng.label) && panel.includes("Install Node runtime"), panel.slice(0, 240));
    await shot("engine");
    closeEnginePanel();
    showTab("mission");
    await wait(300);
    const hero = view("mission").querySelector(".hero:not(.first-run)")?.textContent ?? "";
    // A folder without the kit, without a readiness report or with open essential checks
    // (and no active plan) opens on the First run card instead of the hero.
    const firstRun = view("mission").querySelector<HTMLElement>(".first-run");
    const firstRunOk = !!firstRun && !!firstRun.querySelector('[data-act="onboard"], [data-act="install-kit"]');
    const heroOk = !!snapshot.git.branch && hero.includes(String(snapshot.git.branch)) && !!view("mission").querySelector('[data-act="run-plan"]');
    await log("view-mission", activeTab === "mission" && (heroOk || firstRunOk), { hero: hero.slice(0, 160), firstRun: firstRun?.dataset.firstRun ?? "", cards: view("mission").querySelectorAll(".card").length });
    showTab("plans");
    view("plans").querySelector<HTMLButtonElement>('button[data-filter="all"]')?.click();
    await wait(200);
    const rowsBefore = view("plans").querySelectorAll(".plan-row").length;
    await log("view-plans", rowsBefore === snapshot.plans().length, { rows: rowsBefore, snapshot: snapshot.plans().length });
    const rendered: Record<string, number> = {};
    for (const id of ["queue", "inbox", "git", "flight"]) {
      showTab(id);
      await wait(150);
      rendered[id] = view(id).querySelectorAll(".card, .hero, .q-row, .fl-card").length;
    }
    const gitText = view("git").querySelector(".git-repo")?.textContent ?? "";
    await log("views-render", Object.values(rendered).every((n) => n > 0) && gitText.includes(String(snapshot.git.branch)), rendered);
    // Native menu bar (src/menu.json): installed on the window as the spec lists it, every
    // item bound to an action, and a click (smoke_menu_click: the same Rust path as a real
    // click) runs the same action as the More menu.
    // A custom title bar has no GTK menu bar: its own File / View / Run / Help buttons open
    // the same menus as popups (menu_popup, by index; a popup needs a real click).
    const bar = await api.menuState();
    const barIds = bar.flatMap((m) => m.items.map((i) => i.id));
    const topMenus = [...$("top-menus").querySelectorAll("button")].map((b) => b.textContent).join();
    const menuOk =
      info.titleBar === "custom"
        ? !bar.length && topMenus === "File,View,Run,Help" && !$("top-menus").hidden
        : JSON.stringify(barIds) === JSON.stringify(menuIds()) && bar.map((m) => m.label).join() === "File,View,Run,Help" && bar.every((m) => m.items.every((i) => i.enabled)) && $("top-menus").hidden;
    await log("menu-installed", menuOk && !unbound.length, { titleBar: info.titleBar, menus: bar.map((m) => `${m.label}: ${m.items.map((i) => i.label).join(" | ")}`), topMenus, unbound });
    const fire = (id: string) => api.smokeMenuClick(id);
    const termOn = () => !shell.classList.contains("no-bottom");
    const moreClick = (id: string) => menu.querySelector<HTMLButtonElement>(`button[data-cmd="${id}"]`)?.click();
    const m: Record<string, unknown> = {};
    showTab("mission");
    await fire("view:plans");
    m.plans = await until(() => activeTab === "plans", 2000);
    showTab("mission");
    moreClick("view:plans");
    m.morePlans = activeTab === "plans";
    await fire("view:inbox");
    m.inbox = await until(() => activeTab === "inbox", 2000);
    await fire("view:pipelines");
    m.pipelines = await until(() => activeTab === "queue" || activeTab === "cicd", 2000);
    const termWas = termOn();
    await fire("terminal");
    m.terminalToggled = await until(() => termOn() !== termWas, 2000);
    await fire("terminal");
    m.terminalBack = await until(() => termOn() === termWas, 2000);
    await fire("commands");
    m.commands = await until(() => palette.open, 5000);
    palette.hide();
    await fire("quick-open");
    m.quickOpen = await until(() => !$("quick").hidden, 2000);
    hideQuick();
    await fire("about");
    m.about = await until(() => !!document.getElementById("about-panel"), 2000);
    document.getElementById("about-panel")?.click();
    await fire("engine");
    m.engine = await until(() => !!document.getElementById("engine-panel"), 2000);
    closeEnginePanel();
    moreClick("engine");
    m.moreEngine = await until(() => !!document.getElementById("engine-panel"), 2000);
    closeEnginePanel();
    await fire("run-plan");
    m.runPlan = await until(() => !!document.querySelector('#run-dialog [data-act="run-start"]'), 3000);
    document.getElementById("run-dialog")?.remove();
    m.unknownRefused = await fire("not-an-item").then(() => "accepted", (e) => errText(e));
    await log("menu-actions", Object.values(m).every((v) => v === true || (typeof v === "string" && v.startsWith("Unknown menu item"))), { ...m, notFired: "open-folder, run-elsewhere (native folder dialog), close-window (ends the smoke), run-queue / interactive (covered later from their views)" });
    // Title bar: the window opened in the saved mode (decorations, drag region, controls),
    // and the More menu's choice is saved for the next start (then put back). On a tiling
    // window manager: always native, the choice hidden, a saved custom ignored.
    const win = getCurrentWindow();
    const decorated = await win.isDecorated();
    const custom = info.titleBar === "custom";
    const controlsShown = !$("win-controls").hidden && $("win-controls").querySelectorAll("button").length === 3;
    const drag = $("top").getAttribute("data-tauri-drag-region");
    await log("title-bar-applied", decorated === !custom && controlsShown === custom && (custom ? drag === "deep" : drag === null) && document.documentElement.dataset.titleBar === info.titleBar, { titleBar: info.titleBar, decorated, controlsShown, drag, tiling: info.tilingWm });
    if (info.tilingWm) {
      // Tiling window manager: always native. The choice is hidden from the More menu, and
      // a saved `custom` (written here, as a settings.json shared with a GNOME machine
      // would have it) still opens native on the next start (settings_title_bar asks the
      // same decision the startup uses). Then the saved value is put back.
      const hidden = [...menu.querySelectorAll<HTMLElement>("[data-title-bar-menu]")];
      const menuHidden = hidden.length === 4 && hidden.every((el) => el.hidden);
      const before = await api.settingsTitleBar();
      await api.settingsSetTitleBar("custom");
      const withCustom = await api.settingsTitleBar();
      await api.settingsSetTitleBar(before.saved === "custom" ? "custom" : "native");
      const after = await api.settingsTitleBar();
      const ok = menuHidden && info.titleBar === "native" && decorated && withCustom.saved === "custom" && withCustom.next === "native" && before.next === "native" && after.saved === (before.saved === "custom" ? "custom" : "native") && withCustom.tilingWm === info.tilingWm;
      await log("title-bar-tiling", ok, { tiling: info.tilingWm, opened: info.titleBar, decorated, menuHidden, savedAtStart: before.saved, withCustom, after });
    } else {
      const savedTitleBar = async () => ((await api.settingsGet()).settings as { ui?: { titleBar?: string } } | null)?.ui?.titleBar;
      const startTb = titleBar.saved;
      const flip = startTb === "custom" ? "native" : "custom";
      const pickTb = (mode: string) => menu.querySelector<HTMLButtonElement>(`button[data-more="title-bar"][data-mode="${mode}"]`)?.click();
      pickTb(flip);
      let flipped = false;
      for (let i = 0; i < 15 && !flipped; i++) {
        await wait(200);
        flipped = (await savedTitleBar()) === flip;
      }
      const restartNote = $("st-msg").textContent ?? "";
      const marked = menu.querySelector<HTMLElement>(`button[data-more="title-bar"][data-mode="${flip}"]`)?.textContent ?? "";
      pickTb(startTb);
      let back = false;
      for (let i = 0; i < 15 && !back; i++) {
        await wait(200);
        back = (await savedTitleBar()) === startTb;
      }
      await log("title-bar-setting", flipped && back && restartNote.includes("starts again") && marked.startsWith("✓") && marked.includes("after a restart") && (await win.isDecorated()) === decorated, { from: startTb, to: flip, restartNote, marked, back });
    }
    showTab("mission");
    await wait(200);
    await shot("menu");
    await shot(`title-bar-${info.titleBar}`);
    showTab("plans");
    await wait(200);
    await shot("plans");
    showTab("queue");
    await wait(200);
    await shot("queue");
    // Live update: a new plan file under .cursor/ reaches the Plans view over SSE. Its one
    // to-do is already completed, so a real `agent-kit run-plan` later in the smoke finds
    // nothing to do (plan exhausted) and never starts an agent.
    const updatesBefore = snapshot.feed.updates;
    const genBefore = String(d.generatedAt ?? "");
    const planFile = "colony-sse-smoke.plan.md";
    await api.createTextFile(
      `${root}/.cursor/plans/${planFile}`,
      `---\nname: Colony SSE smoke\noverview: "Written by the Colony code-path smoke to check the live update."\ntodos:\n  - id: sse-check\n    content: "Appear in the Plans view without a reload"\n    status: completed\n---\n\n# Colony SSE smoke\n`,
    ).catch((e) => log("sse-write", false, errText(e)));
    showTab("plans");
    const arrived = await until(() => snapshot.plans().some((p) => p.file === planFile) && snapshot.feed.updates > updatesBefore, 30000);
    await wait(300);
    const row = view("plans").querySelector(`.plan-row[data-plan="${planFile}"]`);
    await log("sse-update", arrived && !!row && String(snapshot.data?.generatedAt) !== genBefore, { updates: `${updatesBefore} -> ${snapshot.feed.updates}`, generatedAt: `${genBefore} -> ${snapshot.data?.generatedAt}`, row: !!row, connected: snapshot.feed.connected });
    // Editor, terminal, Open in my editor (unchanged).
    const file = `${root}/README.md`;
    await openFile(file);
    await log("editor-open", editors.active === file && activeTab === file, relPath(file));
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
    // Panels: the terminal docks at the top, the side and back at the bottom (the menu's
    // path), refitting its xterm each time; the Explorer hides and comes back; both
    // splitters resize their panel (DOM pointer events on the splitter, no OS input).
    const box = (id: string) => $(id).getBoundingClientRect();
    const fitted = () => {
      const sz = terminals.activeSize();
      return !!sz?.fits && sz.fits.cols === sz.cols && sz.fits.rows === sz.rows;
    };
    const docked: Record<string, { placed: boolean; fitted: boolean; button: boolean; size: unknown }> = {};
    showTab("mission");
    for (const d of ["top", "side", "bottom"] as const) {
      await api.smokeMenuClick(`dock:${d}`);
      await until(() => shell.dataset.dock === d, 2000);
      await wait(500);
      const b = box("bottom");
      const c = box("center");
      const placed = d === "top" ? b.bottom <= c.top && b.width > 300 : d === "side" ? b.left >= c.right && b.height > c.height - 60 : b.top >= c.bottom;
      docked[d] = { placed, fitted: fitted(), button: !!$("term-tabs").querySelector(`.dock-group button[data-dock="${d}"]`)?.classList.contains("on"), size: terminals.activeSize() };
      if (d !== "bottom") await shot(`dock-${d}`);
    }
    await api.smokeMenuClick("explorer");
    const explorerHidden = await until(() => box("side").width === 0 && shell.classList.contains("no-side"), 2000);
    await api.smokeMenuClick("explorer");
    const explorerBack = await until(() => box("side").width > 100, 2000);
    const dragSplitter = (el: HTMLElement, dx: number, dy: number) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      el.dispatchEvent(new PointerEvent("pointerdown", { clientX: x, clientY: y, bubbles: true }));
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: x + dx, clientY: y + dy }));
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: x + dx, clientY: y + dy }));
    };
    const sideW = box("side").width;
    dragSplitter($("side-resizer"), 60, 0);
    await wait(300);
    const sideW2 = box("side").width;
    const termH = box("bottom").height;
    dragSplitter($("resizer"), 0, -50);
    await wait(500);
    const termH2 = box("bottom").height;
    await log("dock-terminal", Object.values(docked).every((x) => x.placed && x.fitted && x.button) && explorerHidden && explorerBack && Math.abs(sideW2 - sideW - 60) <= 1 && Math.abs(termH2 - termH - 50) <= 1 && fitted(), { ...docked, explorerHidden, explorerBack, explorerWidth: `${sideW} -> ${sideW2}`, terminalHeight: `${termH} -> ${termH2}`, fittedAfterDrag: fitted() });
    // Layout persistence: the panel changes above are in settings.json (debounced save);
    // then the window is reset to the defaults and the layout read back from the file, as
    // the next start does (layout-boot checks a real restart).
    const savedLayout = async () => ((await api.settingsGet()).settings as { ui?: { layout?: LayoutSettings } } | null)?.ui?.layout ?? {};
    await api.smokeMenuClick("dock:side");
    await until(() => dock() === "side", 2000);
    dragSplitter($("resizer"), -40, 0);
    let lOnDisk: LayoutSettings = {};
    const wantW = Math.round(box("bottom").width);
    for (let i = 0; i < 20; i++) {
      await wait(200);
      await layoutSaved;
      lOnDisk = await savedLayout();
      if (lOnDisk.terminalDock === "side" && lOnDisk.terminalWidth === wantW) break;
    }
    const lBefore = layoutNow();
    applyLayout({});
    const reset = dock() === "bottom" && px("--side-w") === null && px("--term-w") === null;
    const reread = await loadLayout();
    await wait(400);
    const lAfter = layoutNow();
    const restored = JSON.stringify(lAfter) === JSON.stringify(lBefore) && Math.round(box("bottom").width) === wantW && fitted();
    await log("layout-persist", lOnDisk.terminalDock === "side" && lOnDisk.terminalWidth === wantW && lOnDisk.explorerWidth === Math.round(sideW2) && lOnDisk.terminalHeight === Math.round(termH2) && reset && restored, { lOnDisk, reset, reread, before: lBefore, after: lAfter, terminalWidth: wantW });
    // Back to the bottom; the sizes stay saved for the next start (layout-boot).
    await api.smokeMenuClick("dock:bottom");
    await until(() => dock() === "bottom", 2000);
    await wait(600);
    await layoutSaved;
    const launch = await openInEditor(file);
    let proof = "";
    for (let i = 0; i < 25 && !proof; i++) {
      await wait(200);
      proof = await api.readTextFile(`${root}/editor-proof.txt`).catch(() => "");
    }
    await log("open-in-editor", proof.trim() === `opened ${file}`, { launch, proof: proof.trim() });
    // The web panel stays reachable as a fallback (More), with its allowlisted host actions.
    const cases: [McRecord, string][] = [
      [{ kind: "copy", text: "README.md", subject: "path", destination: "filePicker" }, "open-file"],
      [{ kind: "copy", text: "../etc/passwd", subject: "path", destination: "filePicker" }, "copy"],
      [{ kind: "copy", text: "/run-plan", subject: "/run-plan", destination: "chatInput" }, "run-plan"],
      [{ kind: "copy", text: "/run-plan mission.plan.md", subject: "", destination: "chatInput" }, "run-plan"],
      [{ kind: "copy", text: "/run-plan-all", subject: "", destination: "chatInput" }, "copy"],
      [{ kind: "copy", text: "/git-prod", subject: "", destination: "chatInput" }, "copy"],
      [{ kind: "copy", text: "/run-plan x; rm -rf ~", subject: "", destination: "chatInput" }, "copy"],
      [{ kind: "copy", text: "git diff", subject: "", destination: "terminal" }, "copy"],
      [{ kind: "copy", text: "gh run rerun 4300 --failed", subject: "", destination: "terminal" }, "rerun-run"],
      [{ kind: "copy", text: "gh run rerun 4300 --failed", subject: "", destination: "chatInput" }, "copy"],
      [{ kind: "copy", text: "gh run rerun 4300 --failed; rm -rf ~", subject: "", destination: "terminal" }, "copy"],
      [{ kind: "copy", text: "gh run rerun 0 --failed", subject: "", destination: "terminal" }, "copy"],
      [{ kind: "copy", text: "gh run rerun 4300", subject: "", destination: "terminal" }, "copy"],
      [{ kind: "copy", text: "gh pr checks 9", subject: "", destination: "terminal" }, "copy"],
      [{ kind: "copy", text: "/kit-prod", subject: "", destination: "chatInput" }, "copy"],
    ];
    const verdicts = cases.map(([r, want]) => ({ text: r.text, got: decide(r).action, want }));
    await log("mc-allowlist", verdicts.every((v) => v.got === v.want), verdicts);
    // Command palette: the kit's catalog (the fake agent-kit's fixture, or a real engine),
    // run only for PROMPT_SLASH names, copy for the rest, markup shown as text. An engine
    // without the catalog must show the Update-the-engine gate and no rows.
    await palette.show();
    const prow = (n: string) => palette.rows().find((r) => r.name === n);
    const items = [...palette.el.querySelectorAll<HTMLElement>(".palette-item")];
    const gated = !!palette.error && palette.error.startsWith("Update the engine") && !items.length;
    const listed =
      !palette.error &&
      palette.open &&
      items.length === palette.rows().length &&
      prow("run-plan")?.run === true &&
      prow("git-prod")?.run === false &&
      palette.rows().every((r) => r.layer !== "factory" || !r.run) &&
      !palette.el.querySelector("#palette-list img") &&
      palette.rows().every((r) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(r.name));
    await log("command-palette", listed || gated, { error: palette.error || null, rows: palette.rows().map((r) => `${r.name}:${r.layer}:${r.run ? "run" : "copy"}`), rendered: items.length });
    // Claude Code section: the static cited list, shown with or without the engine gate,
    // every row copy-only, the source URL on screen, and the search reaching it.
    const builtins = [...palette.el.querySelectorAll<HTMLElement>(".palette-builtin")];
    const section = palette.el.querySelector(".palette-section")?.textContent ?? "";
    const pInput = palette.el.querySelector<HTMLInputElement>("#palette-input")!;
    pInput.value = "compact";
    pInput.dispatchEvent(new Event("input"));
    const found = [...palette.el.querySelectorAll<HTMLElement>(".palette-builtin")].map((el) => el.dataset.name);
    const builtinsOk =
      builtins.length === palette.builtins().length &&
      builtins.every((el) => el.querySelector(".palette-act")?.textContent === "Copy") &&
      section.includes("https://code.claude.com/docs/en/commands") &&
      found[0] === "compact" &&
      palette.builtins().every((b) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(b.name));
    await log("claude-builtins", builtinsOk, { rendered: builtins.length, listed: palette.builtins().length, section, compactSearch: found });
    palette.hide();
    const loaded = new Promise<boolean>((r) => mcFrame.addEventListener("load", () => r(true), { once: true }));
    openWebPanel();
    const frameOk = await Promise.race([loaded, wait(8000).then(() => false)]);
    await log("mission-control-web", activeTab === "web" && mcFrame.src.startsWith("http://127.0.0.1:"), { src: mcFrame.src, loadEvent: frameOk });
    await wait(1500);
    const webSkin = await frameSkinNow();
    await log("mc-web-skin", webSkin === kitSkinValue("bare-metal"), { skin: webSkin, src: mcFrame.src });
    const opened = await mcPerformInFrame({ kind: "copy", text: "smoke.txt", subject: "path smoke.txt", destination: "filePicker" });
    await log("mc-open-file", editors.active === `${root}/smoke.txt` && activeTab === `${root}/smoke.txt`, { result: opened, active: editors.active ? relPath(editors.active) : null });
    let asked = "";
    const realConfirm = confirmMcRun;
    confirmMcRun = async (plan) => {
      asked = `asked (plan ${plan ?? "none"})`;
      return false; // the smoke never starts a run from the web panel
    };
    const runReply = await mcPerformInFrame({ kind: "copy", text: "/run-plan demo.plan.md", subject: "/run-plan", destination: "chatInput" });
    await wait(200);
    confirmMcRun = realConfirm;
    await log("mc-run-plan", asked === "asked (plan demo.plan.md)" && runs.list().length === 0, { result: runReply, asked });
    const copied = await mcPerformInFrame({ kind: "copy", text: "colony smoke copy fallback", subject: "smoke text", destination: "terminal", toastMessage: "Copied smoke text" });
    await log("mc-copy-fallback", JSON.stringify(copied).includes("Colony") && !JSON.stringify(copied).includes("Opened"), copied);
    // Skins: Legacy from the More menu (same handler as the operator's click), saved in
    // settings.json, applied to the chrome and to the web panel; then back to Bare Metal.
    const pickSkin = (id: string) => menu.querySelector<HTMLButtonElement>(`button[data-more="skin"][data-skin="${id}"]`)?.click();
    // On Omarchy with no saved skin the window starts on the system theme: start from Bare Metal.
    const startSkin = skin();
    if (startSkin !== "bare-metal") {
      pickSkin("bare-metal");
      await wait(800);
    }
    const bareBg = getComputedStyle(document.documentElement).getPropertyValue("--bg-primary").trim();
    const frameLoad = () => new Promise<boolean>((r) => mcFrame.addEventListener("load", () => r(true), { once: true }));
    let reloaded = frameLoad();
    pickSkin("legacy");
    await Promise.race([reloaded, wait(8000)]);
    await wait(800);
    const legacyBg = getComputedStyle(document.documentElement).getPropertyValue("--bg-primary").trim();
    const savedSkin = ((await api.settingsGet()).settings as { ui?: { skin?: string } } | null)?.ui?.skin;
    const frameSkin = await frameSkinNow();
    showTab("mission");
    await wait(200);
    await shot("legacy");
    for (const id of ["plans", "queue"]) {
      showTab(id);
      await wait(200);
      await shot(`legacy-${id}`);
    }
    reloaded = frameLoad();
    pickSkin("bare-metal");
    await Promise.race([reloaded, wait(8000)]);
    await wait(800);
    const backSkin = await frameSkinNow();
    // Omarchy only: the system theme from colors.toml on the chrome and the terminal font,
    // the web panel left on Bare Metal; then back where the smoke started.
    if (omarchyDetected()) {
      const t = omarchyTheme();
      const before = mcFrame.src;
      pickSkin("omarchy");
      await wait(800);
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg-primary").trim();
      const ok = document.documentElement.dataset.skin === "omarchy" && bg === t?.tokens["--bg-primary"] && document.documentElement.dataset.mode === t?.mode && (!t?.font || termFont().startsWith(`"${t.font}"`)) && mcFrame.src === before;
      await log("skin-omarchy", ok, { theme: t?.name, mode: t?.mode, bg, font: t?.font, frameReloaded: mcFrame.src !== before });
      pickSkin("bare-metal");
      await wait(400);
    } else {
      await log("skin-omarchy", !!menu.querySelector<HTMLElement>('button[data-skin="omarchy"]')?.hidden, { detected: false, skip: "not Omarchy (menu entry hidden)" });
    }
    await log("skin-switch", bareBg === "#141414" && legacyBg === "#0b0e14" && savedSkin === "legacy" && frameSkin === "legacy" && backSkin === kitSkinValue("bare-metal") && document.documentElement.dataset.skin === "bare-metal", { bareBg, legacyBg, savedSkin, frameSkin, backSkin, frameSrc: mcFrame.src });
    if (startSkin !== "bare-metal") pickSkin(startSkin);
    // Omarchy integration: the plan only (read-only); the smoke never installs anything.
    if (omarchyDetected()) {
      const plan = await api.omarchyIntegrationPlan("install").catch((e) => ({ error: errText(e) }));
      const steps = "steps" in plan ? plan.steps.map((st) => st.kind) : [];
      await log("omarchy-plan", "steps" in plan && (plan.blocked !== null || steps.includes("write")), plan);
    } else {
      await log("omarchy-plan", !!menu.querySelector<HTMLElement>('button[data-cmd="omarchy"]')?.hidden, { detected: false, skip: "not Omarchy (menu entry hidden)" });
    }
    const gs = await api.gitStatus();
    await log("git-status", gs.isRepo, { branch: gs.branch, files: gs.files.map((f) => `${f.xy} ${f.path}`) });
    await terminals.create(); // a fresh shell tab: the editor step may have closed the active one
    await wait(1500);
    const smokeCtx = { root, log, wait, until, shot, showTab, view, term: (line: string) => terminals.sendToActive(line), activeTab: () => activeTab };
    await hostSmoke(smokeCtx);
    await gitCicdSmoke(smokeCtx);
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
    pick(controls.backend, "codex");
    pick(controls.onLimit, "claude");
    pick(controls.model, "smoke-model");
    pick(controls.ticks, "1");
    await wait(300);
    const remembered = await api.settingsWorkspace();
    await log("engine-remembered", remembered.backend === "codex" && remembered.onLimit === "claude" && remembered.model === "smoke-model", remembered);
    // A view action starts the run: the Mission view's Run plan button opens the run
    // dialog, then its Start, same click handlers as the operator's. The run must open and
    // focus its own agent tab.
    showTab("mission");
    const before = runs.list().length;
    view("mission").querySelector<HTMLButtonElement>('[data-act="run-plan"]')?.click();
    await until(() => !!document.querySelector('#run-dialog [data-act="run-start"]'), 3000);
    document.querySelector<HTMLButtonElement>('#run-dialog [data-act="run-start"]')?.click();
    await until(() => runs.list().length > before, 10000);
    const run = runs.list()[before];
    if (!run) throw new Error("the Mission view's Run plan did not start a run");
    await log("view-action-run", activeTab === `run:${run.id}` && !!view(`run:${run.id}`).querySelector(".tr"), { activeTab, cmd: run.cmd });
    await until(() => !run.running || !!run.gate, 20000);
    const fixture = run.plan === "smoke-fixture.plan.md";
    const second: { run?: Run; root: string } = { root: root.replace(/\/repo$/, "/repo2") };
    if (run.gate && fixture) {
      const dup = await runs.start({ backend: "claude", maxTicks: 1 }).then(
        () => "started",
        (e) => errText(e),
      );
      await log("one-run-per-folder", dup.includes("already active"), dup);
      second.run = await runs.start({ backend: "claude", maxTicks: 1, cwd: second.root }).catch(() => undefined);
      await until(() => !second.run?.running || !!second.run?.gate, 10000);
      showTab(`run:${run.id}`);
    }
    if (run.gate) {
      // The gate shows inline in the run's own tab, and in the Inbox with the other run's.
      const runEl = view(`run:${run.id}`);
      const inline = runEl.querySelector<HTMLElement>(`.tr-gate[data-ask="${run.gate.askId}"]`);
      const inlineButtons = inline ? [...inline.querySelectorAll<HTMLButtonElement>(".gate-buttons button")].map((b) => b.textContent) : [];
      await log("agent-tab-gate", !!inline && inlineButtons.length === run.gate.labels.length && runEl.querySelector(".chip")?.textContent === "waiting for you", { askId: run.gate.askId, buttons: inlineButtons });
      await shot("gate");
      const badge = $("inbox-badge");
      const cards = [...inbox.el.querySelectorAll<HTMLElement>(".inbox-card")];
      await log("inbox-open", !!badge && Number(badge.textContent) === cards.length && cards.length === (second.run ? 2 : 1), {
        badge: badge?.textContent,
        cards: cards.map((c) => `${c.dataset.run}:${c.dataset.ask}`),
      });
      // Gates are hard to miss: the title counter, one (recorded) notification per gate,
      // the full question on the card, the strip pinned at the top of Mission, and a
      // notification click that opens the Inbox on that gate.
      const keys = pendingGates().map((g) => g.key);
      const noted = alerts.log.filter((n) => keys.includes(n.key));
      const prompt = cards.find((c) => c.dataset.run === String(run.id))?.querySelector(".gate-prompt")?.textContent ?? "";
      // Mission is hidden here (the run's tab is active) and renders only when shown or
      // flushed: flush it so the strip is checked as the operator would see it.
      mission.flush();
      const pinned = view("mission").querySelectorAll(".gate-strip .mission-gate").length;
      await log("gate-signals", document.title === `(${keys.length}) ${workspace?.name} · Colony` && noted.length === keys.length && noted.every((n) => !n.sent && !n.body.includes("HITL_GATE")) && prompt.includes("One decision") && !prompt.includes("HITL_GATE") && pinned === keys.length, {
        title: document.title,
        notified: noted.map((n) => `${n.key}: ${n.body}`),
        prompt: prompt.slice(0, 160),
        pinned,
      });
      const last = noted[noted.length - 1];
      showTab("mission");
      alerts.clicked(last?.id);
      await wait(100);
      const flashed = inbox.el.querySelector<HTMLElement>(".inbox-card.flash");
      await log("gate-notification-click", !!last && activeTab === "inbox" && flashed?.dataset.key === last.key, { activeTab, flashed: flashed?.dataset.key ?? null, want: last?.key ?? null });
      showTab(`run:${run.id}`);
      // The second run is answered from the Inbox, the first from its agent tab.
      if (second.run) inbox.el.querySelector<HTMLButtonElement>(`.inbox-card[data-run="${second.run.id}"] .gate-buttons button[data-reply="2"]`)?.click();
      inline?.querySelector<HTMLButtonElement>('.gate-buttons button[data-reply="1"]')?.click();
      await wait(400);
      mission.flush();
      await log("inbox-cleared", !run.gate && !second.run?.gate && !$("inbox-badge") && !inbox.el.querySelector(".inbox-card") && document.title === `${workspace?.name} · Colony` && !view("mission").querySelector(".gate-strip"), { badge: $("inbox-badge")?.textContent ?? null, title: document.title });
    }
    await until(() => !run.running, 20000);
    off();
    const events = seen.get(run.id) ?? [];
    await log("agent-driver", events.includes("run_end") && !run.running, { cmd: run.cmd, events, exitCode: run.exitCode });
    const runEl = view(`run:${run.id}`);
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
        await until(() => !second.run?.running, 10000);
        const r2 = second.run.rows.find((r) => r.text.startsWith("fixture reply:"))?.text ?? "";
        await log("gate-answer-second-run", r2.includes('"reply":2') && r2.includes('"askId":"smoke-gate"') && second.run.backend === "claude", { reply: r2, backend: second.run.backend, exit: second.run.exitCode });
      }
      // Transcript: prose, a collapsible tool call with its result, the tick summary.
      const tool = runEl.querySelector<HTMLElement>(".tr-tool");
      const summary = runEl.querySelector(".tr-sum")?.textContent ?? "";
      const transcript = {
        prose: runEl.querySelectorAll(".tr-msg .prose p").length,
        tool: tool?.querySelector(".tool-name")?.textContent ?? null,
        toolResult: tool?.querySelector(".tool-result")?.textContent?.trim() ?? null,
        answered: runEl.querySelector(".tr-gate.answered .gate-title")?.textContent ?? null,
        summary: summary.slice(0, 120),
        end: !!runEl.querySelector(".tr-end"),
      };
      await log("agent-transcript", transcript.prose > 0 && tool?.tagName === "DETAILS" && !!transcript.toolResult?.includes("fixture-tick.txt") && summary.includes("LOOP_TICK_RESULT: done") && !!transcript.answered?.includes("1 | Ship it") && transcript.end, transcript);
      showTab(`run:${run.id}`);
      await wait(200);
      await shot("transcript");
      const rv = run.reviews[0];
      const files = (rv?.files ?? []).map((f) => `${f.status} ${f.path}`).sort();
      await log("tick-review", !!rv && rv.finished && files.join(",") === "A fixture-tick.txt,A gate-reply.json,M README.md", { tick: rv?.tick, files, result: rv?.resultLine });
      if (rv) {
        showTab("review");
        const v = await reviewView.show(rv, rv.files.find((f) => f.path === "fixture-tick.txt") ?? rv.files[0]);
        await wait(500);
        await log("review-diff", v.before === null && v.after === "written by the fixture tick\nanswered\n", { before: v.before, after: v.after, rows: $("view-review").querySelectorAll(".rv-file").length });
        await shot("review");
      }
    } else {
      await log("agent-transcript", !!runEl.querySelector(".tr-end, .tr-line"), { lines: runEl.querySelectorAll(".tr > *").length, end: runEl.querySelector(".tr-end")?.textContent ?? null });
    }
    // Queue runner from the Queue view. Fixture: the fake CLI announces driver protocol
    // 1.2.0, so the queue starts as a driver run: the Queue view follows its queue_state and
    // its gate is answered from the Inbox. Real CLI: --dry-run in a terminal tab, no agent.
    const realConfirmAction = confirmAction;
    let confirmed = "";
    confirmAction = async (m) => {
      confirmed = m;
      return true;
    };
    smokeDryRun = !fixture;
    showTab("queue");
    const qBtn = view("queue").querySelector<HTMLButtonElement>('[data-act="run-queue"]');
    if (fixture) {
      const before = new Set(runs.runs.keys());
      const newQueueRun = () => runs.list().find((r) => !before.has(r.id) && r.command === "run-plan-all");
      qBtn?.click();
      await until(() => !!newQueueRun()?.gate, 15000);
      const qRun = newQueueRun();
      showTab("queue");
      queue.flush();
      const qNote = view("queue").querySelector<HTMLElement>(".queue-live");
      const followed = !!qRun && qNote?.dataset.run === String(qRun.id) && qNote.dataset.cursor === "1" && qRun.queue?.current === "colony-queue-b.plan.md";
      showTab("inbox");
      await wait(300);
      const qCard = qRun ? inbox.el.querySelector<HTMLElement>(`.inbox-card[data-run="${qRun.id}"][data-ask="smoke-queue-gate"]`) : null;
      qCard?.querySelector<HTMLButtonElement>('.gate-buttons button[data-reply="1"]')?.click();
      await until(() => !!qRun && !qRun.running, 15000);
      const qReply = await api.readTextFile(`${root}/queue-reply.json`).catch((e) => `missing: ${errText(e)}`);
      let qSent: Record<string, unknown> = {};
      try {
        qSent = JSON.parse(qReply);
      } catch {
        // logged below
      }
      const states = qRun?.items.filter((i) => i.kind === "ev" && i.ev.type === "queue_state").length ?? 0;
      await log(
        "queue-driver",
        !!qBtn && !!qRun && confirmed.includes("Inbox") && followed && !!qCard && qSent.askId === "smoke-queue-gate" && qSent.reply === 1 && qRun.exitCode === 0 && states === 2 && tabs.has(`run:${qRun.id}`),
        { run: qRun?.id, cmd: qRun?.cmd, cursor: qNote?.dataset.cursor ?? null, current: qRun?.queue?.current ?? null, card: !!qCard, reply: qReply.slice(0, 120), exit: qRun?.exitCode, states },
      );
      if (qRun) await closeTab(`run:${qRun.id}`);
    } else {
      const termsBefore = centerTerms.size;
      qBtn?.click();
      await until(() => centerTerms.size > termsBefore, 5000);
      const qTab = activeTab;
      const qView = centerTerms.get(qTab);
      await until(() => !!qView?.exited, 30000);
      const qOut = (qView?.output ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      await log("queue-tab", !!qBtn && qTab.startsWith("term:") && confirmed.includes("run-plan-all") && qView?.exitCode === 0 && qOut.length > 0, { tab: tabs.get(qTab)?.tip, exit: qView?.exitCode, out: qOut.slice(0, 200) });
    }
    smokeDryRun = false;
    // Open interactive: the vendor CLI in a center terminal tab (fixture: a fake claude;
    // real: the argv is resolved, the real vendor CLI is not started by the smoke).
    pick(controls.backend, "claude");
    if (fixture) {
      // The Mission view's button (no prompt), then a Plans-view style launch with a kit
      // command as the first prompt (same host call the Run…/Edit…/Resume… buttons make).
      showTab("mission");
      const iBtn = view("mission").querySelector<HTMLButtonElement>('[data-act="interactive"]');
      const tBefore = centerTerms.size;
      iBtn?.click();
      await until(() => centerTerms.size > tBefore, 5000);
      const iTab = activeTab;
      const iView = centerTerms.get(iTab);
      await until(() => (iView?.output ?? "").includes("fake claude ready"), 8000);
      const iProof = await api.readTextFile(`${root}/interactive-proof.txt`).catch((e) => `missing: ${errText(e)}`);
      await shot("interactive");
      await closeTab(iTab);
      confirmed = "";
      const p = (await host.interactive(`/run-plan ${planFile}`, "smoke")) as { id: string; view: TermView } | undefined;
      await until(() => (p?.view.output ?? "").includes("fake claude ready"), 8000);
      const pProof = await api.readTextFile(`${root}/interactive-proof.txt`).catch((e) => `missing: ${errText(e)}`);
      // A terminal tab that printed a HITL_GATE line: gate marker on its tab, a card in the
      // Inbox's Live gates, the title counter and a (recorded) notification.
      if (p) {
        const key = `${p.id}:fake-gate`;
        await until(() => pendingGates().some((g) => g.key === key), 4000);
        const tabBtn = $("tabs").querySelector<HTMLElement>(`.tab[data-tab="${p.id}"]`);
        const tCard = inbox.el.querySelector<HTMLElement>(`.inbox-card[data-tab="${p.id}"]`);
        const n = pendingGates().length;
        await log("terminal-gate", n === 1 && !!tabBtn?.classList.contains("run-gate") && tabBtn.querySelector(".badge")?.textContent === "gate" && tCard?.dataset.key === key && !!tCard.querySelector(".inbox-line")?.textContent?.includes("Go | Wait") && Number($("inbox-badge")?.textContent) === 1 && document.title.startsWith("(1) ") && alerts.log.some((x) => x.key === key && !x.sent), {
          gates: pendingGates().map((g) => g.key),
          tab: tabBtn?.className ?? null,
          card: tCard?.textContent?.slice(0, 160) ?? null,
          title: document.title,
        });
      }
      await log(
        "interactive-tab",
        !!iBtn && iTab.startsWith("term:") && iProof.includes("args: --model smoke-model\n") && iProof.includes(`cwd: ${root}`) && pProof.includes(`args: --model smoke-model /run-plan ${planFile}`) && confirmed.includes(`/run-plan ${planFile}`),
        { tab: tabs.get(iTab)?.label, proof: iProof.trim(), promptTab: p ? tabs.get(p.id)?.label : null, promptProof: pProof.trim() },
      );
      if (p) await closeTab(p.id);
    } else {
      const l = await api.termLaunch({ kind: "interactive", engine: "claude" }).then(
        (x) => x,
        (e) => ({ error: errText(e) }),
      );
      await log("interactive-tab", "argv" in l && /\/claude$/.test(l.argv[0]), { resolved: l, spawned: false, why: "the smoke never starts a real vendor session" });
    }
    await smokeLive({ root, fixture, planFile, runId: run.id, log, wait, until, view, shot, host, activeTab: () => activeTab, closeTab, openInEditor, picker: controls.backend });
    await terminals.create(); // a fresh shell tab: earlier steps may have closed the active one
    await chatSmoke({ root, fixture, log, wait, until, view, shot, showTab, term: (line) => terminals.sendToActive(line), activeTab: () => activeTab, tabLabel: (id) => tabs.get(id)?.label ?? "", termCount: () => centerTerms.size, closeTab });
    confirmAction = realConfirmAction;
    showTab("mission");
    await shot("mission");
    await log("csp-clean", cspViolations.length === 0, { violations: cspViolations });
    await log("done", true);
  } catch (e) {
    await log("error", false, errText(e));
  }
  await wait(1500);
  await api.smokeExit();
}

/** `colony --inbox` / `colony --open-folder` (menu entries, bar widget): show that view. */
function showView(view: string) {
  if (view === "inbox") {
    if (workspace) showTab("inbox");
    else status("Open a folder first: the Inbox belongs to a folder");
  } else if (view === "open-folder") void pickFolder();
}

// ---- boot ------------------------------------------------------------------------------
shell.classList.add("no-folder");
shell.dataset.dock = "bottom";
renderDock();
pinViews();
void hostRequests.start().catch((e) => status(`Host requests: ${errText(e)}`));
renderRecents();
api
  .appInfo()
  .then(async (info: StartupInfo) => {
    // The WebKit DMA-BUF renderer state is debug detail: in the tooltip, not the bar.
    $("st-env").textContent = `v${info.version}`;
    $("st-env").title = [`Colony ${info.version}`, `WebKit DMA-BUF renderer: ${info.webkitDmabuf}`, `agent-kit: ${info.agentKit ?? "not found"}`, `node: ${info.node ?? "not found"}`, `git: ${info.git ?? "not found"}`, `PATH added: ${info.pathAdded.join(", ") || "none"}`].join("\n");
    if (!info.agentKit) status("No Agent Kit engine: install one from More → Engine (Mission Control and agent runs need it)");
    void refreshEngineBadge($("st-engine"));
    if (info.smoke) {
      focusPolicy.enabled = false;
      // The smoke records its notifications instead of showing them on the desktop.
      alerts.dryRun = true;
    }
    applyTitleBar(info);
    titleBar.saved = ((await api.settingsGet().catch(() => null))?.settings as { ui?: { titleBar?: string } } | null)?.ui?.titleBar === "custom" ? "custom" : "native";
    renderTitleBarMenu();
    const savedLayout = await loadLayout();
    await loadSkin();
    const start = info.initialWorkspace ?? recents()[0];
    if (start) await openWorkspace(start);
    // Single instance: `colony <folder>` from a terminal or launcher while this window
    // runs raises it (Rust side) and opens that folder here, after the startup folder.
    const forwarded = new Channel<InstanceEvent>();
    forwarded.onmessage = (m) => {
      if (m.kind === "show") return showView(m.view);
      if (m.kind !== "open" || m.folder === workspace?.root) return;
      status(`Opening ${m.folder} (from another colony launch)`);
      void openWorkspace(m.folder);
    };
    void api.instanceSubscribe(forwarded).catch((e) => status(`Single instance: ${errText(e)}`));
    if (info.initialView) showView(info.initialView);
    pushShellStatus();
    if (info.smoke && workspace) await runSmoke(workspace.root, info, savedLayout);
  })
  .catch((e) => status(errText(e)));
