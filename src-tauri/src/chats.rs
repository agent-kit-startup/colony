//! Saved agent chats of the opened folder, so the cockpit can list them and resume one in
//! a terminal tab (vendor.rs `--resume`).
//!
//! Claude Code saves every session as `~/.claude/projects/<slug>/<session-uuid>.jsonl`,
//! `<slug>` being the session's start folder through `context::project_slug` (the same
//! name Claude Code builds, long folders included). Only the
//! top-level `<uuid>.jsonl` files are sessions: subagent transcripts live under
//! `<slug>/<uuid>/subagents/` and are not listed. Each line is one JSON record; the title
//! is the last `custom-title` record (a name the user set), else the last `ai-title`
//! record, else the first real user prompt. Files can be tens of MB: they are streamed
//! line by line, only lines that contain a marker are parsed, and the result is cached
//! by (path, mtime, size), so a refresh only rescans files that changed.
//!
//! Read-only, and nothing but the id, title, time and size leaves this module.
//! Other vendors report `unsupported` (their session stores are not read yet).

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::{agent, context, workspace, AppState};

/// Sessions returned per call (newest first); `total` still counts all of them.
const MAX_SESSIONS: usize = 200;
/// Characters kept of a first-prompt title.
const TITLE_CHARS: usize = 80;
/// User-record text Claude Code writes itself (slash commands, `!` shell, reminders).
const HARNESS_PREFIXES: &[&str] = &["<command-", "<local-command-", "<bash-", "<system-reminder>", "[Request interrupted"];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatSession {
    pub id: String,
    pub title: String,
    /// `custom`, `ai`, `first-prompt` or `none`.
    pub title_source: String,
    /// Last write, Unix milliseconds.
    pub modified: u64,
    pub size_bytes: u64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatList {
    pub vendor: String,
    /// `ok`, or `unsupported` for a vendor whose sessions Colony does not read yet.
    pub status: String,
    pub note: String,
    /// The folder the sessions were read from (`ok` only).
    pub dir: Option<String>,
    /// Every session found; `sessions` holds at most `MAX_SESSIONS` of them.
    pub total: usize,
    pub sessions: Vec<ChatSession>,
}

/// A Claude Code session id: a lowercase UUID (`8-4-4-4-12` hex digits).
pub fn is_session_id(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_digit() || ('a'..='f').contains(&c),
        })
}

