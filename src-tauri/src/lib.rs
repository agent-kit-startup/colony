//! Colony: the Mission Kit desktop IDE shell (Tauri 2).

mod agent;
mod branchrule;
mod catalog;
mod chats;
mod context;
mod dashboard;
mod engine;
mod forge;
mod gitops;
mod hostreq;
#[cfg(unix)]
mod instance;
mod launch;
mod mcdata;
mod pty;
mod review;
mod settings;
mod tools;
mod vendor;
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
    pub agents: agent::AgentRegistry,
    pub reviews: std::sync::Arc<review::ReviewStore>,
    pub mc_feed: std::sync::Arc<mcdata::McFeed>,
    /// `<app config dir>/settings.json`, set once at startup.
    pub settings_path: Mutex<Option<PathBuf>>,
    /// The single-instance socket this window serves (removed on exit).
    instance_socket: Mutex<Option<PathBuf>>,
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
    /// `COLONY_SMOKE_SHOTS=1`: the smoke pauses at a few views for read-only screenshots.
    smoke_shots: bool,
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

/// Markers a Claude Code session sets for its own children. A Colony started from inside
/// one (e.g. its Bash tool) would hand them to every agent and terminal it spawns, and
/// each `claude` there then runs as that session's child: transcript saving off, tied to
/// the parent's messaging socket. User configuration (`CLAUDE_CODE_OAUTH_TOKEN`,
/// `CLAUDE_CODE_USE_BEDROCK`, ...) is not on this list and stays.
const PARENT_SESSION_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ATTENDED",
];

