//! Per-tick review: what each agent tick changed in the working tree.
//!
//! A snapshot is a git tree object of the whole working tree (tracked changes, deletions
//! and new untracked files; `.gitignore` respected), written through a throwaway index
//! (`GIT_INDEX_FILE`), so the real index, the worktree and the refs are never touched.
//! The driver run takes snapshot S0 at `run_start` and Sn at each `tick_end`; tick n's
//! review is the tree diff Sn-1..Sn. Chaining tick ends (instead of snapshotting at
//! `tick_start`) means no agent write is lost to the race with the agent starting up; an
//! edit you make between two ticks shows up in the next tick's review.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

use crate::{tools, AppState};

const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// `A`, `M`, `D`, `R`, `C`, `T` (git name-status letter).
    pub status: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TickReview {
    pub run_id: u32,
    pub tick: u32,
    pub backend: String,
    /// Repository top level: review paths are relative to it.
    pub toplevel: String,
    pub head_before: Option<String>,
    pub head_after: Option<String>,
    pub files: Vec<FileChange>,
    pub result_line: Option<String>,
    /// `false` when the run ended mid-tick (killed or crashed): the review covers what
    /// was on disk at that point.
    pub finished: bool,
    pub at: String,
    #[serde(skip)]
    base: String,
    #[serde(skip)]
    head: String,
}

#[derive(Clone)]
pub struct Snapshot {
    tree: String,
    head: Option<String>,
}

#[derive(Default)]
pub struct ReviewStore {
    ticks: Mutex<Vec<TickReview>>,
}

