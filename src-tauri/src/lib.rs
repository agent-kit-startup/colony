//! Colony: the Mission Kit desktop IDE shell (Tauri 2).

mod agent;
mod dashboard;
mod gitops;
mod pty;
mod tools;
mod workspace;

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
pub struct AppState {
    pub workspace: Mutex<Option<PathBuf>>,
    pub dashboard: Mutex<Option<dashboard::DashboardServer>>,
    pub ptys: pty::PtyRegistry,
    pub agent: Mutex<Option<agent::AgentRun>>,
    startup: Mutex<StartupInfo>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct StartupInfo {
    version: String,
    initial_workspace: Option<String>,
    webkit_dmabuf: String,
    path_added: Vec<String>,
    agent_kit: Option<String>,
    node: Option<String>,
    git: Option<String>,
    /// `COLONY_SMOKE=<log file>`: run the scripted code-path smoke after the folder opens.
    smoke: Option<String>,
}

/// WebKitGTK's DMA-BUF renderer hangs on NVIDIA + Wayland (Colony UI benchmark, machine A).
/// Disable it by default there; `COLONY_ENABLE_DMABUF=1` keeps it, and an explicit
/// `WEBKIT_DISABLE_DMABUF_RENDERER` from the user always wins.
fn apply_webkit_env() -> String {
    if !cfg!(target_os = "linux") {
        return "n/a".into();
    }
    if let Ok(v) = std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER") {
        return format!("user-set WEBKIT_DISABLE_DMABUF_RENDERER={v}");
    }
    if std::env::var("COLONY_ENABLE_DMABUF").as_deref() == Ok("1") {
        return "kept (COLONY_ENABLE_DMABUF=1)".into();
    }
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
    let nvidia = std::path::Path::new("/proc/driver/nvidia").exists();
    if wayland && nvidia {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        return "disabled (NVIDIA + Wayland default)".into();
    }
    "default".into()
}

fn initial_workspace() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-'))
        .and_then(|a| PathBuf::from(a).canonicalize().ok())
        .filter(|p| p.is_dir())
        .map(|p| p.display().to_string())
}

/// Append one line to the `COLONY_SMOKE` log (no-op when the smoke is off).
#[tauri::command]
fn smoke_log(state: State<'_, AppState>, line: String) -> Result<(), String> {
    use std::io::Write;
    let Some(path) = state.startup.lock().ok().and_then(|s| s.smoke.clone()) else { return Ok(()) };
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())
}

/// End a `COLONY_SMOKE` run (refused when the smoke is off).
#[tauri::command]
fn smoke_exit(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if state.startup.lock().ok().and_then(|s| s.smoke.clone()).is_none() {
        return Err("not a smoke run".into());
    }
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> StartupInfo {
    state.startup.lock().map(|s| s.clone()).unwrap_or_default()
}

/// Mission Control action seam (embeddable contract): defined only inside the Mission
/// Control iframe on 127.0.0.1, before the panel script runs. Alpha behavior is still
/// copy (no real host action ships before the interpolation review owed by the ADR); the
/// record is also posted to the Colony window so it can show where to paste.
const MC_ACTION_HOOK: &str = r#"
(function () {
  try {
    if (window === window.top || location.hostname !== '127.0.0.1') return;
    var hook = Object.freeze({
      perform: function (action) {
        if (!action || action.kind !== 'copy' || typeof action.text !== 'string') {
          return Promise.reject(new Error('Colony: action not allowed'));
        }
        var record = { kind: 'copy', text: action.text, subject: String(action.subject || ''), destination: String(action.destination || '') };
        try { window.top.postMessage({ colony: 'mc-action', action: record }, '*'); } catch (e) {}
        var done = function () { return { ok: true, message: (action.toastMessage || 'Copied') + ' (Colony)' }; };
        try {
          return navigator.clipboard.writeText(action.text).then(done, function () {
            return { ok: true, message: 'Sent to Colony (clipboard unavailable in the frame)' };
          });
        } catch (e) {
          return Promise.resolve({ ok: true, message: 'Sent to Colony' });
        }
      }
    });
    Object.defineProperty(window, '__MISSION_CONTROL_ACTIONS__', { value: hook, writable: false, configurable: false });
  } catch (e) {}
})();
"#;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Environment first, before any thread exists.
    let dmabuf = apply_webkit_env();
    let added = tools::extend_process_path();
    let startup = StartupInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        initial_workspace: initial_workspace(),
        webkit_dmabuf: dmabuf,
        path_added: added.iter().map(|p| p.display().to_string()).collect(),
        agent_kit: tools::agent_kit_bin().map(|p| p.display().to_string()),
        node: tools::node_bin().map(|p| p.display().to_string()),
        git: tools::git_bin().map(|p| p.display().to_string()),
        smoke: std::env::var("COLONY_SMOKE").ok().filter(|s| !s.trim().is_empty()),
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { startup: Mutex::new(startup), ..Default::default() })
        .invoke_handler(tauri::generate_handler![
            app_info,
            smoke_log,
            smoke_exit,
            workspace::open_workspace,
            workspace::list_dir,
            workspace::read_text_file,
            workspace::write_text_file,
            workspace::list_files,
            dashboard::dashboard_start,
            dashboard::dashboard_stop,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            agent::agent_start,
            agent::agent_reply,
            agent::agent_stop,
            agent::agent_kill,
            gitops::git_status,
            gitops::git_diff,
            gitops::git_commit,
            gitops::git_push,
        ])
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Colony")
                .inner_size(1500.0, 950.0)
                .min_inner_size(900.0, 600.0)
                .initialization_script_for_all_frames(MC_ACTION_HOOK)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Colony");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let state = handle.state::<AppState>();
            let server = state.dashboard.lock().ok().and_then(|mut d| d.take());
            drop(server); // kills the dashboard server
            state.ptys.kill_all();
            if let Some(mut run) = state.agent.lock().ok().and_then(|mut a| a.take()) {
                run.kill();
            }
        }
    });
}