/// Drop the parent-session markers from Colony's own environment, so every child
/// inherits a clean one. Logs the names only, never the values.
fn scrub_parent_session_env() {
    let removed: Vec<&str> = PARENT_SESSION_VARS.iter().copied().filter(|k| std::env::var_os(k).is_some()).collect();
    for k in &removed {
        std::env::remove_var(k);
    }
    if !removed.is_empty() {
        eprintln!("colony: started inside a Claude Code session; dropped {}", removed.join(", "));
    }
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
/// Control iframe on 127.0.0.1, before the panel script runs. It also selects the panel's
/// skin that matches Colony's (passed in the frame URL). Every record (always
/// `kind: "copy"`) is first offered to the Colony window over a MessageChannel; the window
/// runs a real host action only for an allowlisted record (open a repo file, start a
/// plan run after a native confirmation; src/mcactions.ts) and answers `handled`.
/// Anything else, a refusal or no answer within 1.5 s falls back to the clipboard copy.
const MC_ACTION_HOOK: &str = r#"
(function () {
  try {
    if (window === window.top || location.hostname !== '127.0.0.1') return;
    // One look across Colony and Mission Control: Colony loads the panel with
    // `?colony-skin=<kit skin value>` (src/skin.ts kitSkinValue) and the panel restores its
    // skin from this key before first paint. Unknown values are ignored.
    try {
      var want = new URLSearchParams(location.search).get('colony-skin');
      if (want === 'cursor' || want === 'legacy' || want === 'bare-metal') localStorage.setItem('agent-kit:dashboard-skin', want);
    } catch (e) {}
    var copy = function (action) {
      var done = function () { return { ok: true, message: (action.toastMessage || 'Copied') + ' (Colony)' }; };
      try {
        return navigator.clipboard.writeText(action.text).then(done, function () {
          return { ok: true, message: 'Sent to Colony (clipboard unavailable in the frame)' };
        });
      } catch (e) {
        return Promise.resolve({ ok: true, message: 'Sent to Colony' });
      }
    };
    var askHost = function (record) {
      return new Promise(function (resolve) {
        var settled = false;
        var finish = function (v) { if (!settled) { settled = true; resolve(v); } };
        var timer = setTimeout(function () { finish(null); }, 1500);
        try {
          var ch = new MessageChannel();
          ch.port1.onmessage = function (ev) { clearTimeout(timer); finish(ev.data || null); };
          window.top.postMessage({ colony: 'mc-action', action: record }, '*', [ch.port2]);
        } catch (e) { clearTimeout(timer); finish(null); }
      });
    };
    var hook = Object.freeze({
      perform: function (action) {
        if (!action || action.kind !== 'copy' || typeof action.text !== 'string') {
          return Promise.reject(new Error('Colony: action not allowed'));
        }
        var record = { kind: 'copy', text: action.text, subject: String(action.subject || ''), destination: String(action.destination || '') };
        return askHost(record).then(function (reply) {
          if (reply && reply.handled === true) {
            return { ok: reply.ok !== false, message: String(reply.message || 'Done in Colony') };
          }
          return copy(action);
        });
      }
    });
    Object.defineProperty(window, '__MISSION_CONTROL_ACTIONS__', { value: hook, writable: false, configurable: false });
    /*COLONY_SMOKE*/
  } catch (e) {}
})();
"#;

/// COLONY_SMOKE only: let the Colony window call `perform()` inside the frame, so the
/// smoke covers the frame -> host -> frame round trip without clicking in the page.
const MC_SMOKE_BRIDGE: &str = r#"
    window.addEventListener('message', function (ev) {
      if (ev.source === window.top && ev.data && ev.data.colony === 'mc-smoke-skin') {
        window.top.postMessage({ colony: 'mc-smoke-skin-result', skin: document.documentElement.getAttribute('data-dashboard-skin') }, '*');
        return;
      }
      if (ev.source !== window.top || !ev.data || ev.data.colony !== 'mc-smoke-perform') return;
      var id = ev.data.id;
      hook.perform(ev.data.action).then(
        function (r) { window.top.postMessage({ colony: 'mc-smoke-result', id: id, result: r }, '*'); },
        function (e) { window.top.postMessage({ colony: 'mc-smoke-result', id: id, error: String(e && e.message || e) }, '*'); }
      );
    });
"#;

fn mc_action_hook(smoke: bool) -> String {
    MC_ACTION_HOOK.replace("/*COLONY_SMOKE*/", if smoke { MC_SMOKE_BRIDGE } else { "" })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `colony request ...`: the host-action CLI (hostreq.rs), no GUI.
    if std::env::args().nth(1).as_deref() == Some("request") {
        std::process::exit(hostreq::cli_main());
    }
    // Single instance: a running window for this binary and engine takes the request
    // (no folder, or the folder it has open) and this process ends here.
    #[cfg(unix)]
    let instance = match instance::socket_path().map(|p| instance::claim_at(&p, initial_workspace().as_deref())) {
        Some(instance::Claim::Forwarded) => return,
        Some(instance::Claim::Primary(listener, path)) => Some((listener, path)),
        _ => None,
    };
    // Environment first, before any thread exists.
    scrub_parent_session_env();
    let dmabuf = apply_webkit_env();
    let added = tools::extend_process_path();
    let host_requests = std::sync::Arc::new(hostreq::HostRequests::prepare());
    let startup = StartupInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        initial_workspace: initial_workspace(),
        webkit_dmabuf: dmabuf,
        path_added: added.iter().map(|p| p.display().to_string()).collect(),
        agent_kit: engine::kit_command().ok().map(|k| format!("{} ({})", k.display(), k.source)),
        node: tools::node_bin().map(|p| p.display().to_string()),
        git: tools::git_bin().map(|p| p.display().to_string()),
        smoke: std::env::var("COLONY_SMOKE").ok().filter(|s| !s.trim().is_empty()),
        smoke_shots: std::env::var("COLONY_SMOKE_SHOTS").as_deref() == Ok("1"),
    };

    let hook = mc_action_hook(startup.smoke.is_some());
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState { startup: Mutex::new(startup), ..Default::default() })
        .manage(host_requests.clone())
        .invoke_handler(tauri::generate_handler![
            app_info,
            smoke_log,
            smoke_exit,
            workspace::open_workspace,
            workspace::list_dir,
            workspace::read_text_file,
            workspace::write_text_file,
            workspace::list_files,
            workspace::create_text_file,
            dashboard::dashboard_start,
            dashboard::dashboard_stop,
            engine::engine_status,
            engine::engine_install,
            engine::engine_rollback,
            engine::engine_install_node,
            mcdata::mc_snapshot,
            mcdata::mc_config,
            mcdata::mc_subscribe,
            vendor::term_launch,
            agent::queue_mode,
            catalog::commands_catalog,
            chats::chat_sessions,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            agent::agent_start,
            agent::agent_backends,
            agent::agent_reply,
            agent::agent_stop,
            agent::agent_kill,
            gitops::git_status,
            gitops::git_diff,
            gitops::git_commit,
            gitops::git_push,
            forge::forge_status,
            forge::forge_prs,
            forge::forge_runs,
            forge::forge_rerun_failed,
            hostreq::host_requests_subscribe,
            hostreq::host_request_context,
            hostreq::host_request_diff,
            hostreq::host_request_open,
            hostreq::host_request_approve,
            hostreq::host_request_deny,
            hostreq::host_request_local,
            settings::settings_get,
            settings::settings_ensure,
            settings::settings_workspace,
            settings::settings_set_workspace,
            settings::settings_set_skin,
            launch::open_in_editor,
            context::context_sources,
            review::review_ticks,
            review::review_file,
            review::review_patch,
        ])
        .setup(move |app| {
            host_requests.start_watcher();
            #[cfg(unix)]
            if let Some((listener, path)) = instance {
                let handle = app.handle().clone();
                instance::serve(listener, move |folder| {
                    let open = handle.state::<AppState>().workspace.lock().ok().and_then(|w| w.clone());
                    let takes = instance::takes(folder.as_deref(), open.as_deref());
                    if takes {
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.unminimize();
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    takes
                });
                *app.state::<AppState>().instance_socket.lock().expect("instance lock") = Some(path);
            }
            if let Ok(dir) = app.path().app_config_dir() {
                *app.state::<AppState>().settings_path.lock().expect("settings lock") = Some(dir.join("settings.json"));
            }
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Colony")
                .inner_size(1500.0, 950.0)
                .min_inner_size(900.0, 600.0)
                .initialization_script_for_all_frames(&hook)
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
            state.agents.kill_all();
            handle.state::<hostreq::Shared>().cleanup();
            if let Some(p) = state.instance_socket.lock().ok().and_then(|mut p| p.take()) {
                let _ = std::fs::remove_file(p);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn scrubs_parent_session_markers_only() {
        std::env::set_var("CLAUDE_CODE_CHILD_SESSION", "1");
        std::env::set_var("CLAUDE_CODE_MESSAGING_TOKEN", "t");
        std::env::set_var("CLAUDE_CODE_FORCE_SESSION_PERSISTENCE", "1");
        super::scrub_parent_session_env();
        assert!(std::env::var_os("CLAUDE_CODE_CHILD_SESSION").is_none());
        assert!(std::env::var_os("CLAUDE_CODE_MESSAGING_TOKEN").is_none());
        // User configuration is not a parent-session marker.
        assert_eq!(std::env::var("CLAUDE_CODE_FORCE_SESSION_PERSISTENCE").as_deref(), Ok("1"));
        std::env::remove_var("CLAUDE_CODE_FORCE_SESSION_PERSISTENCE");
        assert!(super::PARENT_SESSION_VARS.iter().all(|k| *k == "CLAUDECODE" || *k == "CLAUDE_PID" || k.starts_with("CLAUDE_CODE_")));
    }
}
