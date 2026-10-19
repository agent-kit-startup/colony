//! Native Mission Control data: a read-only client of the per-workspace kit server
//! (dashboard.rs). The Colony page cannot read the server itself (its origin is not
//! `http://127.0.0.1:<port>`, and the server only answers CORS for its own origin), so
//! Rust fetches `GET /dashboard-data.json` and holds the `/api/events` SSE stream,
//! forwarding each snapshot payload unchanged over a Tauri channel. Snapshot contract:
//! the kit's `docs/contracts/mission-control-snapshot.schema.json`; Colony never writes
//! to the server.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::AppState;

/// Bumped on every new subscription: an older stream thread sees it and ends.
#[derive(Default)]
pub struct McFeed {
    generation: AtomicU64,
}

const MAX_BODY: usize = 32 * 1024 * 1024;

fn server_port(state: &AppState) -> Result<u16, String> {
    state
        .dashboard
        .lock()
        .map_err(|_| "dashboard lock poisoned")?
        .as_ref()
        .map(|s| s.port())
        .ok_or_else(|| "Mission Control server is not running".to_string())
}

/// `GET <path>` as HTTP/1.0 (the server then closes the connection instead of chunking).
fn connect(port: u16, path: &str, read_timeout: Option<Duration>) -> Result<BufReader<TcpStream>, String> {
    let mut s = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(2)).map_err(|e| format!("Mission Control server: {e}"))?;
    s.set_read_timeout(read_timeout).map_err(|e| e.to_string())?;
    write!(s, "GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAccept: */*\r\n\r\n").map_err(|e| e.to_string())?;
    Ok(BufReader::new(s))
}

/// Status code and lower-cased headers; leaves the reader at the body.
fn read_head(r: &mut impl BufRead) -> Result<(u16, Vec<(String, String)>), String> {
    let mut line = String::new();
    r.read_line(&mut line).map_err(|e| e.to_string())?;
    let code = line.split_whitespace().nth(1).and_then(|c| c.parse().ok()).ok_or_else(|| format!("Bad HTTP status line: {}", line.trim()))?;
    let mut headers = Vec::new();
    loop {
        line.clear();
        if r.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            break;
        }
        let l = line.trim_end();
        if l.is_empty() {
            break;
        }
        if let Some((k, v)) = l.split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    Ok((code, headers))
}

fn is_chunked(headers: &[(String, String)]) -> bool {
    headers.iter().any(|(k, v)| k == "transfer-encoding" && v.to_ascii_lowercase().contains("chunked"))
}

/// Decode a chunked body (only used if a server ignores the HTTP/1.0 request).
fn dechunk(r: &mut impl BufRead) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let mut size = String::new();
        if r.read_line(&mut size).map_err(|e| e.to_string())? == 0 {
            return Ok(out);
        }
        let n = usize::from_str_radix(size.trim().split(';').next().unwrap_or(""), 16).map_err(|_| format!("Bad chunk size: {}", size.trim()))?;
        if n == 0 {
            return Ok(out);
        }
        if out.len() + n > MAX_BODY {
            return Err("Snapshot too large".into());
        }
        let start = out.len();
        out.resize(start + n, 0);
        r.read_exact(&mut out[start..]).map_err(|e| e.to_string())?;
        let mut crlf = [0u8; 2];
        r.read_exact(&mut crlf).map_err(|e| e.to_string())?;
    }
}

fn get_body(port: u16, path: &str) -> Result<(u16, String), String> {
    let mut r = connect(port, path, Some(Duration::from_secs(60)))?;
    let (code, headers) = read_head(&mut r)?;
    let body = if is_chunked(&headers) {
        dechunk(&mut r)?
    } else {
        let mut b = Vec::new();
        r.take(MAX_BODY as u64 + 1).read_to_end(&mut b).map_err(|e| e.to_string())?;
        if b.len() > MAX_BODY {
            return Err("Snapshot too large".into());
        }
        b
    };
    Ok((code, String::from_utf8(body).map_err(|_| "Snapshot is not UTF-8".to_string())?))
}

/// One snapshot (the raw JSON text; the page parses it).
#[tauri::command]
pub async fn mc_snapshot(state: State<'_, AppState>) -> Result<String, String> {
    let port = server_port(&state)?;
    let (code, body) = tauri::async_runtime::spawn_blocking(move || get_body(port, "/dashboard-data.json")).await.map_err(|e| e.to_string())??;
    if code != 200 {
        return Err(format!("dashboard-data.json: HTTP {code}"));
    }
    Ok(body)
}