type Cached = (u128, u64, String, &'static str);

fn cache() -> &'static Mutex<HashMap<PathBuf, Cached>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Cached>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// One line of text, whitespace collapsed, cut at `TITLE_CHARS`.
fn clip(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= TITLE_CHARS {
        return flat;
    }
    let mut out: String = flat.chars().take(TITLE_CHARS - 1).collect();
    out.push('…');
    out
}

fn prompt_text(text: &str) -> Option<String> {
    let t = text.trim();
    (!t.is_empty() && !HARNESS_PREFIXES.iter().any(|p| t.starts_with(p))).then(|| clip(t))
}

/// The operator's prompt in a `user` record, if it is one (not meta, a command echo or a
/// tool result).
fn user_prompt(rec: &Value) -> Option<String> {
    if rec.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    match rec.get("message")?.get("content")? {
        Value::String(s) => prompt_text(s),
        Value::Array(items) => {
            if items.iter().any(|i| i.get("type").and_then(Value::as_str) == Some("tool_result")) {
                return None;
            }
            items.iter().filter(|i| i.get("type").and_then(Value::as_str) == Some("text")).find_map(|i| prompt_text(i.get("text")?.as_str()?))
        }
        _ => None,
    }
}

/// Title and its source from a session transcript. Malformed lines are skipped.
fn scan_title(mut reader: impl BufRead) -> (String, &'static str) {
    let (mut custom, mut ai, mut first) = (None::<String>, None::<String>, None::<String>);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let want_user = first.is_none() && contains(&line, br#""type":"user""#);
        if !want_user && !contains(&line, b"\"custom-title\"") && !contains(&line, b"\"ai-title\"") {
            continue;
        }
        let Ok(rec) = serde_json::from_slice::<Value>(&line) else { continue };
        let text = |k: &str| rec.get(k).and_then(Value::as_str).map(clip).filter(|t| !t.is_empty());
        match rec.get("type").and_then(Value::as_str) {
            Some("custom-title") => custom = text("customTitle").or(custom),
            Some("ai-title") => ai = text("aiTitle").or(ai),
            Some("user") if first.is_none() => first = user_prompt(&rec),
            _ => {}
        }
    }
    match (custom, ai, first) {
        (Some(t), _, _) => (t, "custom"),
        (_, Some(t), _) => (t, "ai"),
        (_, _, Some(t)) => (t, "first-prompt"),
        _ => (String::new(), "none"),
    }
}

fn title_of(path: &Path, mtime: u128, size: u64) -> (String, &'static str) {
    if let Some((m, s, t, src)) = cache().lock().ok().and_then(|c| c.get(path).cloned()) {
        if m == mtime && s == size {
            return (t, src);
        }
    }
    let Ok(f) = std::fs::File::open(path) else { return (String::new(), "none") };
    let (title, src) = scan_title(BufReader::new(f));
    if let Ok(mut c) = cache().lock() {
        c.insert(path.to_path_buf(), (mtime, size, title.clone(), src));
    }
    (title, src)
}

/// The Claude Code sessions started in `cwd`, newest first. No project folder yet is an
/// empty list; any other read error is an error.
fn claude_sessions(home: &Path, cwd: &Path) -> Result<ChatList, String> {
    let dir = home.join(".claude/projects").join(context::project_slug(&cwd.display().to_string()));
    let mut found: Vec<(PathBuf, String, u128, u64)> = Vec::new();
    match std::fs::read_dir(&dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("{}: {e}", dir.display())),
        Ok(read) => {
            for e in read.flatten() {
                let path = e.path();
                let Some(id) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".jsonl")).map(String::from) else { continue };
                if !is_session_id(&id) || !e.file_type().is_ok_and(|t| t.is_file()) {
                    continue;
                }
                let Ok(meta) = e.metadata() else { continue };
                let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
                found.push((path, id, mtime, meta.len()));
            }
        }
    }
    found.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.1.cmp(&b.1)));
    let total = found.len();
    let sessions = found
        .into_iter()
        .take(MAX_SESSIONS)
        .map(|(path, id, mtime, size)| {
            let (title, src) = title_of(&path, mtime, size);
            ChatSession { id, title, title_source: src.into(), modified: (mtime / 1_000_000) as u64, size_bytes: size }
        })
        .collect();
    let note = if total > MAX_SESSIONS { format!("{total} sessions: the newest {MAX_SESSIONS} are listed") } else { String::new() };
    Ok(ChatList { vendor: "claude".into(), status: "ok".into(), note, dir: Some(dir.display().to_string()), total, sessions })
}

/// Saved sessions of `vendor` (a vendor CLI of the backend table) started in `cwd`.
pub fn list(vendor: &str, home: &Path, cwd: &Path) -> Result<ChatList, String> {
    if !agent::vendor_bins().any(|b| b == vendor) {
        return Err(format!("Unknown vendor CLI: {vendor}"));
    }
    if vendor == "claude" {
        return claude_sessions(home, cwd);
    }
    Ok(ChatList {
        vendor: vendor.into(),
        status: "unsupported".into(),
        note: format!("Listing saved {vendor} sessions is not supported yet"),
        dir: None,
        total: 0,
        sessions: Vec::new(),
    })
}

