// Typed wrappers over the Colony Rust commands (src-tauri/src/*.rs).
import { Channel, invoke } from "@tauri-apps/api/core";

export interface StartupInfo {
  version: string;
  initialWorkspace: string | null;
  /** `colony --inbox` / `colony --open-folder` on a first launch. */
  initialView: string | null;
  webkitDmabuf: string;
  pathAdded: string[];
  agentKit: string | null;
  node: string | null;
  git: string | null;
  smoke: string | null;
  smokeShots: boolean;
  /** The title bar this window opened with (settings.json `ui.titleBar`, read at startup). */
  titleBar: "native" | "custom";
  /** A tiling window manager (Hyprland, sway, niri, i3), or null. */
  tilingWm: string | null;
}
/** One menu of the native menu bar, read back from the window (menu.rs menu_state). */
export interface MenuState { label: string; items: { id: string; label: string; enabled: boolean }[] }
/** settings.json `ui.layout` (settings.rs LayoutSettings): unset fields keep the defaults. */
export interface LayoutSettings {
  terminalDock?: "bottom" | "top" | "side";
  terminalVisible?: boolean;
  explorerVisible?: boolean;
  explorerWidth?: number;
  terminalHeight?: number;
  terminalWidth?: number;
  railPosition?: "left" | "right";
  /** false: icon-only rail (tooltips and aria-labels kept). */
  railLabels?: boolean;
}
export interface WorkspaceInfo { root: string; name: string; isGit: boolean; hasKit: boolean; hasHandoff: boolean }
export interface Entry { name: string; path: string; isDir: boolean }
export interface DashboardInfo { url: string; port: number; servePath: string; logPath: string; engine: string }
export interface EngineManifest { name: string; version: string; node: string; driverProtocol: string; dashboardDataVersion: string | null; entry: string; dashboardServe: string }
export interface AppUpdateStatus {
  version: string;
  channel: "direct" | "package";
  install: string;
  canCheck: boolean;
  canInstall: boolean;
  note: string;
}
export interface AppUpdateInfo { current: string; available: string | null; notes: string | null; date: string | null }
export interface EngineStatus {
  source: "env" | "managed" | "unmanaged" | "none";
  label: string;
  root: string | null;
  manifest: EngineManifest | null;
  error: string | null;
  note: string | null;
  node: string | null;
  nodeVersion: string | null;
  nodeSource: string | null;
  nodeError: string | null;
  nodePin: string;
  installed: { version: string; current: boolean; supported: boolean; reason: string | null }[];
  previous: string | null;
  dataDir: string | null;
  supported: string;
  releaseRepo: string;
  dashboard: string | null;
  agentKitOverride: string | null;
  dashboardOverride: string | null;
}
export interface EngineInstallReport { version: string; path: string; sha256: string; signature: string; previous: string | null }
export type PtyEvent = { kind: "data"; data: string } | { kind: "exit"; code: number | null };
export type AgentEvent =
  | { kind: "event"; line: string }
  | { kind: "stderr"; line: string }
  | { kind: "exit"; code: number | null }
  | { kind: "review"; review: TickReview };
export interface FileChange { status: string; path: string; oldPath?: string }
export interface TickReview {
  runId: number;
  tick: number;
  backend: string;
  toplevel: string;
  headBefore: string | null;
  headAfter: string | null;
  files: FileChange[];
  resultLine: string | null;
  finished: boolean;
  at: string;
}
export interface FileVersions { before: string | null; after: string | null; note: string | null }
export interface EditorLaunch { mode: "terminal" | "detached"; argv: string[]; source: string; label: string }
/** Per folder. `chatModel`: the driver chat agent's model ("" or unset = small tier);
 *  `offerRelaunch`: offer a relaunch when a deferred gate moves in HANDOFF (default on). */
export interface WorkspaceSettings { backend?: string; onLimit?: string; maxTicks?: number; model?: string; chatModel?: string; offerRelaunch?: boolean }
export interface SettingsInfo { path: string; settings: { editor: unknown; workspaces: Record<string, WorkspaceSettings> } | null; error: string | null }
/** `systemDefault`: the desktop's default coding agent (Omarchy `omarchy-default-agent`) is this backend. */
export interface BackendChoice { id: string; bin: string; available: boolean; note: string; needsEngine: string | null; systemDefault?: boolean }
/** The kit command a driver run runs: the tick loop or the queue runner (driver protocol 1.2.0). */
export type RunCommand = "run-plan" | "run-plan-all";
export interface AgentStarted { id: number; cmd: string; root: string; backend: string; command: RunCommand }
/** How "Run queue" starts run-plan-all with the current engine (agent.rs `queue_mode`). */
export interface QueueMode { driver: boolean; protocol: string | null; note: string }
/** `agent-kit queue gates` in the folder (agent.rs `queue_gates`): `decision` is the
 *  `--json` output, `prompt` the `--prompt` output; `supported` false on an engine without it. */
