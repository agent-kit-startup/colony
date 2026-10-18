//! Integrated terminals: one PTY per tab running the user's shell, streamed to xterm.js
//! over a Tauri channel.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::{tools, workspace, AppState};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyRegistry {
    next: AtomicU32,
    sessions: Arc<Mutex<HashMap<u32, Session>>>,
}

impl PtyRegistry {
    pub fn kill_all(&self) {
        if let Ok(mut map) = self.sessions.lock() {
            for (_, mut s) in map.drain() {
                let _ = s.child.kill();
            }
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PtyEvent {
    Data { data: String },
    Exit { code: Option<u32> },
}

/// Split `pending` into the longest valid UTF-8 prefix; keep an incomplete trailing
/// sequence for the next read so multibyte characters are never cut in half.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_string();
            pending.clear();
            out
        }
        Err(e) if e.error_len().is_none() => {
            let valid = e.valid_up_to();
            let out = String::from_utf8_lossy(&pending[..valid]).to_string();
            pending.drain(..valid);
            out
        }
        Err(_) => {
            let out = String::from_utf8_lossy(pending).to_string();
            pending.clear();
            out
        }
    }
}

#[tauri::command]
pub fn pty_spawn(
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    let cwd = workspace::workspace_root(&state)
        .ok()
        .or_else(|| std::env::var_os("HOME").map(Into::into))
        .unwrap_or_else(|| "/".into());
    let pair = native_pty_system()
        .openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty failed: {e}"))?;
    let mut cmd = CommandBuilder::new(tools::user_shell());
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "colony");
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("shell failed to start: {e}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = state.ptys.next.fetch_add(1, Ordering::SeqCst) + 1;
    state
        .ptys
        .sessions
        .lock()
        .map_err(|_| "pty lock poisoned")?
        .insert(id, Session { master: pair.master, writer, child });

    let sessions = state.ptys.sessions.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut pending: Vec<u8> = Vec::with_capacity(32 * 1024);
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let text = take_utf8(&mut pending);
                    if !text.is_empty() && on_event.send(PtyEvent::Data { data: text }).is_err() {
                        break;
                    }
                }
            }
        }
        let code = sessions
            .lock()
            .ok()
            .and_then(|mut m| m.remove(&id))
            .and_then(|mut s| s.child.wait().ok())
            .map(|st| st.exit_code());
        let _ = on_event.send(PtyEvent::Exit { code });
    });
    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<'_, AppState>, id: u32, data: String) -> Result<(), String> {
    let mut map = state.ptys.sessions.lock().map_err(|_| "pty lock poisoned")?;
    let s = map.get_mut(&id).ok_or("terminal is closed")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, AppState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let map = state.ptys.sessions.lock().map_err(|_| "pty lock poisoned")?;
    let s = map.get(&id).ok_or("terminal is closed")?;
    s.master
        .resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, AppState>, id: u32) -> Result<(), String> {
    let mut map = state.ptys.sessions.lock().map_err(|_| "pty lock poisoned")?;
    if let Some(s) = map.get_mut(&id) {
        let _ = s.child.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::take_utf8;

    #[test]
    fn keeps_incomplete_multibyte_tail() {
        let bytes = "ação".as_bytes().to_vec();
        let mut pending = bytes[..2].to_vec(); // "a" + first byte of "ç"
        assert_eq!(take_utf8(&mut pending), "a");
        assert_eq!(pending.len(), 1);
        pending.extend_from_slice(&bytes[2..]);
        assert_eq!(take_utf8(&mut pending), "ção");
        assert!(pending.is_empty());
    }
}
