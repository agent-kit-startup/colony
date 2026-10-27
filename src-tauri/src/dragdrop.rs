//! Files dropped on the window from the desktop (Tauri's drag-drop event; src/droproute.ts
//! routes them). WebKit's HTML5 drop carries no paths, so the window keeps Tauri's native
//! handler, and this module remembers which host files the user dropped:
//!
//! - the workspace jail (workspace.rs) lets the editor open and save a dropped file,
//!   as it does for the agent context files (context.rs);
//! - `drop_copy` copies dropped files into a folder of the workspace (Explorer drop).
//!
//! Only paths that came from a real drop (or the smoke's stand-in) are accepted: the
//! frontend cannot name an arbitrary host file.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::State;

use crate::AppState;

/// Every file dropped on the window this session (canonical paths).
#[derive(Default)]
pub struct Dropped(Mutex<HashSet<PathBuf>>);

impl Dropped {
    /// Remember the files of one drop (folders are not remembered: nothing opens or
    /// copies them).
    pub fn record(&self, paths: &[PathBuf]) {
        let Ok(mut set) = self.0.lock() else { return };
        for p in paths {
            if let Ok(c) = p.canonicalize() {
                if c.is_file() {
                    set.insert(c);
                }
            }
        }
    }

    pub fn contains(&self, p: &Path) -> bool {
        self.0.lock().is_ok_and(|s| s.contains(p))
    }

    fn snapshot(&self) -> HashSet<PathBuf> {
        self.0.lock().map(|s| s.clone()).unwrap_or_default()
    }
}

/// (source, target) of each copy into `dest`, or why the drop cannot be copied. Each
/// source must be a dropped file; an existing target is never overwritten.
pub fn plan_copy(dropped: &HashSet<PathBuf>, paths: &[String], dest: &Path) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    let mut out: Vec<(PathBuf, PathBuf)> = Vec::new();
    for raw in paths {
        let from = Path::new(raw).canonicalize().map_err(|e| format!("Cannot read {raw}: {e}"))?;
        if from.is_dir() {
            return Err(format!("{} is a folder: only files are copied", from.display()));
        }
        if !dropped.contains(&from) {
            return Err(format!("{} was not dropped on this window", from.display()));
        }
        let name = from.file_name().ok_or_else(|| format!("Invalid file name: {}", from.display()))?;
        let to = dest.join(name);
        if to.exists() || out.iter().any(|(_, t)| *t == to) {
            return Err(format!("{} already exists", to.display()));
        }
        out.push((from, to));
    }
    Ok(out)
}

/// Copy dropped files into `dir` (a folder of the workspace). Returns the new paths.
#[tauri::command]
pub fn drop_copy(state: State<'_, AppState>, paths: Vec<String>, dir: String) -> Result<Vec<String>, String> {
    let dest = crate::workspace::jail(&state, &dir)?;
    if !dest.is_dir() {
        return Err(format!("Not a folder: {}", dest.display()));
    }
    let root = crate::workspace::workspace_root(&state)?;
    if !dest.starts_with(&root) {
        return Err(format!("Path is outside the workspace: {}", dest.display()));
    }
    let plan = plan_copy(&state.dropped.snapshot(), &paths, &dest)?;
    let mut done = Vec::new();
    for (from, to) in plan {
        std::fs::copy(&from, &to).map_err(|e| format!("Cannot copy {} to {}: {e}", from.display(), to.display()))?;
        done.push(to.display().to_string());
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("colony-drop-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    #[test]
    fn only_dropped_files_are_copied_and_nothing_is_overwritten() {
        let d = tmp("plan");
        let (src, ws) = (d.join("src"), d.join("ws"));
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(ws.join("sub")).unwrap();
        std::fs::write(src.join("a.txt"), "a").unwrap();
        std::fs::write(src.join("b.txt"), "b").unwrap();
        std::fs::write(ws.join("b.txt"), "old").unwrap();
        let dropped = Dropped::default();
        dropped.record(&[src.join("a.txt"), src.join("b.txt"), src.clone()]);
        let set = dropped.snapshot();
        assert_eq!(set.len(), 2, "folders are not remembered");
        let a = src.join("a.txt").display().to_string();
        assert_eq!(plan_copy(&set, &[a.clone()], &ws.join("sub")).unwrap(), vec![(src.join("a.txt"), ws.join("sub/a.txt"))]);
        let b = src.join("b.txt").display().to_string();
        assert!(plan_copy(&set, &[b], &ws).unwrap_err().contains("already exists"));
        assert!(plan_copy(&set, &[a.clone(), a], &ws).unwrap_err().contains("already exists"), "the same name twice");
        std::fs::write(src.join("c.txt"), "c").unwrap();
        let c = src.join("c.txt").display().to_string();
        assert!(plan_copy(&set, &[c], &ws).unwrap_err().contains("not dropped"));
        assert!(plan_copy(&set, &[src.display().to_string()], &ws).unwrap_err().contains("folder"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_dropped_path_is_matched_canonically() {
        let d = tmp("canon");
        std::fs::create_dir_all(d.join("x")).unwrap();
        std::fs::write(d.join("f.txt"), "f").unwrap();
        let dropped = Dropped::default();
        dropped.record(&[d.join("x/../f.txt")]);
        assert!(dropped.contains(&d.join("f.txt")));
        assert!(!dropped.contains(&d.join("x")));
        let _ = std::fs::remove_dir_all(&d);
    }
}