export interface QueueGates { supported: boolean; decision: unknown; prompt: string; note: string }
export interface ContextSource { label: string; kind: string; path: string; exists: boolean; bytes: number | null; lines: number | null; files: number | null; note: string }
export interface ContextReport { cwd: string; engine: string; family: string; slug: string | null; sources: ContextSource[] }
export type McEvent = { kind: "snapshot"; data: string } | { kind: "status"; connected: boolean; detail: string };
/** One row of the kit's commands catalog; `run` is Colony's Rust-side allowlist verdict. */
export interface CommandRow { name: string; description: string; layer: string; headless: boolean; run: boolean }
export interface CommandsCatalog { catalogVersion: string; kitVersion: string; commands: CommandRow[]; dropped: number }
export interface TermLaunch { argv: string[]; label: string; bin: string; note: string }
export interface ChatSession { id: string; title: string; titleSource: "custom" | "ai" | "first-prompt" | "none"; modified: number; sizeBytes: number }
export interface ChatList { vendor: string; status: "ok" | "unsupported"; note: string; dir: string | null; total: number; sessions: ChatSession[] }
export interface GitFile { xy: string; path: string }
export interface GitStatus { isRepo: boolean; branch: string; header: string; prodBranch: boolean; files: GitFile[] }

export const api = {
  appInfo: () => invoke<StartupInfo>("app_info"),
  appUpdateStatus: () => invoke<AppUpdateStatus>("app_update_status"),
  appUpdateCheck: () => invoke<AppUpdateInfo>("app_update_check"),
  appUpdateInstall: () => invoke<string>("app_update_install"),
  smokeLog: (line: string) => invoke<void>("smoke_log", { line }),
  smokeExit: () => invoke<void>("smoke_exit"),
  menuState: () => invoke<MenuState[]>("menu_state"),
  smokeMenuClick: (id: string) => invoke<void>("smoke_menu_click", { id }),
  menuPopup: (index: number, x: number, y: number) => invoke<void>("menu_popup", { index, x, y }),
  openWorkspace: (path: string) => invoke<WorkspaceInfo>("open_workspace", { path }),
  listDir: (path: string) => invoke<Entry[]>("list_dir", { path }),
  listFiles: () => invoke<string[]>("list_files"),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  writeTextFile: (path: string, contents: string) => invoke<void>("write_text_file", { path, contents }),
  createTextFile: (path: string, contents: string) => invoke<string>("create_text_file", { path, contents }),
  dashboardStart: () => invoke<DashboardInfo>("dashboard_start"),
  engineStatus: () => invoke<EngineStatus>("engine_status"),
  engineInstall: (version?: string) => invoke<EngineInstallReport>("engine_install", { version: version || null }),
  engineRollback: () => invoke<string>("engine_rollback"),
  engineInstallNode: () => invoke<string>("engine_install_node"),
  mcSnapshot: () => invoke<string>("mc_snapshot"),
  mcConfig: () => invoke<string | null>("mc_config"),
  mcSubscribe: (onEvent: Channel<McEvent>) => invoke<void>("mc_subscribe", { onEvent }),
  /** Folders a later `colony <folder>` launch hands to this window (single instance). */
  /** The Omarchy theme and font now (`null` off Omarchy), then on every switch. */
  omarchySubscribe: (onEvent: Channel<OmarchyTheme | null>) => invoke<void>("omarchy_subscribe", { onEvent }),
  /** More → Omarchy integration: what Install / Remove would do, then do it (src-tauri/src/omarchy_shell.rs). */
  omarchyIntegrationPlan: (action: "install" | "remove") => invoke<OmarchyPlan>("omarchy_integration_plan", { action }),
  omarchyIntegrationApply: (action: string) => invoke<string[]>("omarchy_integration_apply", { action }),
  /** This window's open gates and live runs, for the omarchy-shell bar widget (Omarchy only). */
  shellStatusSet: (folder: string | null, gates: number, runs: number) => invoke<void>("shell_status_set", { folder, gates, runs }),
  instanceSubscribe: (onEvent: Channel<InstanceEvent>) => invoke<void>("instance_subscribe", { onEvent }),
  /** On Hyprland, ask the compositor to focus this window (src-tauri/src/hyprland.rs). */
  windowRaise: () => invoke<void>("window_raise"),
  termLaunch: (o: { kind: "interactive" | "run-plan-all"; engine: string; model?: string; prompt?: string; resume?: string; dryRun?: boolean }) =>
    invoke<TermLaunch>("term_launch", { kind: o.kind, engine: o.engine, model: o.model || null, prompt: o.prompt || null, resume: o.resume || null, dryRun: o.dryRun ?? null }),
  commandsCatalog: () => invoke<CommandsCatalog>("commands_catalog"),
  chatSessions: (vendor = "claude") => invoke<ChatList>("chat_sessions", { vendor }),
  ptySpawn: (cols: number, rows: number, onEvent: Channel<PtyEvent>, command?: string[]) =>
    invoke<number>("pty_spawn", { cols, rows, command: command ?? null, onEvent }),
  ptyWrite: (id: number, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: number, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  ptyKill: (id: number) => invoke<void>("pty_kill", { id }),
  agentStart: (o: { backend: string; maxTicks: number; cwd?: string; onLimit?: string; model?: string; command?: RunCommand; note?: string; onEvent: Channel<AgentEvent> }) =>
    invoke<AgentStarted>("agent_start", {
      backend: o.backend,
      maxTicks: o.maxTicks,
      cwd: o.cwd ?? null,
      onLimit: o.onLimit || null,
      model: o.model || null,
      command: o.command ?? null,
      note: o.note || null,
      onEvent: o.onEvent,
    }),
  queueMode: () => invoke<QueueMode>("queue_mode"),
  queueGates: (backend: string, cwd?: string) => invoke<QueueGates>("queue_gates", { backend, cwd: cwd ?? null }),
  agentBackends: () => invoke<BackendChoice[]>("agent_backends"),
  agentReply: (runId: number, askId: string, reply: number | string) => invoke<void>("agent_reply", { runId, askId, reply }),
  agentStop: (runId: number) => invoke<void>("agent_stop", { runId }),
  agentKill: (runId: number) => invoke<void>("agent_kill", { runId }),
  settingsGet: () => invoke<SettingsInfo>("settings_get"),
  settingsEnsure: () => invoke<string>("settings_ensure"),
  settingsSetSkin: (skin: string) => invoke<string>("settings_set_skin", { skin }),
  settingsSetTitleBar: (mode: string) => invoke<string>("settings_set_title_bar", { mode }),
  /** The saved `ui.titleBar`, what the next start opens with (always native on a tiling WM), and that WM. */
  settingsTitleBar: () => invoke<{ saved: string | null; next: "native" | "custom"; tilingWm: string | null }>("settings_title_bar"),
  settingsSetLayout: (patch: Partial<Record<keyof LayoutSettings, unknown>>) => invoke<LayoutSettings>("settings_set_layout", { patch }),
  settingsWorkspace: () => invoke<WorkspaceSettings>("settings_workspace"),
  settingsSetWorkspace: (patch: Record<string, unknown>) => invoke<WorkspaceSettings>("settings_set_workspace", { patch }),
  contextSources: (cwd: string, engine: string) => invoke<ContextReport>("context_sources", { cwd, engine }),
  openInEditor: (path: string) => invoke<EditorLaunch>("open_in_editor", { path }),
  reviewTicks: () => invoke<TickReview[]>("review_ticks"),
  reviewFile: (runId: number, tick: number, path: string, oldPath?: string) =>
    invoke<FileVersions>("review_file", { runId, tick, path, oldPath: oldPath ?? null }),
  reviewPatch: (runId: number, tick: number) => invoke<string>("review_patch", { runId, tick }),
  gitStatus: () => invoke<GitStatus>("git_status"),
  gitDiff: (path?: string) => invoke<string>("git_diff", { path: path ?? null }),
  gitCommit: (message: string, stageAll: boolean) => invoke<string>("git_commit", { message, stageAll }),
  gitPush: (typedConfirm?: string) => invoke<string>("git_push", { typedConfirm: typedConfirm ?? null }),
};

export { Channel };

/** `src-tauri/src/omarchy.rs` Theme: the Omarchy palette as skin tokens, and the monospace font. */
export interface OmarchyTheme {
  name: string | null;
  mode: "dark" | "light";
  tokens: Record<string, string>;
  font: string | null;
}

/** `src-tauri/src/instance.rs` InstanceEvent. */
export type InstanceEvent = { kind: "open"; folder: string } | { kind: "show"; view: string };

/** `src-tauri/src/omarchy_shell.rs` Plan: every step listed before it runs. */
export interface OmarchyPlan {
  action: "install" | "remove";
  widget: string;
  menu: string;
  steps: { kind: "write" | "remove" | "run"; target: string }[];
  blocked: string | null;
}

/** Off during the COLONY_SMOKE run, so a smoke window never takes keyboard input. */
export const focusPolicy = { enabled: true };

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) el.append(c);
  return el;
}
