//! Agent panel: drive `agent-kit run-plan --events ndjson` and, on an engine with driver
//! protocol 1.2.0 or newer, the queue runner `agent-kit run-plan-all --events ndjson`
//! (driver mode, see the kit's docs/driver-events-protocol.md). NDJSON events stream to
//! the UI; the operator's HITL answers go back as JSON lines on stdin. Colony never
//! answers a gate itself.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::{review, tools, workspace, AppState};

/// `agent-kit run-plan --backend` values (kit 6.6.0: packages/cli/src/plan-loop/detect.ts).
/// `openrouter` needs an engine that knows the id; an older kit refuses it.
pub(crate) const BACKENDS: &[&str] = &["auto", "claude", "codex", "cursor-acp", "cursor-agent", "openrouter"];

/// What the engine picker shows for each backend: the binary the kit resolves on PATH
/// and how a HITL answer reaches the agent (driver protocol "Scope").
const BACKEND_INFO: &[(&str, &str, &str)] = &[
    ("claude", "claude", "Claude Code; gate answers relayed on stdin"),
    ("codex", "codex", "Codex CLI (OpenAI API key by default); gate answers relayed by resuming the session"),
    ("cursor-acp", "cursor-agent", "Cursor agent over ACP (opt-in); gate answers relayed as the next prompt"),
    ("cursor-agent", "cursor-agent", "Cursor agent -p; no input channel: a gate ends the tick (stop: no relay)"),
    ("openrouter", "ori", "OpenRouter through Ori (ori login); Claude Code on OpenRouter credentials, gate answers relayed on stdin"),
    ("auto", "", "cursor-agent if on PATH, else claude (never codex, cursor-acp or openrouter)"),
];

/// Backends a kit only knows from some release on: the engine refuses the id before it.
const MIN_ENGINE: &[(&str, &str)] = &[("openrouter", "6.6.0")];

/// Driver protocol from which `run-plan-all` has `--events ndjson` (the kit's protocol doc,
/// "Queue runner"). An older engine runs the queue in a terminal tab (vendor.rs).
pub(crate) const QUEUE_DRIVER_PROTOCOL: &str = "1.2.0";

/// Whether an engine announcing driver protocol `protocol` runs the queue as a driver run.
/// Unknown or unparsable: no, the terminal tab is the safe path.
pub(crate) fn queue_driver(protocol: Option<&str>) -> bool {
    let Some(have) = protocol.and_then(|p| semver::Version::parse(p.trim()).ok()) else { return false };
    let Ok(min) = semver::Version::parse(QUEUE_DRIVER_PROTOCOL) else { return false };
    have.major == crate::engine::DRIVER_PROTOCOL_MAJOR && have >= min
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueMode {
    /// true: start the queue with `agent_start` (command `run-plan-all`); false: terminal tab.
    driver: bool,
    /// The driver protocol the engine announced, when it could be read.
    protocol: Option<String>,
    note: String,
}

fn queue_mode_for(protocol: Option<String>) -> QueueMode {
    let driver = queue_driver(protocol.as_deref());
    let note = if driver {
        "Queue runner as a driver run: its gates reach the Inbox".to_string()
    } else {
        format!(
            "Engine driver protocol {} has no run-plan-all driver mode (needs {QUEUE_DRIVER_PROTOCOL}): the queue opens in a terminal tab; update the engine in More → Engine",
            protocol.as_deref().unwrap_or("unknown")
        )
    };
    QueueMode { driver, protocol, note }
}

/// How "Run queue" starts `run-plan-all` with the current engine (may probe the engine CLI,
/// so it runs off the main thread).
#[tauri::command]
pub async fn queue_mode() -> Result<QueueMode, String> {
    tauri::async_runtime::spawn_blocking(|| queue_mode_for(crate::engine::kit_driver_protocol())).await.map_err(|e| e.to_string())
}

/// The vendor CLIs of the backend table (`claude`, `codex`, `cursor-agent`; may repeat).
pub(crate) fn vendor_bins() -> impl Iterator<Item = &'static str> {
    BACKEND_INFO.iter().map(|(_, bin, _)| *bin).filter(|b| !b.is_empty())
}

