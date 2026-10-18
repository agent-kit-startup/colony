//! Colony settings: one small JSON file in the Tauri app config dir
//! (`~/.config/io.missionkit.colony/settings.json` on Linux). Read fresh on every use so
//! an edit (in Colony or any editor) applies without a restart. Unknown fields are kept.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;

/// "Open in my editor". `command` is a string (split on whitespace) or an argv array; the
/// path is appended, or replaces a `{path}` argument. `terminal`: run it in a Colony
/// terminal tab (true) or detached (false); unset = decided per source (see editor.rs).
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct EditorSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal: Option<bool>,
}

/// Remembered per opened folder (keyed by its canonical path).
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_limit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_ticks: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub editor: EditorSettings,
    pub workspaces: BTreeMap<String, WorkspaceSettings>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

const TEMPLATE: &str = r#"{
  "editor": {},
  "workspaces": {}
}
"#;

pub fn load(path: &Path) -> Result<Settings, String> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(Settings::default()),
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(format!("Cannot read {}: {e}", path.display())),
    }
}

/// Write via a temp file + rename so a crash never leaves half a file.
pub fn save(path: &Path, s: &Settings) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let mut text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    text.push('\n');
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub fn settings_path(state: &AppState) -> Result<PathBuf, String> {
    state
        .settings_path
        .lock()
        .map_err(|_| "settings lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "No app config dir".to_string())
}

pub fn current(state: &AppState) -> Result<Settings, String> {
    load(&settings_path(state)?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsInfo {
    path: String,
    settings: Option<Settings>,
    error: Option<String>,
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Result<SettingsInfo, String> {
    let path = settings_path(&state)?;
    let (settings, error) = match load(&path) {
        Ok(s) => (Some(s), None),
        Err(e) => (None, Some(e)),
    };
    Ok(SettingsInfo { path: path.display().to_string(), settings, error })
}

/// Make sure the file exists (for opening it in the editor) and return its path.
#[tauri::command]
pub fn settings_ensure(state: State<'_, AppState>) -> Result<String, String> {
    let path = settings_path(&state)?;
    if !path.exists() {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, TEMPLATE).map_err(|e| e.to_string())?;
    }
    Ok(path.display().to_string())
}

/// Merge the given fields into the opened folder's entry (null clears a field).
#[tauri::command]
pub fn settings_set_workspace(state: State<'_, AppState>, patch: serde_json::Value) -> Result<WorkspaceSettings, String> {
    let root = crate::workspace::workspace_root(&state)?.display().to_string();
    let path = settings_path(&state)?;
    let mut s = load(&path)?;
    let mut entry = serde_json::to_value(s.workspaces.get(&root).cloned().unwrap_or_default()).map_err(|e| e.to_string())?;
    if let (Some(obj), Some(p)) = (entry.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            if v.is_null() {
                obj.remove(k);
            } else {
                obj.insert(k.clone(), v.clone());
            }
        }
    }
    let ws: WorkspaceSettings = serde_json::from_value(entry).map_err(|e| e.to_string())?;
    s.workspaces.insert(root, ws.clone());
    save(&path, &s)?;
    Ok(ws)
}

#[tauri::command]
pub fn settings_workspace(state: State<'_, AppState>) -> Result<WorkspaceSettings, String> {
    let root = crate::workspace::workspace_root(&state)?.display().to_string();
    Ok(current(&state)?.workspaces.get(&root).cloned().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_unknown_fields_and_round_trips() {
        let dir = std::env::temp_dir().join(format!("colony-settings-{}", std::process::id()));
        let path = dir.join("settings.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, r#"{"editor":{"command":"zed","terminal":false},"future":1,"workspaces":{"/r":{"backend":"claude","x":2}}}"#).unwrap();
        let s = load(&path).unwrap();
        assert_eq!(s.editor.terminal, Some(false));
        assert_eq!(s.workspaces["/r"].backend.as_deref(), Some("claude"));
        save(&path, &s).unwrap();
        let back: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back["future"], 1);
        assert_eq!(back["workspaces"]["/r"]["x"], 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_file_is_default() {
        let s = load(Path::new("/nonexistent/colony/settings.json")).unwrap();
        assert!(s.workspaces.is_empty());
    }
}
