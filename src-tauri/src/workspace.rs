//! Workspace folder: open, list, read and write files. Every path is jailed to the
//! opened workspace root (canonicalized, `starts_with`).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::AppState;

const MAX_READ_BYTES: u64 = 10 * 1024 * 1024;
/// Directory names hidden from the tree (still reachable through the terminal).
const HIDDEN_DIRS: &[&str] = &[".git"];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub root: String,
    pub name: String,
    pub is_git: bool,
    pub has_kit: bool,
    pub has_handoff: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}

pub fn workspace_root(state: &AppState) -> Result<PathBuf, String> {
    state
        .workspace
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "No folder is open".to_string())
}

/// Resolve `p` inside the workspace. For a path that does not exist yet, the parent must.
pub fn jail(state: &AppState, p: &str) -> Result<PathBuf, String> {
    let root = workspace_root(state)?;
    let raw = PathBuf::from(p);
    let candidate = if raw.is_absolute() { raw } else { root.join(raw) };
    let resolved = match candidate.canonicalize() {
        Ok(c) => c,
        Err(_) => {
            let parent = candidate
                .parent()
                .ok_or_else(|| "Invalid path".to_string())?
                .canonicalize()
                .map_err(|e| format!("Parent folder not found: {e}"))?;
            let file = candidate
                .file_name()
                .ok_or_else(|| "Invalid file name".to_string())?;
            parent.join(file)
        }
    };
    // The Colony settings file is the one path outside the folder the editor may open.
    let settings_file = crate::settings::settings_path(state)
        .ok()
        .and_then(|s| Some(s.parent()?.canonicalize().ok()?.join(s.file_name()?)));
    if settings_file.is_some_and(|s| s == resolved) {
        return Ok(resolved);
    }
    if !resolved.starts_with(&root) {
        return Err(format!("Path is outside the workspace: {}", resolved.display()));
    }
    Ok(resolved)
}

pub fn describe(root: &Path) -> WorkspaceInfo {
    WorkspaceInfo {
        root: root.display().to_string(),
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| root.display().to_string()),
        is_git: root.join(".git").exists(),
        has_kit: root.join(".cursor/agent-kit.json").exists(),
        has_handoff: root.join(".cursor/HANDOFF.md").exists(),
    }
}

#[tauri::command]
pub fn open_workspace(state: State<'_, AppState>, path: String) -> Result<WorkspaceInfo, String> {
    let root = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("Cannot open {path}: {e}"))?;
    if !root.is_dir() {
        return Err(format!("Not a folder: {}", root.display()));
    }
    *state.workspace.lock().map_err(|_| "workspace lock poisoned")? = Some(root.clone());
    Ok(describe(&root))
}

#[tauri::command]
pub fn list_dir(state: State<'_, AppState>, path: String) -> Result<Vec<Entry>, String> {
    let dir = jail(&state, &path)?;
    let read = std::fs::read_dir(&dir).map_err(|e| format!("Cannot list {}: {e}", dir.display()))?;
    let mut out: Vec<Entry> = read
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let ft = e.file_type().ok()?;
            // Follow symlinks for the dir/file decision; a broken link is shown as a file.
            let is_dir = if ft.is_symlink() { e.path().is_dir() } else { ft.is_dir() };
            if is_dir && HIDDEN_DIRS.contains(&name.as_str()) {
                return None;
            }
            Some(Entry { name, path: e.path().display().to_string(), is_dir })
        })
        .collect();
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
pub fn read_text_file(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let file = jail(&state, &path)?;
    let meta = std::fs::metadata(&file).map_err(|e| format!("Cannot read {}: {e}", file.display()))?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!("File is larger than {} MB", MAX_READ_BYTES / 1024 / 1024));
    }
    let bytes = std::fs::read(&file).map_err(|e| format!("Cannot read {}: {e}", file.display()))?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Err("Binary file (not opened in the editor)".into());
    }
    String::from_utf8(bytes).map_err(|_| "File is not valid UTF-8".to_string())
}

#[tauri::command]
pub fn write_text_file(state: State<'_, AppState>, path: String, contents: String) -> Result<(), String> {
    let file = jail(&state, &path)?;
    std::fs::write(&file, contents).map_err(|e| format!("Cannot save {}: {e}", file.display()))
}

/// Directories skipped by quick open (build output and dependency trees).
const SKIP_IN_WALK: &[&str] = &[".git", "node_modules", "target", "dist", ".next", ".venv", "__pycache__", ".turbo"];
const MAX_WALK_FILES: usize = 50_000;

/// Every file under the workspace (relative paths), for quick open. Capped.
#[tauri::command]
pub fn list_files(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let root = workspace_root(&state)?;
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        for e in read.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            let name = e.file_name();
            let name = name.to_string_lossy();
            if ft.is_dir() {
                if !SKIP_IN_WALK.contains(&name.as_ref()) {
                    stack.push(e.path());
                }
            } else if ft.is_file() {
                if let Ok(rel) = e.path().strip_prefix(&root) {
                    out.push(rel.display().to_string());
                }
                if out.len() >= MAX_WALK_FILES {
                    return Ok(out);
                }
            }
        }
    }
    out.sort();
    Ok(out)
}