/// The engine version `backend` needs when the engine's `version` is known and older.
/// An unknown or unparsable version never blocks: the kit itself has the last word.
fn needs_engine(backend: &str, version: Option<&str>) -> Option<&'static str> {
    let (_, min) = MIN_ENGINE.iter().find(|(id, _)| *id == backend)?;
    let have = semver::Version::parse(version?.trim()).ok()?;
    (have < semver::Version::parse(min).ok()?).then_some(*min)
}

fn engine_too_old(backend: &str, version: Option<&str>) -> Result<(), String> {
    match needs_engine(backend, version) {
        Some(min) => Err(format!(
            "{} needs engine {min} or newer (current {}): update it in More → Engine",
            if backend == "openrouter" { "OpenRouter" } else { backend },
            version.unwrap_or("?")
        )),
        None => Ok(()),
    }
}

/// Refuse a backend the engine that runs `agent-kit` (engine::kit_command) does not know.
pub(crate) fn check_engine(backend: &str) -> Result<(), String> {
    engine_too_old(backend, crate::engine::kit_version().as_deref())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendChoice {
    id: String,
    bin: String,
    available: bool,
    note: String,
    /// The engine version this backend needs, when the current engine is older.
    needs_engine: Option<String>,
}

#[tauri::command]
pub fn agent_backends() -> Vec<BackendChoice> {
    let version = crate::engine::kit_version();
    BACKEND_INFO
        .iter()
        .map(|(id, bin, note)| {
            let available = if bin.is_empty() {
                ["cursor-agent", "claude"].iter().any(|b| tools::find_bin(b, None).is_some())
            } else {
                tools::find_bin(bin, None).is_some()
            };
            let needs_engine = needs_engine(id, version.as_deref()).map(String::from);
            BackendChoice { id: (*id).into(), bin: (*bin).into(), available, note: (*note).into(), needs_engine }
        })
        .collect()
}

/// `--model` is passed through to the backend: keep it to a plain model id.
pub(crate) fn valid_model(m: &str) -> bool {
    !m.is_empty() && m.len() <= 120 && !m.starts_with('-') && m.chars().all(|c| c.is_ascii_alphanumeric() || "._:/@[]-".contains(c))
}

/// One `run-plan` driver process. Several can run at once (one per folder: the kit has no
/// run lock, so two runs on the same plan would race), and every open gate across them
/// lands in the Inbox.
pub struct AgentRun {
    root: PathBuf,
    child: Arc<Mutex<Child>>,
    stdin: Option<ChildStdin>,
}

impl AgentRun {
    pub fn kill(&mut self) {
        self.stdin = None;
        if let Ok(mut c) = self.child.lock() {
            let _ = c.kill();
        }
    }

    fn alive(&self) -> bool {
        matches!(self.child.lock().map(|mut c| c.try_wait()), Ok(Ok(None)))
    }
}

#[derive(Default)]
pub struct AgentRegistry {
    next: AtomicU32,
    runs: Mutex<HashMap<u32, AgentRun>>,
}

impl AgentRegistry {
    pub fn kill_all(&self) {
        if let Ok(mut map) = self.runs.lock() {
            for (_, mut run) in map.drain() {
                run.kill();
            }
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentEvent {
    /// One stdout line (an NDJSON event; the UI parses it).
    Event { line: String },
    /// One stderr line (human text, not part of the contract).
    Stderr { line: String },
    Exit { code: Option<i32> },
    /// A tick closed: what it changed in the working tree (review.rs).
    Review { review: crate::review::TickReview },
}

#[cfg(test)]
mod tests {
    #[test]
    fn model_ids() {
        for ok in ["claude-opus-5-5", "gpt-5.1-codex", "sonnet[1m]", "us.anthropic.x:0"] {
            assert!(super::valid_model(ok), "{ok}");
        }
        for bad in ["", "--dangerous", "a b", "x;rm", &"m".repeat(121)] {
            assert!(!super::valid_model(bad), "{bad}");
        }
    }

    #[test]
    fn engine_floor() {
        use super::{engine_too_old, needs_engine};
        assert_eq!(needs_engine("openrouter", Some("6.4.0")), Some("6.6.0"));
        assert_eq!(needs_engine("openrouter", Some("6.6.0-rc.1")), Some("6.6.0"));
        assert_eq!(needs_engine("openrouter", Some("6.6.0")), None);
        assert_eq!(needs_engine("openrouter", Some("7.0.0")), None);
        // Unknown engine (override, PATH fallback, unreadable checkout): never blocks.
        assert_eq!(needs_engine("openrouter", None), None);
        assert_eq!(needs_engine("openrouter", Some("?")), None);
        assert_eq!(needs_engine("claude", Some("5.0.0")), None);
        let e = engine_too_old("openrouter", Some("6.4.0")).unwrap_err();
        assert!(e.contains("OpenRouter needs engine 6.6.0") && e.contains("current 6.4.0") && e.contains("More → Engine"), "{e}");
        assert!(engine_too_old("codex", Some("6.4.0")).is_ok());
    }

    #[test]
    fn queue_driver_floor() {
        use super::{queue_driver, queue_mode_for, queue_args};
        assert!(queue_driver(Some("1.2.0")));
        assert!(queue_driver(Some("1.3.1")));
        // Older 1.x, a pre-release of 1.2.0, another major, unknown: terminal tab.
        for old in [Some("1.1.0"), Some("1.2.0-rc.1"), Some("2.0.0"), Some("?"), None] {
            assert!(!queue_driver(old), "{old:?}");
        }
        let m = queue_mode_for(Some("1.1.0".into()));
        assert!(!m.driver && m.note.contains("1.1.0") && m.note.contains("terminal tab"), "{}", m.note);
        assert!(queue_mode_for(Some("1.2.0".into())).driver);
        assert!(queue_mode_for(None).note.contains("unknown"));
        // The queue runner's argv: no tick budget, no --on-limit (run-plan-all has neither).
        assert_eq!(queue_args("claude", None), ["run-plan-all", "--events", "ndjson", "--backend", "claude"]);
        assert_eq!(queue_args("codex", Some("gpt-5.1")), ["run-plan-all", "--events", "ndjson", "--backend", "codex", "--model", "gpt-5.1"]);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStarted {
    id: u32,
    cmd: String,
    root: String,
    backend: String,
    /// `run-plan` (tick loop) or `run-plan-all` (the queue runner).
    command: String,
}

/// `agent-kit run-plan-all` argv in driver mode (one session: no ticks, no --on-limit).
fn queue_args(backend: &str, model: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = ["run-plan-all", "--events", "ndjson", "--backend", backend].map(String::from).into();
    if let Some(m) = model {
        args.extend(["--model".to_string(), m.to_string()]);
    }
    args
}

/// Start a driver run in the opened folder, or in `cwd` (another folder the operator
/// picked, e.g. a second repository or a worktree). `command` is `run-plan` (default) or
/// `run-plan-all`, the queue runner, which needs driver protocol 1.2.0 (`queue_mode`).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn agent_start(
    state: State<'_, AppState>,
    backend: String,
    max_ticks: Option<u32>,
    cwd: Option<String>,
    on_limit: Option<String>,
    model: Option<String>,
    command: Option<String>,
    on_event: Channel<AgentEvent>,
) -> Result<AgentStarted, String> {
    if !BACKENDS.contains(&backend.as_str()) {
        return Err(format!("Unknown backend: {backend}"));
    }
    check_engine(&backend)?;
    let command = command.unwrap_or_else(|| "run-plan".into());
    let queue = match command.as_str() {
        "run-plan" => false,
        "run-plan-all" => true,
        other => return Err(format!("Unknown run command: {other}")),
    };
    let on_limit = on_limit.filter(|b| !b.trim().is_empty());
    if queue && on_limit.is_some() {
        return Err("run-plan-all has no --on-limit (one session, no ticks)".into());
    }
    if let Some(b) = &on_limit {
        if b == "auto" || !BACKENDS.contains(&b.as_str()) {
            return Err(format!("Unknown --on-limit backend: {b}"));
        }
        check_engine(b)?;
    }
    let model = model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    if let Some(m) = &model {
        if !valid_model(m) {
            return Err(format!("Not a model id: {m}"));
        }
    }
    let root = match cwd.filter(|c| !c.trim().is_empty()) {
        Some(c) => PathBuf::from(&c).canonicalize().map_err(|e| format!("Cannot use {c}: {e}"))?,
        None => workspace::workspace_root(&state)?,
    };
    if !root.is_dir() {
        return Err(format!("Not a folder: {}", root.display()));
    }
    let mut runs = state.agents.runs.lock().map_err(|_| "agent lock poisoned")?;
    runs.retain(|_, r| r.alive());
    if runs.values().any(|r| r.root == root) {
        return Err(format!("A run is already active in {} (the kit has no run lock: one run per folder)", root.display()));
    }
    if queue {
        let protocol = crate::engine::kit_driver_protocol();
        if !queue_driver(protocol.as_deref()) {
            return Err(queue_mode_for(protocol).note);
        }
    }
    let kit = crate::engine::kit_command()?;
    let id = state.agents.next.fetch_add(1, Ordering::SeqCst) + 1;
    let args: Vec<String> = if queue {
        queue_args(&backend, model.as_deref())
    } else {
        let ticks = max_ticks.unwrap_or(10).clamp(1, 200).to_string();
        let mut args: Vec<String> = ["run-plan", "--events", "ndjson", "--backend", backend.as_str(), "--max-ticks", ticks.as_str()].map(String::from).into();
        if let Some(b) = &on_limit {
            args.extend(["--on-limit".to_string(), b.clone()]);
        }
        if let Some(m) = &model {
            args.extend(["--model".to_string(), m.clone()]);
        }
        args
    };
    let mut cmd = Command::new(&kit.program);
    tools::die_with_parent(&mut cmd);
    let mut child = cmd
        .args(&kit.args)
        .args(&args)
        .arg("--cwd")
        .arg(&root)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{command} failed to start: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let stdin = child.stdin.take();
    let child = Arc::new(Mutex::new(child));

    let ch_out = on_event.clone();
    let reviews = state.reviews.clone();
    let mut tracker = review::RunTracker::new(id, root.clone(), backend.clone());
    let out_thread = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let closed = tracker.on_line(&line, &reviews);
            if ch_out.send(AgentEvent::Event { line }).is_err() {
                break;
            }
            if let Some(review) = closed {
                let _ = ch_out.send(AgentEvent::Review { review });
            }
        }
        if let Some(review) = tracker.on_end(&reviews) {
            let _ = ch_out.send(AgentEvent::Review { review });
        }
    });
    let ch_err = on_event.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            let _ = ch_err.send(AgentEvent::Stderr { line });
        }
    });
    let waiter = child.clone();
    std::thread::spawn(move || {
        let code = loop {
            let status = waiter.lock().ok().and_then(|mut c| c.try_wait().ok()).flatten();
            if let Some(st) = status {
                break st.code();
            }
            std::thread::sleep(Duration::from_millis(250));
        };
        let _ = out_thread.join();
        let _ = on_event.send(AgentEvent::Exit { code });
    });

    runs.insert(id, AgentRun { root: root.clone(), child, stdin });
    Ok(AgentStarted {
        id,
        cmd: format!("{} {} --cwd {}", kit.display(), args.join(" "), root.display()),
        root: root.display().to_string(),
        backend,
        command,
    })
}

