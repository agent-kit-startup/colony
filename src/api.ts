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
export interface WorkspaceSettings { backend?: string; onLimit?: string; maxTicks?: number; model?: string }
export interface SettingsInfo { path: string; settings: { editor: unknown; workspaces: Record<string, WorkspaceSettings> } | null; error: string | null }
export interface AgentStarted { id: number; cmd: string; root: string; backend: string }
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
  agentStart: (o: { backend: string; maxTicks: number; cwd?: string; onEvent: Channel<AgentEvent> }) =>
    invoke<AgentStarted>("agent_start", { backend: o.backend, maxTicks: o.maxTicks, cwd: o.cwd ?? null, onEvent: o.onEvent }),
  agentReply: (runId: number, askId: string, reply: number | string) => invoke<void>("agent_reply", { runId, askId, reply }),
  agentStop: (runId: number) => invoke<void>("agent_stop", { runId }),
  agentKill: (runId: number) => invoke<void>("agent_kill", { runId }),
  settingsGet: () => invoke<SettingsInfo>("settings_get"),
  settingsEnsure: () => invoke<string>("settings_ensure"),
  settingsWorkspace: () => invoke<WorkspaceSettings>("settings_workspace"),
  settingsSetWorkspace: (patch: Record<string, unknown>) => invoke<WorkspaceSettings>("settings_set_workspace", { patch }),
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