/// `GET /api/config`, when the installed kit serves it (6.2.0 routes only PUT/PATCH and
/// answers 404 here: then `None`, and the views use the snapshot's `system` summary).
#[tauri::command]
pub async fn mc_config(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let port = server_port(&state)?;
    let (code, body) = tauri::async_runtime::spawn_blocking(move || get_body(port, "/api/config")).await.map_err(|e| e.to_string())??;
    Ok((code == 200).then_some(body))
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum McEvent {
    /// One SSE `data:` payload: a full snapshot JSON text.
    Snapshot { data: String },
    /// The stream is (re)connected or lost; the page shows it in the status bar.
    Status { connected: bool, detail: String },
}

/// Collects SSE fields: `data:` lines join with `\n`, a blank line ends the event,
/// comments (`:heartbeat`) are ignored.
#[derive(Default)]
struct SseParser {
    data: Vec<String>,
}

impl SseParser {
    fn line(&mut self, raw: &str) -> Option<String> {
        let l = raw.strip_suffix('\n').unwrap_or(raw);
        let l = l.strip_suffix('\r').unwrap_or(l);
        if l.is_empty() {
            if self.data.is_empty() {
                return None;
            }
            return Some(std::mem::take(&mut self.data).join("\n"));
        }
        if l.starts_with(':') {
            return None;
        }
        let (field, value) = match l.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (l, ""),
        };
        if field == "data" {
            self.data.push(value.to_string());
        }
        None
    }
}

/// Hold `/api/events` open and forward every snapshot; reconnect with backoff while this
/// is the newest subscription and the page still listens.
#[tauri::command]
pub fn mc_subscribe(state: State<'_, AppState>, on_event: Channel<McEvent>) -> Result<(), String> {
    let port = server_port(&state)?;
    let generation = state.mc_feed.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let feed = state.mc_feed.clone();
    std::thread::spawn(move || {
        let current = || feed.generation.load(Ordering::SeqCst) == generation;
        let mut backoff = Duration::from_millis(500);
        while current() {
            match connect(port, "/api/events", Some(Duration::from_secs(75))).and_then(|mut r| read_head(&mut r).map(|h| (r, h))) {
                Ok((mut r, (200, _))) => {
                    backoff = Duration::from_millis(500);
                    if on_event.send(McEvent::Status { connected: true, detail: format!("SSE 127.0.0.1:{port}/api/events") }).is_err() {
                        return;
                    }
                    let mut parser = SseParser::default();
                    let mut line = String::new();
                    loop {
                        line.clear();
                        match r.read_line(&mut line) {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {}
                        }
                        if !current() {
                            return;
                        }
                        if let Some(data) = parser.line(&line) {
                            if on_event.send(McEvent::Snapshot { data }).is_err() {
                                return;
                            }
                        }
                    }
                    if !current() || on_event.send(McEvent::Status { connected: false, detail: "SSE stream closed; reconnecting".into() }).is_err() {
                        return;
                    }
                }
                Ok((_, (code, _))) => {
                    if on_event.send(McEvent::Status { connected: false, detail: format!("SSE HTTP {code}") }).is_err() {
                        return;
                    }
                }
                Err(e) => {
                    if on_event.send(McEvent::Status { connected: false, detail: e }).is_err() {
                        return;
                    }
                }
            }
            std::thread::sleep(backoff);
            backoff = (backoff * 2).min(Duration::from_secs(10));
        }
    });
    Ok(())
}

/// Stop the current stream (folder closed or switched).
pub fn mc_unsubscribe(state: &AppState) {
    state.mc_feed.generation.fetch_add(1, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::{dechunk, read_head, SseParser};
    use std::io::Cursor;

    #[test]
    fn sse_joins_data_lines_and_skips_comments() {
        let mut p = SseParser::default();
        let mut got = Vec::new();
        for l in [":heartbeat\n", "\n", "data: {\"a\":1,\n", "data: \"b\":2}\r\n", "\r\n", "event: x\n", "data:z\n", "\n"] {
            if let Some(d) = p.line(l) {
                got.push(d);
            }
        }
        assert_eq!(got, vec!["{\"a\":1,\n\"b\":2}".to_string(), "z".to_string()]);
    }

    #[test]
    fn head_and_chunked_body() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"a\"\r\n3\r\n:1}\r\n0\r\n\r\n";
        let mut r = Cursor::new(&raw[..]);
        let (code, headers) = read_head(&mut r).unwrap();
        assert_eq!(code, 200);
        assert!(super::is_chunked(&headers));
        assert_eq!(dechunk(&mut r).unwrap(), b"{\"a\":1}");
    }

    #[test]
    fn bad_status_line_is_an_error() {
        let mut r = Cursor::new(&b"garbage\r\n\r\n"[..]);
        assert!(read_head(&mut r).is_err());
    }
}