fn send_line(state: &AppState, run_id: u32, value: serde_json::Value) -> Result<(), String> {
    let mut runs = state.agents.runs.lock().map_err(|_| "agent lock poisoned")?;
    let run = runs.get_mut(&run_id).ok_or("That run is no longer active")?;
    let stdin = run.stdin.as_mut().ok_or("The run's input is closed")?;
    let mut line = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

/// Relay the operator's answer to the open gate: `reply` is a 1-based number, an exact
/// label, or free text (driver protocol "Answers").
#[tauri::command]
pub fn agent_reply(state: State<'_, AppState>, run_id: u32, ask_id: String, reply: serde_json::Value) -> Result<(), String> {
    match &reply {
        serde_json::Value::Number(n) if n.as_u64().is_some_and(|v| v >= 1) => {}
        serde_json::Value::String(s) if !s.trim().is_empty() => {}
        _ => return Err("Reply must be a 1-based number or non-empty text".into()),
    }
    send_line(&state, run_id, serde_json::json!({ "type": "hitl_reply", "askId": ask_id, "reply": reply }))
}

/// `{"type":"stop"}` ends the run at the open gate (exit 4, cause "driver stop").
#[tauri::command]
pub fn agent_stop(state: State<'_, AppState>, run_id: u32) -> Result<(), String> {
    send_line(&state, run_id, serde_json::json!({ "type": "stop" }))
}

/// Hard stop for a run that is mid-tick (no gate open to receive `stop`).
#[tauri::command]
pub fn agent_kill(state: State<'_, AppState>, run_id: u32) -> Result<(), String> {
    if let Some(run) = state.agents.runs.lock().map_err(|_| "agent lock poisoned")?.get_mut(&run_id) {
        run.kill();
    }
    Ok(())
}
