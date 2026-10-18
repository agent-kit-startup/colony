//! Agent panel: drive `agent-kit run-plan --events ndjson` (driver mode, see the kit's
//! docs/driver-events-protocol.md). NDJSON events stream to the UI; the operator's
//! HITL answers go back as JSON lines on stdin. Colony never answers a gate itself.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::{tools, workspace, AppState};

const BACKENDS: &[&str] = &["auto", "claude", "codex", "cursor-acp", "cursor-agent"];

pub struct AgentRun {
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
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentEvent {
    /// One stdout line (an NDJSON event; the UI parses it).
    Event { line: String },
    /// One stderr line (human text, not part of the contract).
    Stderr { line: String },
    Exit { code: Option<i32> },
}

#[tauri::command]
pub fn agent_start(
    state: State<'_, AppState>,
    backend: String,
    max_ticks: Option<u32>,
    on_event: Channel<AgentEvent>,
) -> Result<String, String> {
    if !BACKENDS.contains(&backend.as_str()) {
        return Err(format!("Unknown backend: {backend}"));
    }
    let root = workspace::workspace_root(&state)?;
    let mut guard = state.agent.lock().map_err(|_| "agent lock poisoned")?;
    if let Some(run) = guard.as_ref() {
        if matches!(run.child.lock().map(|mut c| c.try_wait()), Ok(Ok(None))) {
            return Err("A run is already active in this window".into());
        }
    }
    let bin = tools::agent_kit_bin().ok_or("agent-kit CLI not found on PATH")?;
    let ticks = max_ticks.unwrap_or(10).clamp(1, 200).to_string();
    let args = ["run-plan", "--events", "ndjson", "--backend", backend.as_str(), "--max-ticks", ticks.as_str()];
    let mut cmd = Command::new(&bin);
    tools::die_with_parent(&mut cmd);
    let mut child = cmd
        .args(args)
        .arg("--cwd")
        .arg(&root)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("run-plan failed to start: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let stdin = child.stdin.take();
    let child = Arc::new(Mutex::new(child));

    let ch_out = on_event.clone();
    let out_thread = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if ch_out.send(AgentEvent::Event { line }).is_err() {
                break;
            }
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

    *guard = Some(AgentRun { child, stdin });
    Ok(format!("{} {} --cwd {}", bin.display(), args.join(" "), root.display()))
}

fn send_line(state: &AppState, value: serde_json::Value) -> Result<(), String> {
    let mut guard = state.agent.lock().map_err(|_| "agent lock poisoned")?;
    let run = guard.as_mut().ok_or("No run is active")?;
    let stdin = run.stdin.as_mut().ok_or("The run's input is closed")?;
    let mut line = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

/// Relay the operator's answer to the open gate: `reply` is a 1-based number, an exact
/// label, or free text (driver protocol "Answers").
#[tauri::command]
pub fn agent_reply(state: State<'_, AppState>, ask_id: String, reply: serde_json::Value) -> Result<(), String> {
    match &reply {
        serde_json::Value::Number(n) if n.as_u64().is_some_and(|v| v >= 1) => {}
        serde_json::Value::String(s) if !s.trim().is_empty() => {}
        _ => return Err("Reply must be a 1-based number or non-empty text".into()),
    }
    send_line(&state, serde_json::json!({ "type": "hitl_reply", "askId": ask_id, "reply": reply }))
}

/// `{"type":"stop"}` ends the run at the open gate (exit 4, cause "driver stop").
#[tauri::command]
pub fn agent_stop(state: State<'_, AppState>) -> Result<(), String> {
    send_line(&state, serde_json::json!({ "type": "stop" }))
}

/// Hard stop for a run that is mid-tick (no gate open to receive `stop`).
#[tauri::command]
pub fn agent_kill(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(run) = state.agent.lock().map_err(|_| "agent lock poisoned")?.as_mut() {
        run.kill();
    }
    Ok(())
}