fn git(root: &Path, args: &[&str], index: Option<&Path>) -> Result<String, String> {
    let bin = tools::git_bin().ok_or("git not found on PATH")?;
    let mut cmd = Command::new(bin);
    cmd.arg("-C").arg(root).args(args).stdin(Stdio::null());
    if let Some(i) = index {
        cmd.env("GIT_INDEX_FILE", i);
    }
    let out = cmd.output().map_err(|e| format!("git failed to start: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(format!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

pub fn toplevel(root: &Path) -> Option<PathBuf> {
    git(root, &["rev-parse", "--show-toplevel"], None).ok().map(|s| PathBuf::from(s.trim()))
}

/// Tree object of the current working tree, via a temp copy of the real index (the copy
/// keeps git's stat cache, so unchanged files are not re-hashed).
pub fn snapshot(root: &Path) -> Result<Snapshot, String> {
    let top = toplevel(root).ok_or("not a git repository")?;
    let real_index = git(&top, &["rev-parse", "--git-path", "index"], None)?;
    let real_index = {
        let p = PathBuf::from(real_index.trim());
        if p.is_absolute() { p } else { top.join(p) }
    };
    let tmp = std::env::temp_dir().join(format!("colony-review-{}-{}.index", std::process::id(), unique()));
    if real_index.is_file() {
        std::fs::copy(&real_index, &tmp).map_err(|e| format!("copy index: {e}"))?;
    }
    let result = (|| {
        git(&top, &["add", "-A", "--", "."], Some(&tmp))?;
        git(&top, &["write-tree"], Some(&tmp))
    })();
    let _ = std::fs::remove_file(&tmp);
    let tree = result?.trim().to_string();
    let head = git(&top, &["rev-parse", "--verify", "-q", "HEAD"], None).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    Ok(Snapshot { tree, head })
}

fn unique() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::SeqCst)
}

/// Parse `git diff --name-status -z` output.
fn parse_name_status(raw: &str) -> Vec<FileChange> {
    let mut out = Vec::new();
    let mut it = raw.split('\0').filter(|s| !s.is_empty());
    while let Some(code) = it.next() {
        let letter = code.chars().next().unwrap_or('?').to_string();
        if letter == "R" || letter == "C" {
            let (Some(old), Some(new)) = (it.next(), it.next()) else { break };
            out.push(FileChange { status: letter, path: new.into(), old_path: Some(old.into()) });
        } else {
            let Some(p) = it.next() else { break };
            out.push(FileChange { status: letter, path: p.into(), old_path: None });
        }
    }
    out
}

fn changes(top: &Path, base: &str, head: &str) -> Result<Vec<FileChange>, String> {
    Ok(parse_name_status(&git(top, &["diff", "--name-status", "-z", "-M", base, head], None)?))
}

/// Follows one driver run's NDJSON stream (fed from the stdout reader thread).
pub struct RunTracker {
    run_id: u32,
    root: PathBuf,
    backend: String,
    last: Option<Snapshot>,
    open_tick: Option<u32>,
    disabled: bool,
}

#[derive(serde::Deserialize)]
struct MiniEvent {
    #[serde(rename = "type")]
    kind: Option<String>,
    tick: Option<u32>,
    backend: Option<String>,
    result: Option<serde_json::Value>,
}

impl RunTracker {
    pub fn new(run_id: u32, root: PathBuf, backend: String) -> Self {
        let disabled = toplevel(&root).is_none();
        RunTracker { run_id, root, backend, last: None, open_tick: None, disabled }
    }

    /// Feed one stdout line; returns a finished tick review when this line closed a tick.
    pub fn on_line(&mut self, line: &str, store: &ReviewStore) -> Option<TickReview> {
        if self.disabled {
            return None;
        }
        let ev: MiniEvent = serde_json::from_str(line).ok()?;
        match ev.kind.as_deref()? {
            "run_start" => {
                self.last = snapshot(&self.root).ok();
                None
            }
            "tick_start" => {
                if let Some(b) = ev.backend {
                    self.backend = b;
                }
                self.open_tick = ev.tick;
                None
            }
            "tick_end" => {
                let tick = ev.tick.or(self.open_tick)?;
                self.open_tick = None;
                let line = ev.result.as_ref().and_then(|r| r.get("line")).and_then(|l| l.as_str()).map(String::from);
                self.close(tick, line, true, store)
            }
            _ => None,
        }
    }

    /// The stream ended: record a tick that never reached `tick_end`.
    pub fn on_end(&mut self, store: &ReviewStore) -> Option<TickReview> {
        let tick = self.open_tick.take()?;
        if self.disabled {
            return None;
        }
        self.close(tick, None, false, store)
    }

    fn close(&mut self, tick: u32, result_line: Option<String>, finished: bool, store: &ReviewStore) -> Option<TickReview> {
        let before = self.last.clone()?;
        let after = snapshot(&self.root).ok()?;
        let top = toplevel(&self.root)?;
        let files = changes(&top, &before.tree, &after.tree).unwrap_or_default();
        let review = TickReview {
            run_id: self.run_id,
            tick,
            backend: self.backend.clone(),
            toplevel: top.display().to_string(),
            head_before: before.head.clone(),
            head_after: after.head.clone(),
            files,
            result_line,
            finished,
            at: now_iso(),
            base: before.tree.clone(),
            head: after.tree.clone(),
        };
        self.last = Some(after);
        if let Ok(mut ticks) = store.ticks.lock() {
            ticks.push(review.clone());
        }
        Some(review)
    }
}

fn now_iso() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // Civil date from days since the epoch (Howard Hinnant's algorithm), UTC.
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[tauri::command]
pub fn review_ticks(state: State<'_, AppState>) -> Result<Vec<TickReview>, String> {
    Ok(state.reviews.ticks.lock().map_err(|_| "review lock poisoned")?.clone())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersions {
    before: Option<String>,
    after: Option<String>,
    /// Set when a side is binary or too large to show.
    note: Option<String>,
}

fn blob(top: &Path, tree: &str, path: &str) -> Result<Option<String>, String> {
    let spec = format!("{tree}:{path}");
    if git(top, &["cat-file", "-e", &spec], None).is_err() {
        return Ok(None);
    }
    let bin = tools::git_bin().ok_or("git not found on PATH")?;
    let out = Command::new(bin).arg("-C").arg(top).args(["cat-file", "blob", &spec]).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    if out.stdout.len() > MAX_FILE_BYTES {
        return Err(format!("larger than {} MB", MAX_FILE_BYTES / 1024 / 1024));
    }
    if out.stdout.iter().take(8192).any(|b| *b == 0) {
        return Err("binary file".into());
    }
    Ok(Some(String::from_utf8_lossy(&out.stdout).to_string()))
}

/// Both sides of one file in one tick, for the diff editor.
#[tauri::command]
pub fn review_file(state: State<'_, AppState>, run_id: u32, tick: u32, path: String, old_path: Option<String>) -> Result<FileVersions, String> {
    let review = state
        .reviews
        .ticks
        .lock()
        .map_err(|_| "review lock poisoned")?
        .iter()
        .find(|t| t.run_id == run_id && t.tick == tick)
        .cloned()
        .ok_or("No review for that tick")?;
    if !review.files.iter().any(|f| f.path == path) {
        return Err("That file did not change in this tick".into());
    }
    let top = PathBuf::from(&review.toplevel);
    let mut note = None;
    let before = blob(&top, &review.base, old_path.as_deref().unwrap_or(&path)).unwrap_or_else(|e| {
        note = Some(e);
        None
    });
    let after = blob(&top, &review.head, &path).unwrap_or_else(|e| {
        note = Some(e);
        None
    });
    Ok(FileVersions { before, after, note })
}

/// Unified patch for one tick (capped), e.g. to copy into a review comment.
#[tauri::command]
pub fn review_patch(state: State<'_, AppState>, run_id: u32, tick: u32) -> Result<String, String> {
    let review = state
        .reviews
        .ticks
        .lock()
        .map_err(|_| "review lock poisoned")?
        .iter()
        .find(|t| t.run_id == run_id && t.tick == tick)
        .cloned()
        .ok_or("No review for that tick")?;
    let mut out = git(Path::new(&review.toplevel), &["diff", "-M", &review.base, &review.head], None)?;
    if out.len() > 400 * 1024 {
        out.truncate(400 * 1024);
        out.push_str("\n... (patch truncated)\n");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, args: &[&str]) {
        let ok = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap().status.success();
        assert!(ok, "git {args:?}");
    }

    #[test]
    fn name_status_parses_renames() {
        let raw = "M\0a.txt\0R100\0old.txt\0new.txt\0A\0b c.md\0";
        let got = parse_name_status(raw);
        assert_eq!(got.len(), 3);
        assert_eq!(got[1], FileChange { status: "R".into(), path: "new.txt".into(), old_path: Some("old.txt".into()) });
        assert_eq!(got[2].path, "b c.md");
    }

    #[test]
    fn tick_review_sees_new_untracked_and_leaves_index_alone() {
        let dir = std::env::temp_dir().join(format!("colony-review-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        sh(&dir, &["init", "-q"]);
        sh(&dir, &["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"]);
        std::fs::write(dir.join("keep.txt"), "one\n").unwrap();
        std::fs::write(dir.join(".gitignore"), "ignored.log\n").unwrap();
        let store = ReviewStore::default();
        let mut t = RunTracker::new(7, dir.clone(), "claude".into());
        assert!(t.on_line(r#"{"type":"run_start"}"#, &store).is_none());
        t.on_line(r#"{"type":"tick_start","tick":1,"backend":"codex"}"#, &store);
        std::fs::write(dir.join("keep.txt"), "two\n").unwrap();
        std::fs::write(dir.join("new.txt"), "fresh\n").unwrap();
        std::fs::write(dir.join("ignored.log"), "x\n").unwrap();
        let r = t.on_line(r#"{"type":"tick_end","tick":1,"result":{"line":"LOOP_TICK_RESULT: continue"}}"#, &store).unwrap();
        let mut paths: Vec<_> = r.files.iter().map(|f| format!("{} {}", f.status, f.path)).collect();
        paths.sort();
        assert_eq!(paths, vec!["A new.txt", "M keep.txt"]);
        assert_eq!(r.backend, "codex");
        assert_eq!(r.result_line.as_deref(), Some("LOOP_TICK_RESULT: continue"));
        // The real index is untouched: nothing staged.
        let staged = git(&dir, &["diff", "--cached", "--name-only"], None).unwrap();
        assert!(staged.trim().is_empty(), "staged: {staged}");
        // Next tick only shows its own change; a kill mid-tick still records it.
        t.on_line(r#"{"type":"tick_start","tick":2}"#, &store);
        std::fs::remove_file(dir.join("new.txt")).unwrap();
        let r2 = t.on_end(&store).unwrap();
        assert!(!r2.finished);
        assert_eq!(r2.files, vec![FileChange { status: "D".into(), path: "new.txt".into(), old_path: None }]);
        assert_eq!(blob(&dir, &r2.base, "new.txt").unwrap().as_deref(), Some("fresh\n"));
        assert_eq!(blob(&dir, &r2.head, "new.txt").unwrap(), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn iso_date_shape() {
        let s = now_iso();
        assert_eq!(s.len(), 20);
        assert!(s.starts_with("20") && s.ends_with('Z'));
    }
}
