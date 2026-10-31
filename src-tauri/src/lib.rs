//! Colony: the Mission Kit desktop IDE shell (Tauri 2).

mod agent;
mod appupdate;
mod branchrule;
mod catalog;
mod chats;
mod context;
mod dashboard;
mod dragdrop;
mod engine;
mod forge;
mod gitops;
mod hostreq;
#[cfg(unix)]
mod hyprland;
#[cfg(unix)]
mod instance;
mod launch;
mod mcdata;
mod menu;
mod omarchy;
mod omarchy_shell;
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
    /// `<app config dir>/settings.json` (path set once at startup) and its one writer.
    pub settings: settings::Store,
    /// The single-instance socket this window serves (removed on exit).
    instance_socket: Mutex<Option<PathBuf>>,
    /// Folders a later `colony <folder>` forwarded to this window.
    #[cfg(unix)]
    instance_inbox: instance::Inbox,
    startup: Mutex<StartupInfo>,
    /// Files dropped on the window from the desktop (dragdrop.rs).
    pub dropped: dragdrop::Dropped,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct StartupInfo {
    version: String,
    initial_workspace: Option<String>,
    /// `--inbox` / `--open-folder` on a first launch: the view to show once the folder is open.
    initial_view: Option<String>,
    webkit_dmabuf: String,
    path_added: Vec<String>,
    agent_kit: Option<String>,
    node: Option<String>,
    git: Option<String>,
    /// `COLONY_SMOKE=<log file>`: run the scripted code-path smoke after the folder opens.
    smoke: Option<String>,
    /// `COLONY_SMOKE_SHOTS=1`: the smoke pauses at a few views for read-only screenshots.
    smoke_shots: bool,
    /// The title bar this window opened with (`native` or `custom`, settings.json `ui.titleBar`).
    title_bar: String,
    /// A tiling window manager (it places the window; native is the advice there).
    tiling_wm: Option<String>,
}

