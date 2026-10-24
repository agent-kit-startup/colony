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

/// Look of the whole window. `skin`: `bare-metal` (default), `legacy`, or `omarchy` (the
/// live Omarchy theme, the default on Omarchy when unset); Colony also selects the
/// matching skin of the Mission Control web panel.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct UiSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skin: Option<String>,
    /// Window title bar: `native` (default: the system or window manager draws it) or
    /// `custom` (no system decorations; Colony draws the bar, its menu and the window
    /// controls). Read when the window opens, so a change applies on the next start.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_bar: Option<String>,
    /// Panels: where the terminal is docked, what is shown, the splitter sizes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout: Option<LayoutSettings>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// The window layout, saved on every panel change and applied when the window opens.
/// Sizes are CSS pixels; an unset field keeps Colony's default.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LayoutSettings {
    /// `bottom`, `top` or `side`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_dock: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_visible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explorer_visible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explorer_width: Option<u32>,
    /// Terminal panel height, docked at the bottom or the top.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_height: Option<u32>,
    /// Terminal panel width, docked at the side.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_width: Option<u32>,
}

pub const DOCKS: &[&str] = &["bottom", "top", "side"];
/// Sizes outside this range are refused (a typo in settings.json, not a real window).
const LAYOUT_PX: std::ops::RangeInclusive<u64> = 40..=8000;

/// Merge a patch into the layout: a known field set to a valid value replaces it, `null`
/// clears it, anything else is an error (nothing is written then).
pub fn merge_layout(mut l: LayoutSettings, patch: &serde_json::Value) -> Result<LayoutSettings, String> {
    let obj = patch.as_object().ok_or("layout patch must be an object")?;
    for (k, v) in obj {
        let px = |v: &serde_json::Value| -> Result<Option<u32>, String> {
            if v.is_null() {
                return Ok(None);
            }
            match v.as_u64() {
                Some(n) if LAYOUT_PX.contains(&n) => Ok(Some(n as u32)),
                _ => Err(format!("layout.{k}: {v} is not a size in pixels")),
            }
        };
        let flag = |v: &serde_json::Value| -> Result<Option<bool>, String> {
            if v.is_null() {
                return Ok(None);
            }
            v.as_bool().map(Some).ok_or_else(|| format!("layout.{k}: {v} is not true or false"))
        };
        match k.as_str() {
            "terminalDock" => {
                l.terminal_dock = match v.as_str() {
                    None if v.is_null() => None,
                    Some(d) if DOCKS.contains(&d) => Some(d.to_string()),
                    _ => return Err(format!("layout.terminalDock: {v} (bottom, top or side)")),
                }
            }
            "terminalVisible" => l.terminal_visible = flag(v)?,
            "explorerVisible" => l.explorer_visible = flag(v)?,
            "explorerWidth" => l.explorer_width = px(v)?,
            "terminalHeight" => l.terminal_height = px(v)?,
            "terminalWidth" => l.terminal_width = px(v)?,
            _ => return Err(format!("Unknown layout field: {k}")),
        }
    }
    Ok(l)
}

pub const SKINS: &[&str] = &["bare-metal", "legacy", "omarchy"];
pub const TITLE_BARS: &[&str] = &["native", "custom"];

/// The title bar mode to open the window with: the saved one, else `native` (an unreadable
/// file or an unknown value also gives `native`, the mode that always has window controls).
pub fn title_bar_mode(path: &Path) -> &'static str {
    match load(path).ok().and_then(|s| s.ui.title_bar) {
        Some(m) if m == "custom" => "custom",
        _ => "native",
    }
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub editor: EditorSettings,
    #[serde(skip_serializing_if = "is_default_ui")]
    pub ui: UiSettings,
    pub workspaces: BTreeMap<String, WorkspaceSettings>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn is_default_ui(u: &UiSettings) -> bool {
    u.skin.is_none() && u.title_bar.is_none() && u.layout.is_none() && u.extra.is_empty()
}

const TEMPLATE: &str = r#"{
  "ui": { "skin": "bare-metal", "titleBar": "native" },
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
    static WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _one_writer = WRITE.lock().map_err(|_| "settings lock poisoned")?;
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

/// Remember the window skin (`bare-metal`, `legacy` or `omarchy`).
#[tauri::command]
pub fn settings_set_skin(state: State<'_, AppState>, skin: String) -> Result<String, String> {
    if !SKINS.contains(&skin.as_str()) {
        return Err(format!("Unknown skin: {skin} (bare-metal, legacy or omarchy)"));
    }
    let path = settings_path(&state)?;
    let mut s = load(&path)?;
    s.ui.skin = Some(skin.clone());
    save(&path, &s)?;
    Ok(skin)
}