/// The saved chats of the opened folder (`vendor` defaults to `claude`).
#[tauri::command]
pub async fn chat_sessions(state: State<'_, AppState>, vendor: Option<String>) -> Result<ChatList, String> {
    let root = workspace::workspace_root(&state)?;
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("HOME is not set")?;
    let vendor = vendor.unwrap_or_else(|| "claude".into());
    tauri::async_runtime::spawn_blocking(move || list(&vendor, &home, &root)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "0b5c3a52-1f6e-4c1a-9d1e-6a2f3b4c5d6e";
    const B: &str = "1c6d4b63-2a7f-4d2b-8e2f-7b3a4c5d6e7f";
    const C: &str = "2d7e5c74-3b8a-4e3c-9f3a-8c4b5d6e7f80";
    const D: &str = "3e8f6d85-4c9b-4f4d-8a4b-9d5c6e7f8091";

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("colony-chats-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    fn write(p: &Path, body: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    fn age(p: &Path, secs_ago: u64) {
        let t = std::time::SystemTime::now() - std::time::Duration::from_secs(secs_ago);
        std::fs::File::options().write(true).open(p).unwrap().set_modified(t).unwrap();
    }

    fn title(body: &str) -> (String, &'static str) {
        scan_title(body.as_bytes())
    }

    #[test]
    fn session_ids() {
        assert!(is_session_id(A));
        for bad in ["", "0b5c3a52-1f6e-4c1a-9d1e-6a2f3b4c5d6", "0B5C3A52-1F6E-4C1A-9D1E-6A2F3B4C5D6E", "0b5c3a52x1f6e-4c1a-9d1e-6a2f3b4c5d6e", "--resume", "0b5c3a52-1f6e-4c1a-9d1e-6a2f3b4c5d6e;rm", "../../../../etc/passwd/xxxxxxxxxxxxxx"] {
            assert!(!is_session_id(bad), "{bad}");
        }
    }

    #[test]
    fn project_folder_slug() {
        // Same folder name Claude Code uses: `/` and `.` both become `-`.
        assert_eq!(context::project_slug("/home/u/agent-kit-dev"), "-home-u-agent-kit-dev");
        assert_eq!(context::project_slug("/home/u/repo/.cursor/x"), "-home-u-repo--cursor-x");
    }

    #[test]
    fn title_precedence_custom_then_ai_then_first_prompt() {
        let user = r#"{"type":"user","message":{"role":"user","content":"Fix the   login\nbug"}}"#;
        let ai = |t: &str| format!(r#"{{"type":"ai-title","aiTitle":"{t}","sessionId":"x"}}"#);
        let custom = |t: &str| format!(r#"{{"type":"custom-title","customTitle":"{t}","sessionId":"x"}}"#);
        assert_eq!(title(&format!("{user}\n{}\n{}\n{}\n", ai("first ai"), custom("mine"), ai("last ai"))), ("mine".into(), "custom"));
        assert_eq!(title(&format!("{}\n{user}\n{}\n{}\n", custom("old"), ai("x"), custom("renamed"))), ("renamed".into(), "custom"));
        assert_eq!(title(&format!("{user}\n{}\n{}\n", ai("first ai"), ai("last ai"))), ("last ai".into(), "ai"));
        assert_eq!(title(&format!("{user}\n")), ("Fix the login bug".into(), "first-prompt"));
        assert_eq!(title(""), (String::new(), "none"));
    }

    #[test]
    fn first_prompt_skips_harness_records_and_is_clipped() {
        let body = [
            r#"{"type":"user","isMeta":true,"message":{"content":"<local-command-caveat>Caveat</local-command-caveat>"}}"#,
            r#"{"type":"user","message":{"content":"<command-name>/clear</command-name>"}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"text","text":"<system-reminder>x</system-reminder>"},{"type":"text","text":"oxe e os chats num ficam salvos não? quero uma lista de chats (ou terminais-chat), com resume e um título bem comprido"}]}}"#,
            r#"{"type":"user","message":{"content":"a later prompt"}}"#,
        ]
        .join("\n");
        let (t, src) = title(&body);
        assert_eq!(src, "first-prompt");
        assert!(t.starts_with("oxe e os chats num ficam salvos não?"), "{t}");
        assert_eq!(t.chars().count(), TITLE_CHARS);
        assert!(t.ends_with('…'));
    }

    #[test]
    fn malformed_lines_are_skipped() {
        let body = "not json \"ai-title\"\n{\"type\":\"ai-title\",\"aiTitle\":\n\u{0}\u{ff}garbage\n{\"type\":\"ai-title\",\"aiTitle\":\"Good title\"}\n{\"type\":\"custom-title\",\"customTitle\":\"\"}\n";
        assert_eq!(title(body), ("Good title".into(), "ai"));
        // Invalid UTF-8 on a line does not stop the scan.
        let mut bytes = b"{\"type\":\"user\",\"message\":{\"content\":\"\xff\xfe\"}}\n".to_vec();
        bytes.extend_from_slice(b"{\"type\":\"ai-title\",\"aiTitle\":\"After bad bytes\"}");
        assert_eq!(scan_title(&bytes[..]), ("After bad bytes".into(), "ai"));
    }

    #[test]
    fn lists_top_level_sessions_newest_first_without_subagents() {
        let root = scratch("list");
        let home = root.join("home");
        let cwd = root.join("code/my.repo");
        std::fs::create_dir_all(&cwd).unwrap();
        let dir = home.join(".claude/projects").join(context::project_slug(&cwd.display().to_string()));
        assert!(dir.display().to_string().ends_with("-code-my-repo"));
        write(&dir.join(format!("{A}.jsonl")), "{\"type\":\"custom-title\",\"customTitle\":\"colony-terminal\"}\n");
        write(&dir.join(format!("{B}.jsonl")), "{\"type\":\"ai-title\",\"aiTitle\":\"Synch plans\"}\n");
        write(&dir.join(format!("{C}.jsonl")), "{\"type\":\"user\",\"message\":{\"content\":\"hello there\"}}\n");
        // Not sessions: a subagent transcript, a non-uuid file, a folder named `<uuid>.jsonl`.
        write(&dir.join(A).join("subagents/agent-1.jsonl"), "{\"type\":\"ai-title\",\"aiTitle\":\"sub\"}\n");
        write(&dir.join(format!("{D}.jsonl")).join("x"), "{}\n");
        write(&dir.join("notes.jsonl"), "{}\n");
        write(&dir.join("memory/MEMORY.md"), "- x\n");
        age(&dir.join(format!("{A}.jsonl")), 10);
        age(&dir.join(format!("{B}.jsonl")), 200);
        age(&dir.join(format!("{C}.jsonl")), 3000);
        let l = list("claude", &home, &cwd).unwrap();
        assert_eq!((l.status.as_str(), l.total), ("ok", 3));
        let got: Vec<_> = l.sessions.iter().map(|s| (s.id.as_str(), s.title.as_str(), s.title_source.as_str())).collect();
        assert_eq!(got, vec![(A, "colony-terminal", "custom"), (B, "Synch plans", "ai"), (C, "hello there", "first-prompt")]);
        assert!(l.sessions[0].modified > l.sessions[1].modified && l.sessions[0].size_bytes > 0);
        // The cache follows (mtime, size): a rename is picked up.
        write(&dir.join(format!("{B}.jsonl")), "{\"type\":\"ai-title\",\"aiTitle\":\"Synch plans\"}\n{\"type\":\"custom-title\",\"customTitle\":\"renamed\"}\n");
        age(&dir.join(format!("{B}.jsonl")), 5);
        let l = list("claude", &home, &cwd).unwrap();
        assert_eq!((l.sessions[0].id.as_str(), l.sessions[0].title.as_str()), (B, "renamed"));
        // No project folder yet: an empty list, not an error.
        let other = list("claude", &home, &root).unwrap();
        assert_eq!((other.status.as_str(), other.total), ("ok", 0));
        // A project path that cannot be read is an error, not "no chats".
        let odd = root.join("code/odd");
        std::fs::create_dir_all(&odd).unwrap();
        write(&home.join(".claude/projects").join(context::project_slug(&odd.display().to_string())), "not a folder\n");
        let err = list("claude", &home, &odd).unwrap_err();
        assert!(err.contains("-code-odd"), "{err}");
    }

    #[test]
    fn other_vendors_are_reported_unsupported() {
        let root = scratch("vendors");
        for v in ["codex", "cursor-agent"] {
            let l = list(v, &root, &root).unwrap();
            assert_eq!((l.status.as_str(), l.sessions.len()), ("unsupported", 0), "{v}");
            assert!(l.note.contains("not supported"));
        }
        assert!(list("bash", &root, &root).is_err());
        assert!(list("", &root, &root).is_err());
    }
}