/// The tiling window manager this session runs under, if any (from its own variables).
pub(crate) fn tiling_wm() -> Option<String> {
    let set = |k: &str| std::env::var_os(k).is_some_and(|v| !v.is_empty());
    if set("HYPRLAND_INSTANCE_SIGNATURE") {
        return Some("Hyprland".into());
    }
    if set("SWAYSOCK") {
        return Some("sway".into());
    }
    if set("NIRI_SOCKET") {
        return Some("niri".into());
    }
    if set("I3SOCK") {
        return Some("i3".into());
    }
    None
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

/// The smoke's stand-in for a file drop from the desktop (refused when the smoke is off):
/// remembers `paths` as a real drop does (lib.rs `on_window_event`) and emits the event
/// Tauri emits for one, with the same payload, so src/droproute.ts routes it.
#[tauri::command]
fn smoke_drag_drop(app: tauri::AppHandle, state: State<'_, AppState>, paths: Vec<PathBuf>, x: f64, y: f64) -> Result<(), String> {
    use tauri::Emitter;
    if state.startup.lock().ok().and_then(|s| s.smoke.clone()).is_none() {
        return Err("not a smoke run".into());
    }
    state.dropped.record(&paths);
    let payload = serde_json::json!({ "paths": paths, "position": { "x": x, "y": y } });
    app.emit_to(tauri::EventTarget::labeled("main"), "tauri://drag-drop", payload).map_err(|e| e.to_string())
}

/// Ask the compositor to focus this window (on Hyprland; elsewhere nothing). The frontend
/// calls it after `setFocus()`, which on Wayland may only mark the window urgent.
#[tauri::command]
fn window_raise() {
    #[cfg(unix)]
    hyprland::raise_self();
}

/// Folders a later `colony <folder>` launch hands to this window (single instance).
#[cfg(unix)]
#[tauri::command]
fn instance_subscribe(state: State<'_, AppState>, on_event: tauri::ipc::Channel<instance::InstanceEvent>) -> Result<(), String> {
    state.instance_inbox.subscribe(on_event)
}

#[cfg(not(unix))]
#[tauri::command]
fn instance_subscribe(_on_event: tauri::ipc::Channel<serde_json::Value>) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> StartupInfo {
    state.startup.lock().map(|s| s.clone()).unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `colony request ...`: the host-action CLI (hostreq.rs), no GUI.
    if std::env::args().nth(1).as_deref() == Some("request") {
        std::process::exit(hostreq::cli_main());
    }
    // `colony status [--bar]`: the open gates and live runs of the running windows (the
    // omarchy-shell bar widget polls it), no GUI.
    if std::env::args().nth(1).as_deref() == Some("status") {
        std::process::exit(omarchy_shell::cli_main());
    }
    // Single instance: a running window for this binary and engine takes the request
    // (it raises itself and opens the folder, if any) and this process ends here.
    #[cfg(unix)]
    let instance = match instance::socket_path().map(|p| instance::claim_at(&p, initial_workspace().as_deref(), instance::view_arg(std::env::args().skip(1)).as_deref())) {
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
        initial_view: instance::view_arg(std::env::args().skip(1)),
        webkit_dmabuf: dmabuf,
        path_added: added.iter().map(|p| p.display().to_string()).collect(),
        agent_kit: engine::kit_command().ok().map(|k| format!("{} ({})", k.display(), k.source)),
        node: tools::node_bin().map(|p| p.display().to_string()),
        git: tools::git_bin().map(|p| p.display().to_string()),
        smoke: std::env::var("COLONY_SMOKE").ok().filter(|s| !s.trim().is_empty()),
        smoke_shots: std::env::var("COLONY_SMOKE_SHOTS").as_deref() == Ok("1"),
        title_bar: "native".into(),
        tiling_wm: tiling_wm(),
    };

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init());
    let app = appupdate::register(builder)
        .manage(AppState { startup: Mutex::new(startup), ..Default::default() })
        .manage(host_requests.clone())
        // The native menu bar: a click hands the item id to the window (src/menu.json).
        .on_menu_event(|app, event| {
            if let Err(e) = menu::forward(app, event.id().as_ref()) {
                eprintln!("colony: menu: {e}");
            }
        })
        // A file drop from the desktop: remember its files (dragdrop.rs); Tauri also emits
        // `tauri://drag-drop` to the page, where src/droproute.ts routes it.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                window.state::<AppState>().dropped.record(paths);
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            instance_subscribe,
            window_raise,
            appupdate::app_update_status,
            appupdate::app_update_check,
            appupdate::app_update_install,
            smoke_log,
            smoke_exit,
            smoke_drag_drop,
            dragdrop::drop_copy,
            menu::menu_state,
            menu::menu_popup,
            menu::smoke_menu_click,
            workspace::open_workspace,
            workspace::list_dir,
            workspace::read_text_file,
            workspace::write_text_file,
            workspace::list_files,
            workspace::create_text_file,
            workspace::create_dir,
            workspace::rename_path,
            workspace::trash_path,
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
            agent::queue_gates,
            catalog::commands_catalog,
            chats::chat_sessions,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_cwd,
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
            settings::settings_set_title_bar,
            settings::settings_title_bar,
            settings::settings_set_layout,
            launch::open_in_editor,
            omarchy::omarchy_subscribe,
            omarchy_shell::omarchy_integration_plan,
            omarchy_shell::omarchy_integration_apply,
            omarchy_shell::shell_status_set,
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
                instance::serve(listener, move |folder, view| {
                    let state = handle.state::<AppState>();
                    let open = state.workspace.lock().ok().and_then(|w| w.clone());
                    if let instance::Route::Open(f) = instance::route(folder.as_deref(), open.as_deref()) {
                        state.instance_inbox.push(f);
                    }
                    if let Some(v) = view {
                        state.instance_inbox.show(&v);
                    }
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.unminimize();
                        let _ = w.show();
                        let _ = w.set_focus();
                        // GTK's present() goes through xdg-activation, which the compositor
                        // may not honour; on Hyprland also ask it directly (hyprland.rs).
                        hyprland::raise_self();
                    }
                    true
                });
                *app.state::<AppState>().instance_socket.lock().expect("instance lock") = Some(path);
            }
            if let Ok(dir) = app.path().app_config_dir() {
                app.state::<AppState>().settings.set_path(dir.join("settings.json"));
            }
            // Title bar (settings.json `ui.titleBar`, read once here): native keeps the
            // system decorations and the GTK menu bar; custom drops both, and the window
            // draws its own bar with the same menu and the window controls. Always native
            // on a tiling window manager (`settings::effective_title_bar`).
            let state = app.state::<AppState>();
            let tiling = state.startup.lock().ok().is_some_and(|s| s.tiling_wm.is_some());
            let custom = state.settings.path().is_ok_and(|p| settings::title_bar_mode(&p, tiling) == "custom");
            if let Ok(mut s) = app.state::<AppState>().startup.lock() {
                s.title_bar = if custom { "custom" } else { "native" }.into();
            }
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Colony")
                .decorations(!custom);
            let window = if custom { window } else { window.menu(menu::build(app)?) };
            window
                .inner_size(1500.0, 950.0)
                .min_inner_size(900.0, 600.0)
                // WebKit's `javascript-can-access-clipboard` (Tauri leaves it off): without it
                // `navigator.clipboard.readText()` and `execCommand('paste')` are refused, so
                // the terminal's Ctrl+Shift+V and Monaco's menu Paste paste nothing.
                .enable_clipboard_access()
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
            if let Some(p) = omarchy_shell::status_path() {
                let _ = std::fs::remove_file(&p);
                if let Some(dir) = p.parent() {
                    let _ = std::fs::remove_dir(dir); // only when empty (the host-request spool may share it)
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    /// Colony embeds no web page (plan colony-sidebar-native-kit s3): every kit item is a
    /// native view, so the window allows no frame at all and no page defines a frame hook.
    #[test]
    fn no_frames_no_web_panel() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = conf["app"]["security"]["csp"].as_str().unwrap();
        assert!(csp.contains("frame-src 'none'"), "{csp}");
        assert!(!csp.contains("127.0.0.1"), "{csp}");
        let main = include_str!("../../src/main.ts");
        for gone in ["h(\"iframe\"", "__MISSION_CONTROL_ACTIONS__", "openWebPanel", "mc-action"] {
            assert!(!main.contains(gone), "src/main.ts still has {gone}");
        }
        assert!(!include_str!("../../src/menu.json").contains("\"web\""));
    }

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