/// Remember the title bar mode (`native` or `custom`); it applies when the window next opens.
#[tauri::command]
pub fn settings_set_title_bar(state: State<'_, AppState>, mode: String) -> Result<String, String> {
    if !TITLE_BARS.contains(&mode.as_str()) {
        return Err(format!("Unknown title bar: {mode} (native or custom)"));
    }
    let path = settings_path(&state)?;
    let mut s = load(&path)?;
    s.ui.title_bar = Some(mode.clone());
    save(&path, &s)?;
    Ok(mode)
}

/// Save the window layout (merge; see `merge_layout`). Called after every panel change.
#[tauri::command]
pub fn settings_set_layout(state: State<'_, AppState>, patch: serde_json::Value) -> Result<LayoutSettings, String> {
    static WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _one_writer = WRITE.lock().map_err(|_| "settings lock poisoned")?;
    let path = settings_path(&state)?;
    let mut s = load(&path)?;
    let l = merge_layout(s.ui.layout.clone().unwrap_or_default(), &patch)?;
    s.ui.layout = if l == LayoutSettings::default() { None } else { Some(l.clone()) };
    save(&path, &s)?;
    Ok(l)
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
    fn skin_round_trips_and_default_omits_ui() {
        let s: Settings = serde_json::from_str(r#"{"ui":{"skin":"legacy","x":1}}"#).unwrap();
        assert_eq!(s.ui.skin.as_deref(), Some("legacy"));
        assert_eq!(serde_json::to_value(&s).unwrap()["ui"]["x"], 1);
        let d = serde_json::to_value(Settings::default()).unwrap();
        assert!(d.get("ui").is_none());
    }

    #[test]
    fn title_bar_defaults_to_native() {
        let dir = std::env::temp_dir().join(format!("colony-titlebar-{}", std::process::id()));
        let path = dir.join("settings.json");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(title_bar_mode(&path), "native"); // no file
        for (text, want) in [
            (r#"{"ui":{"titleBar":"custom","skin":"legacy"}}"#, "custom"),
            (r#"{"ui":{"titleBar":"native"}}"#, "native"),
            (r#"{"ui":{"titleBar":"frameless"}}"#, "native"),
            (r#"{"ui":{"skin":"legacy"}}"#, "native"),
            ("{not json", "native"),
        ] {
            std::fs::write(&path, text).unwrap();
            assert_eq!(title_bar_mode(&path), want, "{text}");
        }
        let s: Settings = serde_json::from_str(r#"{"ui":{"titleBar":"custom"}}"#).unwrap();
        assert_eq!(serde_json::to_value(&s).unwrap()["ui"]["titleBar"], "custom");
        assert!(serde_json::from_str::<serde_json::Value>(TEMPLATE).unwrap()["ui"]["titleBar"] == "native");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn layout_merges_validates_and_round_trips() {
        let l = merge_layout(LayoutSettings::default(), &serde_json::json!({"terminalDock": "side", "explorerWidth": 300, "terminalVisible": false})).unwrap();
        assert_eq!(l.terminal_dock.as_deref(), Some("side"));
        assert_eq!(l.explorer_width, Some(300));
        assert_eq!(l.terminal_visible, Some(false));
        // null clears one field and keeps the rest
        let l = merge_layout(l, &serde_json::json!({"explorerWidth": null, "terminalWidth": 420})).unwrap();
        assert_eq!(l.explorer_width, None);
        assert_eq!(l.terminal_width, Some(420));
        assert_eq!(l.terminal_dock.as_deref(), Some("side"));
        for bad in [
            serde_json::json!({"terminalDock": "left"}),
            serde_json::json!({"explorerWidth": 5}),
            serde_json::json!({"terminalHeight": -1}),
            serde_json::json!({"terminalHeight": "200px"}),
            serde_json::json!({"explorerVisible": "yes"}),
            serde_json::json!({"panels": 1}),
            serde_json::json!([1]),
        ] {
            assert!(merge_layout(l.clone(), &bad).is_err(), "{bad}");
        }
        let s: Settings = serde_json::from_str(r#"{"ui":{"layout":{"terminalDock":"top","terminalHeight":260}}}"#).unwrap();
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["ui"]["layout"], serde_json::json!({"terminalDock": "top", "terminalHeight": 260}));
    }

    #[test]
    fn missing_file_is_default() {
        let s = load(Path::new("/nonexistent/colony/settings.json")).unwrap();
        assert!(s.workspaces.is_empty());
    }
}
