// Typed wrappers over the Colony Rust commands (src-tauri/src/*.rs).
import { Channel, invoke } from "@tauri-apps/api/core";

export interface StartupInfo {
  version: string;
  initialWorkspace: string | null;
  webkitDmabuf: string;
  pathAdded: string[];
  agentKit: string | null;
  node: string | null;
  git: string | null;
  smoke: string | null;
}
export interface WorkspaceInfo { root: string; name: string; isGit: boolean; hasKit: boolean; hasHandoff: boolean }
export interface Entry { name: string; path: string; isDir: boolean }
export interface DashboardInfo { url: string; port: number; servePath: string; logPath: string }
export type PtyEvent = { kind: "data"; data: string } | { kind: "exit"; code: number | null };
export type AgentEvent = { kind: "event"; line: string } | { kind: "stderr"; line: string } | { kind: "exit"; code: number | null };
export interface EditorLaunch { mode: "terminal" | "detached"; argv: string[]; source: string; label: string }
export interface WorkspaceSettings { backend?: string; onLimit?: string; maxTicks?: number; model?: string }
export interface SettingsInfo { path: string; settings: { editor: unknown; workspaces: Record<string, WorkspaceSettings> } | null; error: string | null }
export interface GitFile { xy: string; path: string }
export interface GitStatus { isRepo: boolean; branch: string; header: string; prodBranch: boolean; files: GitFile[] }

export const api = {
  appInfo: () => invoke<StartupInfo>("app_info"),
  smokeLog: (line: string) => invoke<void>("smoke_log", { line }),
  smokeExit: () => invoke<void>("smoke_exit"),
  openWorkspace: (path: string) => invoke<WorkspaceInfo>("open_workspace", { path }),
  listDir: (path: string) => invoke<Entry[]>("list_dir", { path }),
  listFiles: () => invoke<string[]>("list_files"),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  writeTextFile: (path: string, contents: string) => invoke<void>("write_text_file", { path, contents }),
  dashboardStart: () => invoke<DashboardInfo>("dashboard_start"),
  ptySpawn: (cols: number, rows: number, onEvent: Channel<PtyEvent>, command?: string[]) =>
    invoke<number>("pty_spawn", { cols, rows, command: command ?? null, onEvent }),
  ptyWrite: (id: number, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: number, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  ptyKill: (id: number) => invoke<void>("pty_kill", { id }),
  agentStart: (backend: string, maxTicks: number, onEvent: Channel<AgentEvent>) =>
    invoke<string>("agent_start", { backend, maxTicks, onEvent }),
  agentReply: (askId: string, reply: number | string) => invoke<void>("agent_reply", { askId, reply }),
  agentStop: () => invoke<void>("agent_stop"),
  agentKill: () => invoke<void>("agent_kill"),
  settingsGet: () => invoke<SettingsInfo>("settings_get"),
  settingsEnsure: () => invoke<string>("settings_ensure"),
  settingsWorkspace: () => invoke<WorkspaceSettings>("settings_workspace"),
  settingsSetWorkspace: (patch: Record<string, unknown>) => invoke<WorkspaceSettings>("settings_set_workspace", { patch }),
  openInEditor: (path: string) => invoke<EditorLaunch>("open_in_editor", { path }),
  gitStatus: () => invoke<GitStatus>("git_status"),
  gitDiff: (path?: string) => invoke<string>("git_diff", { path: path ?? null }),
  gitCommit: (message: string, stageAll: boolean) => invoke<string>("git_commit", { message, stageAll }),
  gitPush: (typedConfirm?: string) => invoke<string>("git_push", { typedConfirm: typedConfirm ?? null }),
};

export { Channel };

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
