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
