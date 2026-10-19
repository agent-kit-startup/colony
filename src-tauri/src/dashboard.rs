//! Mission Control home: run the installed kit's unforked dashboard server
//! (`<agent-kit package>/dashboard/serve.mjs`) for the opened workspace on a free
//! loopback port, per the embeddable contract (`MISSION_CONTROL_REPO_ROOT`, `PORT`).

use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;

use crate::{tools, workspace, AppState};

pub struct DashboardServer {
    child: Child,
    port: u16,
    root: PathBuf,
    serve: PathBuf,
}

impl Drop for DashboardServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardInfo {
    url: String,
    port: u16,
    serve_path: String,
    log_path: String,
}

/// `COLONY_DASHBOARD_SERVE`, else `realpath(agent-kit)/../../dashboard/serve.mjs`
/// (the npm package layout: `<pkg>/dist/cli.js` next to `<pkg>/dashboard/`).
/// A version-manager shim (mise: `shims/agent-kit -> /usr/bin/mise`) is resolved
/// through `mise which agent-kit`; the last fallback is `npm root -g`.
fn serve_script() -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("COLONY_DASHBOARD_SERVE") {
        let p = PathBuf::from(p);
        return if p.is_file() { Ok(p) } else { Err(format!("COLONY_DASHBOARD_SERVE not found: {}", p.display())) };
    }
    let bin = tools::agent_kit_bin().ok_or("agent-kit CLI not found on PATH (install @dadado/agent-kit-cli)")?;
    let real = bin.canonicalize().map_err(|e| e.to_string())?;
    if let Some(found) = serve_next_to(&real) {
        return Ok(found);
    }
    if real.file_name().is_some_and(|n| n == "mise") {
        if let Some(found) = command_stdout(&real, &["which", "agent-kit"])
            .and_then(|p| PathBuf::from(p).canonicalize().ok())
            .and_then(|p| serve_next_to(&p))
        {
            return Ok(found);
        }
    }
    if let Some(found) = tools::find_bin("npm", None)
        .and_then(|npm| command_stdout(&npm, &["root", "-g"]))
        .map(|root| PathBuf::from(root).join("@dadado/agent-kit-cli/dashboard/serve.mjs"))
        .filter(|p| p.is_file())
    {
        return Ok(found);
    }
    Err(format!("dashboard/serve.mjs not found next to {}", real.display()))
}

fn serve_next_to(real: &std::path::Path) -> Option<PathBuf> {
    real.ancestors()
        .skip(1)
        .take(3)
        .map(|anc| anc.join("dashboard/serve.mjs"))
        .find(|cand| cand.is_file())
}

/// First line of a short helper command's stdout, or None on any failure.
fn command_stdout(bin: &std::path::Path, args: &[&str]) -> Option<String> {
    let out = Command::new(bin).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_string();
    (!line.is_empty()).then_some(line)
}

fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    Ok(l.local_addr().map_err(|e| e.to_string())?.port())
}

fn log_dir() -> PathBuf {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("colony")
}

fn info(s: &DashboardServer) -> DashboardInfo {
    DashboardInfo {
        url: format!("http://127.0.0.1:{}/", s.port),
        port: s.port,
        serve_path: s.serve.display().to_string(),
        log_path: log_dir().join(format!("dashboard-{}.log", s.port)).display().to_string(),
    }
}

#[tauri::command]
pub async fn dashboard_start(state: State<'_, AppState>) -> Result<DashboardInfo, String> {
    let root = workspace::workspace_root(&state)?;
    {
        let mut guard = state.dashboard.lock().map_err(|_| "dashboard lock poisoned")?;
        if let Some(s) = guard.as_mut() {
            let alive = matches!(s.child.try_wait(), Ok(None));
            if alive && s.root == root {
                return Ok(info(s));
            }
        }
        *guard = None; // drops (kills) a server for another folder or a dead one
    }
    let serve = serve_script()?;
    let node = tools::node_bin().ok_or("node not found on PATH")?;
    let port = free_port()?;
    let dir = log_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let log_path = dir.join(format!("dashboard-{port}.log"));
    let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(node);
    tools::die_with_parent(&mut cmd);
    let child = cmd
        .arg(&serve)
        .current_dir(&root)
        .env("MISSION_CONTROL_REPO_ROOT", &root)
        .env("PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .spawn()
        .map_err(|e| format!("dashboard server failed to start: {e}"))?;
    let mut server = DashboardServer { child, port, root, serve };

    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(200)).is_ok() {
            break;
        }
        if let Ok(Some(status)) = server.child.try_wait() {
            let tail = std::fs::read_to_string(&log_path).unwrap_or_default();
            return Err(format!("dashboard server exited ({status}): {}", tail.trim()));
        }
        if Instant::now() > deadline {
            return Err(format!("dashboard server did not listen on {port} within 15 s; log: {}", log_path.display()));
        }
        tokio_sleep(Duration::from_millis(150)).await;
    }
    let out = info(&server);
    *state.dashboard.lock().map_err(|_| "dashboard lock poisoned")? = Some(server);
    Ok(out)
}

/// Sleep without blocking an async worker (no direct tokio dependency).
async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

#[tauri::command]
pub fn dashboard_stop(state: State<'_, AppState>) -> Result<(), String> {
    *state.dashboard.lock().map_err(|_| "dashboard lock poisoned")? = None;
    Ok(())
}
