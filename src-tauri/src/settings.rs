//! Colony settings: one small JSON file in the Tauri app config dir
//! (`~/.config/io.missionkit.colony/settings.json` on Linux). Read fresh on every use so
//! an edit (in Colony or any editor) applies without a restart. Unknown fields are kept.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

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
/// live Omarchy theme, the default on Omarchy when unset).
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
    /// The rail's side of the window: `left` (default) or `right`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rail_position: Option<String>,
    /// Labels under the rail icons (default true); false = icon-only, tooltips kept.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rail_labels: Option<bool>,
    /// Where new terminal tabs of each kind open: the bar that kind was last moved to
    /// (kit ADR 2026-10-24, amend 2026-11-07 tab placement memory). Written only when the
    /// operator moves a tab, never with the rest of the layout.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_placement: Option<TerminalPlacement>,
    /// The centre split tree per workspace folder (kit ADR 2026-10-24, amend 2026-11-19 free
    /// tiling point 6): `{ "<folder>": { "tree", "focused", "at" } }`. A leaf is
    /// `{pane, tabs, active?}`, a split `{split: "right" | "down", ratio, a, b}`; a tab is
    /// `{file, mode?}` (a path inside the folder) or `{terminal}` (a shell's last folder,
    /// restored as a fresh shell). `at` (ms since the epoch) is set here on every write; past
    /// `MAX_PANE_FOLDERS` the oldest folder goes. Written on its own patch, never by the
    /// panel-change save; see `merge_panes`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub panes: Option<serde_json::Map<String, serde_json::Value>>,
}

/// The remembered bar per terminal kind: `editor` (the centre tab bar) or `panel` (the
/// drawer). Unset = the kind's default: shells in the panel, interactive CLIs and the queue
/// runner in the editor area.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TerminalPlacement {
    /// Drawer shells.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    /// Centre PTYs of kind `interactive`: Open interactive, resumed chats, the driver chat.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interactive: Option<String>,
    /// The queue runner.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue: Option<String>,
}

pub const DOCKS: &[&str] = &["bottom", "top", "side"];
pub const RAIL_POSITIONS: &[&str] = &["left", "right"];
pub const TERMINAL_PLACES: &[&str] = &["editor", "panel"];
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
            "railPosition" => {
                l.rail_position = match v.as_str() {
                    None if v.is_null() => None,
                    Some(p) if RAIL_POSITIONS.contains(&p) => Some(p.to_string()),
                    _ => return Err(format!("layout.railPosition: {v} (left or right)")),
                }
            }
            "railLabels" => l.rail_labels = flag(v)?,
            "terminalVisible" => l.terminal_visible = flag(v)?,
            "explorerVisible" => l.explorer_visible = flag(v)?,
            "explorerWidth" => l.explorer_width = px(v)?,
            "terminalHeight" => l.terminal_height = px(v)?,
            "terminalWidth" => l.terminal_width = px(v)?,
            "terminalPlacement" => l.terminal_placement = merge_placement(l.terminal_placement.take().unwrap_or_default(), v)?,
            "panes" => l.panes = merge_panes(l.panes.take().unwrap_or_default(), v, now_ms())?,
            _ => return Err(format!("Unknown layout field: {k}")),
        }
    }
    Ok(l)
}

/// `terminalPlacement`: `null` clears every kind; an object sets each named kind to
/// `editor` or `panel`, `null` clearing that kind. Any other kind or value is an error.
/// All kinds unset gives `None`, so the field leaves settings.json.
fn merge_placement(mut p: TerminalPlacement, v: &serde_json::Value) -> Result<Option<TerminalPlacement>, String> {
    if v.is_null() {
        return Ok(None);
    }
    let obj = v.as_object().ok_or_else(|| format!("layout.terminalPlacement: {v} is not an object"))?;
    for (kind, place) in obj {
        let slot = match kind.as_str() {
            "shell" => &mut p.shell,
            "interactive" => &mut p.interactive,
            "queue" => &mut p.queue,
            _ => return Err(format!("layout.terminalPlacement.{kind}: unknown kind (shell, interactive or queue)")),
        };
        *slot = match place.as_str() {
            None if place.is_null() => None,
            Some(x) if TERMINAL_PLACES.contains(&x) => Some(x.to_string()),
            _ => return Err(format!("layout.terminalPlacement.{kind}: {place} (editor or panel)")),
        };
    }
    Ok(if p == TerminalPlacement::default() { None } else { Some(p) })
}

/// Limits of a saved split tree: more panes than Colony opens (`MAX_PANES` in src/panes.ts),
/// a deeper tree, or more tabs than this in one pane is a hand-edit gone wrong, not a layout.
pub const MAX_SAVED_PANES: usize = 16;
pub const MAX_PANE_DEPTH: usize = 16;
pub const MAX_PANE_TABS: usize = 64;
/// Folders whose tree is kept; a write past this drops the least recently written one.
pub const MAX_PANE_FOLDERS: usize = 32;
const MAX_PANE_PATH: usize = 4096;

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// `panes`: `null` clears every folder (Reset layout on every folder); an object maps folder
/// paths to a tree (validated, then it replaces that folder's tree, stamped `at`) or `null`
/// (that folder's reset). Folders not named keep their tree, so two windows on two folders
/// never overwrite each other. Any malformed tree is an error: nothing is written then.
fn merge_panes(mut all: serde_json::Map<String, serde_json::Value>, v: &serde_json::Value, at: u64) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String> {
    if v.is_null() {
        return Ok(None);
    }
    let obj = v.as_object().ok_or_else(|| format!("layout.panes: {v} is not an object"))?;
    for (folder, saved) in obj {
        if !folder.starts_with('/') || folder.len() > MAX_PANE_PATH {
            return Err(format!("layout.panes: {folder:?} is not an absolute folder path"));
        }
        if saved.is_null() {
            all.remove(folder);
            continue;
        }
        let mut entry = check_saved_panes(saved).map_err(|e| format!("layout.panes[{folder:?}]: {e}"))?;
        entry.insert("at".into(), at.into());
        all.insert(folder.clone(), serde_json::Value::Object(entry));
    }
    while all.len() > MAX_PANE_FOLDERS {
        let oldest = all.iter().min_by_key(|(_, e)| e.get("at").and_then(|a| a.as_u64()).unwrap_or(0)).map(|(k, _)| k.clone());
        match oldest {
            Some(k) => all.remove(&k),
            None => break,
        };
    }
    Ok(if all.is_empty() { None } else { Some(all) })
}

/// One folder's saved tree: `{tree, focused}` (an `at` in the patch is ignored, the write
/// sets it). Returns the entry to store, without `at`.
fn check_saved_panes(v: &serde_json::Value) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let obj = v.as_object().ok_or("not an object")?;
    for k in obj.keys() {
        if !matches!(k.as_str(), "tree" | "focused" | "at") {
            return Err(format!("unknown field {k}"));
        }
    }
    let tree = obj.get("tree").ok_or("no tree")?;
    let mut ids = Vec::new();
    check_pane_node(tree, 0, &mut ids)?;
    let focused = obj.get("focused").and_then(|f| f.as_str()).ok_or("focused is not a pane id")?;
    if !ids.iter().any(|i| i == focused) {
        return Err(format!("focused {focused:?} is not a pane of the tree"));
    }
    let mut out = serde_json::Map::new();
    out.insert("tree".into(), tree.clone());
    out.insert("focused".into(), focused.into());
    Ok(out)
}

fn check_pane_node(n: &serde_json::Value, depth: usize, ids: &mut Vec<String>) -> Result<(), String> {
    if depth > MAX_PANE_DEPTH {
        return Err(format!("deeper than {MAX_PANE_DEPTH} splits"));
    }
    let obj = n.as_object().ok_or_else(|| format!("{n} is not a node"))?;
    if obj.contains_key("pane") {
        for k in obj.keys() {
            if !matches!(k.as_str(), "pane" | "tabs" | "active") {
                return Err(format!("pane: unknown field {k}"));
            }
        }
        let id = obj["pane"].as_str().filter(|s| !s.is_empty() && s.len() <= 16).ok_or("pane id is not a short string")?;
        if ids.iter().any(|i| i == id) {
            return Err(format!("pane {id:?} appears twice"));
        }
        ids.push(id.to_string());
        if ids.len() > MAX_SAVED_PANES {
            return Err(format!("more than {MAX_SAVED_PANES} panes"));
        }
        let tabs = match obj.get("tabs") {
            None => &[][..],
            Some(t) => t.as_array().map(|a| a.as_slice()).ok_or("tabs is not a list")?,
        };
        if tabs.len() > MAX_PANE_TABS {
            return Err(format!("pane {id:?}: more than {MAX_PANE_TABS} tabs"));
        }
        for t in tabs {
            check_saved_tab(t).map_err(|e| format!("pane {id:?}: {e}"))?;
        }
        if let Some(a) = obj.get("active") {
            if !a.is_null() && !a.as_u64().is_some_and(|i| (i as usize) < tabs.len()) {
                return Err(format!("pane {id:?}: active {a} is not one of its tabs"));
            }
        }
        return Ok(());
    }
    for k in obj.keys() {
        if !matches!(k.as_str(), "split" | "ratio" | "a" | "b") {
            return Err(format!("split: unknown field {k}"));
        }
    }
    match obj.get("split").and_then(|s| s.as_str()) {
        Some("right" | "down") => {}
        _ => return Err(format!("{n} is neither a pane nor a split (right or down)")),
    }
    match obj.get("ratio").and_then(|r| r.as_f64()) {
        Some(r) if r > 0.0 && r < 1.0 => {}
        _ => return Err("ratio is not between 0 and 1".into()),
    }
    check_pane_node(obj.get("a").ok_or("split without a")?, depth + 1, ids)?;
    check_pane_node(obj.get("b").ok_or("split without b")?, depth + 1, ids)
}

/// A saved tab: `{file, mode?}` or `{terminal}`, each a path relative to the folder (no
/// leading `/`, no `..` or empty part); `""` or `.` for a terminal in the folder itself.
fn check_saved_tab(t: &serde_json::Value) -> Result<(), String> {
    let obj = t.as_object().ok_or_else(|| format!("tab {t} is not an object"))?;
    let rel = |p: &serde_json::Value, empty_ok: bool| -> Result<(), String> {
        let s = p.as_str().ok_or_else(|| format!("tab path {p} is not a string"))?;
        if s.len() > MAX_PANE_PATH || s.starts_with('/') || (!s.is_empty() && s.split('/').any(|seg| seg == ".." || seg.is_empty())) || (!empty_ok && (s.is_empty() || s == ".")) {
            return Err(format!("tab path {s:?} is not inside the folder"));
        }
        Ok(())
    };
    if let Some(f) = obj.get("file") {
        for k in obj.keys() {
            if !matches!(k.as_str(), "file" | "mode") {
                return Err(format!("file tab: unknown field {k}"));
            }
        }
        rel(f, false)?;
        return match obj.get("mode") {
            None => Ok(()),
            Some(m) if m == "preview" || m == "editor" => Ok(()),
            Some(m) => Err(format!("file tab: mode {m} (preview or editor)")),
        };
    }
    if let Some(d) = obj.get("terminal") {
        if obj.len() != 1 {
            return Err("terminal tab: only `terminal`".into());
        }
        return rel(d, true);
    }
    Err(format!("tab {t} is neither a file nor a terminal"))
}

pub const SKINS: &[&str] = &["bare-metal", "legacy", "omarchy"];
pub const TITLE_BARS: &[&str] = &["native", "custom"];

/// The title bar a window opens with. On a tiling window manager (Hyprland, sway, niri, i3)
/// always `native`: the manager places and sizes the window, so a saved `custom` is
/// ignored there and the choice is not offered. Elsewhere the saved mode, else `native`
/// (an unknown value also gives `native`, the mode that always has window controls).
pub fn effective_title_bar(saved: Option<&str>, tiling: bool) -> &'static str {
    match saved {
        Some("custom") if !tiling => "custom",
        _ => "native",
    }
}

/// The title bar mode to open the window with, from the file (an unreadable one gives
/// `native`); see `effective_title_bar`.
pub fn title_bar_mode(path: &Path, tiling: bool) -> &'static str {
    let saved = load(path).ok().and_then(|s| s.ui.title_bar);
    effective_title_bar(saved.as_deref(), tiling)
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub editor: EditorSettings,
    /// Open in terminal file manager: a string (split on whitespace) or an argv array; unset =
    /// the first of yazi, lf, nnn, ranger and broot on PATH (filemanager.rs).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_manager: Option<serde_json::Value>,
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

/// Write via a temp file + rename so a crash never leaves half a file. Only `Store` calls
/// this (under its lock); the temp name carries the pid so two Colony processes never
/// write into each other's temp file.
fn save(path: &Path, s: &Settings) -> Result<(), String> {
    let mut text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    text.push('\n');
    write_atomic(path, &text)
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let mut f = std::fs::File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
    f.write_all(text.as_bytes()).and_then(|_| f.sync_all()).map_err(|e| format!("{}: {e}", tmp.display()))?;
    drop(f);
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {e}", path.display())
    })
}

/// settings.json and the one way it is written. Every writer (skin, title bar, layout,
/// workspace entries, the template) goes through `update`: lock, read the file as it is
/// now, change only the caller's keys, write it atomically. So two updates to different
/// keys never drop each other, and an edit made in an editor in between is kept.
/// The in-process mutex serializes this window's writers; an advisory `flock` on
/// `settings.json.lock` serializes them with another Colony process on the same file
/// (a dev build next to the installed one, `--new-instance`).
#[derive(Default)]
pub struct Store {
    path: Mutex<Option<PathBuf>>,
    write: Mutex<()>,
}

impl Store {
    pub fn at(path: PathBuf) -> Self {
        Store { path: Mutex::new(Some(path)), write: Mutex::new(()) }
    }

    /// Set once at startup (`<app config dir>/settings.json`).
    pub fn set_path(&self, path: PathBuf) {
        *self.path.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
    }

    pub fn path(&self) -> Result<PathBuf, String> {
        self.path.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or_else(|| "No app config dir".to_string())
    }

    /// The file as it is now (a write is a rename, so a read never sees half of one).
    pub fn load(&self) -> Result<Settings, String> {
        load(&self.path()?)
    }

    /// Read-modify-write under the lock. `f` errs: nothing is written. An unreadable
    /// file also writes nothing (it is never replaced by defaults).
    pub fn update<T>(&self, f: impl FnOnce(&mut Settings) -> Result<T, String>) -> Result<T, String> {
        // The guarded data is `()`: a panic in another writer leaves nothing half-changed.
        let _one_writer = self.write.lock().unwrap_or_else(|e| e.into_inner());
        let path = self.path()?;
        let _other_processes = FileLock::acquire(&path)?;
        let mut s = load(&path)?;
        let out = f(&mut s)?;
        save(&path, &s)?;
        Ok(out)
    }

    /// Create the file from the template when it does not exist yet; its path.
    pub fn ensure(&self) -> Result<PathBuf, String> {
        let _one_writer = self.write.lock().unwrap_or_else(|e| e.into_inner());
        let path = self.path()?;
        let _other_processes = FileLock::acquire(&path)?;
        if !path.exists() {
            write_atomic(&path, TEMPLATE)?;
        }
        Ok(path)
    }
}

/// An exclusive `flock` on `settings.json.lock`, released when dropped (the fd closes).
struct FileLock(#[allow(dead_code)] std::fs::File);

impl FileLock {
    fn acquire(path: &Path) -> Result<Self, String> {
        use std::os::fd::AsRawFd;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let lock = path.with_extension("json.lock");
        let f = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(&lock).map_err(|e| format!("{}: {e}", lock.display()))?;
        loop {
            // SAFETY: flock(2) on an fd this File owns for the whole call.
            if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) } == 0 {
                return Ok(FileLock(f));
            }
            let e = std::io::Error::last_os_error();
            if e.kind() != std::io::ErrorKind::Interrupted {
                return Err(format!("{}: {e}", lock.display()));
            }
        }
    }
}

pub fn settings_path(state: &AppState) -> Result<PathBuf, String> {
    state.settings.path()
}

pub fn current(state: &AppState) -> Result<Settings, String> {
    state.settings.load()
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
    Ok(state.settings.ensure()?.display().to_string())
}

/// Merge the given fields into the opened folder's entry (null clears a field).
#[tauri::command]
pub fn settings_set_workspace(state: State<'_, AppState>, patch: serde_json::Value) -> Result<WorkspaceSettings, String> {
    let root = crate::workspace::workspace_root(&state)?.display().to_string();
    state.settings.update(|s| {
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
        Ok(ws)
    })
}

/// Remember the window skin (`bare-metal`, `legacy` or `omarchy`).
#[tauri::command]
pub fn settings_set_skin(state: State<'_, AppState>, skin: String) -> Result<String, String> {
    if !SKINS.contains(&skin.as_str()) {
        return Err(format!("Unknown skin: {skin} (bare-metal, legacy or omarchy)"));
    }
    state.settings.update(|s| {
        s.ui.skin = Some(skin.clone());
        Ok(skin)
    })
}

/// Remember the title bar mode (`native` or `custom`); it applies when the window next opens.
#[tauri::command]
pub fn settings_set_title_bar(state: State<'_, AppState>, mode: String) -> Result<String, String> {
    if !TITLE_BARS.contains(&mode.as_str()) {
        return Err(format!("Unknown title bar: {mode} (native or custom)"));
    }
    state.settings.update(|s| {
        s.ui.title_bar = Some(mode.clone());
        Ok(mode)
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleBarInfo {
    /// `ui.titleBar` as saved (any value), or none.
    saved: Option<String>,
    /// What the window opens with on the next start (`effective_title_bar`).
    next: &'static str,
    /// The tiling window manager, if any: the choice is not offered there.
    tiling_wm: Option<String>,
}

#[tauri::command]
pub fn settings_title_bar(state: State<'_, AppState>) -> Result<TitleBarInfo, String> {
    let saved = state.settings.load()?.ui.title_bar;
    let tiling_wm = crate::tiling_wm();
    let next = effective_title_bar(saved.as_deref(), tiling_wm.is_some());
    Ok(TitleBarInfo { saved, next, tiling_wm })
}

/// Save the window layout (merge; see `merge_layout`). Called after every panel change.
#[tauri::command]
pub fn settings_set_layout(state: State<'_, AppState>, patch: serde_json::Value) -> Result<LayoutSettings, String> {
    state.settings.update(|s| {
        let l = merge_layout(s.ui.layout.clone().unwrap_or_default(), &patch)?;
        s.ui.layout = if l == LayoutSettings::default() { None } else { Some(l.clone()) };
        Ok(l)
    })
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
        assert_eq!(title_bar_mode(&path, false), "native"); // no file
        for (text, want) in [
            (r#"{"ui":{"titleBar":"custom","skin":"legacy"}}"#, "custom"),
            (r#"{"ui":{"titleBar":"native"}}"#, "native"),
            (r#"{"ui":{"titleBar":"frameless"}}"#, "native"),
            (r#"{"ui":{"skin":"legacy"}}"#, "native"),
            ("{not json", "native"),
        ] {
            std::fs::write(&path, text).unwrap();
            assert_eq!(title_bar_mode(&path, false), want, "{text}");
            assert_eq!(title_bar_mode(&path, true), "native", "tiling: {text}");
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
        // the rail: side and label mode
        let l = merge_layout(l, &serde_json::json!({"railPosition": "right", "railLabels": false})).unwrap();
        assert_eq!(l.rail_position.as_deref(), Some("right"));
        assert_eq!(l.rail_labels, Some(false));
        assert_eq!(l.terminal_width, Some(420));
        let l = merge_layout(l, &serde_json::json!({"railPosition": "left", "railLabels": null})).unwrap();
        assert_eq!(l.rail_position.as_deref(), Some("left"));
        assert_eq!(l.rail_labels, None);
        for bad in [
            serde_json::json!({"railPosition": "top"}),
            serde_json::json!({"railPosition": "bottom"}),
            serde_json::json!({"railPosition": true}),
            serde_json::json!({"railLabels": "off"}),
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
        let s: Settings = serde_json::from_str(r#"{"ui":{"layout":{"terminalDock":"top","terminalHeight":260,"railPosition":"right","railLabels":false}}}"#).unwrap();
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["ui"]["layout"], serde_json::json!({"terminalDock": "top", "terminalHeight": 260, "railPosition": "right", "railLabels": false}));
    }

    #[test]
    fn terminal_placement_merges_kind_by_kind() {
        let base = merge_layout(LayoutSettings::default(), &serde_json::json!({"terminalDock": "side"})).unwrap();
        let l = merge_layout(base.clone(), &serde_json::json!({"terminalPlacement": {"shell": "editor"}})).unwrap();
        let p = l.terminal_placement.clone().unwrap();
        assert_eq!(p.shell.as_deref(), Some("editor"));
        assert_eq!((p.interactive.as_deref(), p.queue.as_deref()), (None, None));
        assert_eq!(l.terminal_dock.as_deref(), Some("side"), "the rest of the layout is kept");
        // a second kind merges in, the first stays
        let l = merge_layout(l, &serde_json::json!({"terminalPlacement": {"interactive": "panel", "queue": "panel"}})).unwrap();
        let p = l.terminal_placement.clone().unwrap();
        assert_eq!((p.shell.as_deref(), p.interactive.as_deref(), p.queue.as_deref()), (Some("editor"), Some("panel"), Some("panel")));
        // a layout patch without the field (layoutNow) keeps the memory
        let l = merge_layout(l, &serde_json::json!({"terminalDock": "bottom", "explorerWidth": 300, "railLabels": null})).unwrap();
        assert_eq!(l.terminal_placement, Some(p));
        // null clears one kind
        let l = merge_layout(l, &serde_json::json!({"terminalPlacement": {"shell": null}})).unwrap();
        assert_eq!(l.terminal_placement.as_ref().unwrap().shell, None);
        assert_eq!(l.terminal_placement.as_ref().unwrap().queue.as_deref(), Some("panel"));
        // clearing the last kinds drops the field
        let l = merge_layout(l, &serde_json::json!({"terminalPlacement": {"interactive": null, "queue": null}})).unwrap();
        assert_eq!(l.terminal_placement, None);
        // null resets every kind (the palette reset)
        let l = merge_layout(l, &serde_json::json!({"terminalPlacement": {"shell": "editor", "queue": "panel"}})).unwrap();
        let l = merge_layout(l, &serde_json::json!({"terminalPlacement": null})).unwrap();
        assert_eq!(l.terminal_placement, None);
        assert_eq!(l, merge_layout(base, &serde_json::json!({"terminalDock": "bottom", "explorerWidth": 300})).unwrap());
    }

    #[test]
    fn terminal_placement_refuses_bad_values_and_writes_nothing() {
        let l = merge_layout(LayoutSettings::default(), &serde_json::json!({"terminalPlacement": {"shell": "editor"}})).unwrap();
        for bad in [
            serde_json::json!({"terminalPlacement": "editor"}),
            serde_json::json!({"terminalPlacement": true}),
            serde_json::json!({"terminalPlacement": ["shell"]}),
            serde_json::json!({"terminalPlacement": {"shell": "drawer"}}),
            serde_json::json!({"terminalPlacement": {"shell": "Editor"}}),
            serde_json::json!({"terminalPlacement": {"interactive": 1}}),
            serde_json::json!({"terminalPlacement": {"queue": true}}),
            serde_json::json!({"terminalPlacement": {"editor": "panel"}}),
            serde_json::json!({"terminalPlacement": {"interactive": "panel", "browser": "editor"}}),
            serde_json::json!({"terminalPlacement": {"queue": "panel"}, "terminalDock": "left"}),
        ] {
            assert!(merge_layout(l.clone(), &bad).is_err(), "{bad}");
        }
        // the store writes nothing when the merge errs
        let dir = std::env::temp_dir().join(format!("colony-placement-{}", std::process::id()));
        let path = dir.join("settings.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, r#"{"ui":{"layout":{"terminalPlacement":{"shell":"editor"}}}}"#).unwrap();
        let store = Store::at(path.clone());
        let before = std::fs::read_to_string(&path).unwrap();
        let r = store.update(|s| {
            s.ui.layout = Some(merge_layout(s.ui.layout.clone().unwrap_or_default(), &serde_json::json!({"terminalPlacement": {"shell": "nowhere"}}))?);
            Ok(())
        });
        assert!(r.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn terminal_placement_reads_and_round_trips() {
        let s: Settings = serde_json::from_str(r#"{"ui":{"layout":{"terminalDock":"top","terminalPlacement":{"shell":"editor","queue":"panel"}}}}"#).unwrap();
        let p = s.ui.layout.as_ref().unwrap().terminal_placement.clone().unwrap();
        assert_eq!((p.shell.as_deref(), p.interactive.as_deref(), p.queue.as_deref()), (Some("editor"), None, Some("panel")));
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["ui"]["layout"], serde_json::json!({"terminalDock": "top", "terminalPlacement": {"shell": "editor", "queue": "panel"}}));
        // no memory: the key is absent, not null
        let s: Settings = serde_json::from_str(r#"{"ui":{"layout":{"terminalDock":"top"}}}"#).unwrap();
        assert!(serde_json::to_value(&s).unwrap()["ui"]["layout"].get("terminalPlacement").is_none());
    }

    fn two_panes() -> serde_json::Value {
        serde_json::json!({
            "tree": {"split": "right", "ratio": 0.4,
                "a": {"pane": "p1", "tabs": [{"file": "src/main.ts"}, {"file": "README.md", "mode": "preview"}], "active": 1},
                "b": {"pane": "p2", "tabs": [{"terminal": "src"}, {"terminal": ""}]}},
            "focused": "p2"
        })
    }

    #[test]
    fn panes_merge_per_folder_and_stamp_the_write() {
        let base = merge_layout(LayoutSettings::default(), &serde_json::json!({"terminalDock": "side"})).unwrap();
        let l = merge_panes(Default::default(), &serde_json::json!({"/r/a": two_panes()}), 10).unwrap().unwrap();
        assert_eq!(l["/r/a"]["tree"], two_panes()["tree"]);
        assert_eq!(l["/r/a"]["focused"], "p2");
        assert_eq!(l["/r/a"]["at"], 10);
        // Another folder joins; the first one keeps its tree (two windows, two folders).
        let one = serde_json::json!({"tree": {"pane": "p1", "tabs": [], "active": null}, "focused": "p1", "at": 999});
        let l = merge_panes(l, &serde_json::json!({"/r/b": one}), 20).unwrap().unwrap();
        assert_eq!(l.len(), 2);
        assert_eq!(l["/r/b"]["at"], 20, "the write sets `at`, the patch's value is ignored");
        assert_eq!(l["/r/a"]["at"], 10);
        // null resets one folder, then every folder.
        let l = merge_panes(l, &serde_json::json!({"/r/a": null}), 30).unwrap().unwrap();
        assert_eq!(l.keys().collect::<Vec<_>>(), vec!["/r/b"]);
        assert_eq!(merge_panes(l.clone(), &serde_json::Value::Null, 40).unwrap(), None);
        assert_eq!(merge_panes(l, &serde_json::json!({"/r/b": null}), 40).unwrap(), None, "the last folder reset drops the field");
        // Through merge_layout: its own branch, the other fields untouched.
        let l = merge_layout(base.clone(), &serde_json::json!({"panes": {"/r/a": two_panes()}})).unwrap();
        assert_eq!(l.terminal_dock.as_deref(), Some("side"));
        assert_eq!(l.panes.as_ref().unwrap()["/r/a"]["focused"], "p2");
        let l = merge_layout(l, &serde_json::json!({"explorerWidth": 300})).unwrap();
        assert!(l.panes.is_some(), "the panel-change save never touches the tree");
        let l = merge_layout(l, &serde_json::json!({"panes": null})).unwrap();
        assert_eq!(l, merge_layout(base, &serde_json::json!({"explorerWidth": 300})).unwrap());
    }

    #[test]
    fn panes_keep_the_most_recent_folders() {
        let mut l = serde_json::Map::new();
        for i in 0..MAX_PANE_FOLDERS + 3 {
            l = merge_panes(l, &serde_json::json!({ format!("/f{i}"): two_panes() }), i as u64).unwrap().unwrap();
        }
        assert_eq!(l.len(), MAX_PANE_FOLDERS);
        assert!(!l.contains_key("/f0") && !l.contains_key("/f2") && l.contains_key("/f3"));
        // Rewriting an old folder makes it recent again.
        let l = merge_panes(l, &serde_json::json!({"/f3": two_panes()}), 1000).unwrap().unwrap();
        let l = merge_panes(l, &serde_json::json!({"/new": two_panes()}), 1001).unwrap().unwrap();
        assert!(l.contains_key("/f3") && !l.contains_key("/f4"));
    }

    #[test]
    fn panes_refuse_bad_trees_and_write_nothing() {
        let leaf = |id: &str| serde_json::json!({"pane": id});
        let mut deep = leaf("p0");
        for i in 1..=MAX_PANE_DEPTH + 1 {
            deep = serde_json::json!({"split": "down", "ratio": 0.5, "a": deep, "b": leaf(&format!("q{i}"))});
        }
        let mut wide = leaf("p0");
        for i in 1..=MAX_SAVED_PANES {
            wide = serde_json::json!({"split": "right", "ratio": 0.5, "a": leaf(&format!("w{i}")), "b": wide});
        }
        let many: Vec<_> = (0..=MAX_PANE_TABS).map(|i| serde_json::json!({"file": format!("f{i}")})).collect();
        let with = |tree: serde_json::Value, focused: &str| serde_json::json!({"/r": {"tree": tree, "focused": focused}});
        let bads = [
            serde_json::json!(["not", "an", "object"]),
            serde_json::json!({"relative/folder": two_panes()}),
            serde_json::json!({"/r": "tree"}),
            serde_json::json!({"/r": {"tree": leaf("p1")}}),
            serde_json::json!({"/r": {"tree": leaf("p1"), "focused": "p1", "extra": 1}}),
            with(serde_json::json!({"float": "x"}), "p1"),
            with(serde_json::json!({"split": "diagonal", "ratio": 0.5, "a": leaf("p1"), "b": leaf("p2")}), "p1"),
            with(serde_json::json!({"split": "right", "ratio": 1.5, "a": leaf("p1"), "b": leaf("p2")}), "p1"),
            with(serde_json::json!({"split": "right", "ratio": 0, "a": leaf("p1"), "b": leaf("p2")}), "p1"),
            with(serde_json::json!({"split": "right", "ratio": 0.5, "a": leaf("p1")}), "p1"),
            with(serde_json::json!({"split": "right", "ratio": 0.5, "a": leaf("p1"), "b": leaf("p1")}), "p1"),
            with(leaf("p1"), "p9"),
            with(leaf(""), ""),
            with(deep, "p0"),
            with(wide, "p0"),
            with(serde_json::json!({"pane": "p1", "tabs": many}), "p1"),
            with(serde_json::json!({"pane": "p1", "tabs": [{"file": "/etc/passwd"}]}), "p1"),
            with(serde_json::json!({"pane": "p1", "tabs": [{"file": "a/../../x"}]}), "p1"),
            with(serde_json::json!({"pane": "p1", "tabs": [{"file": ""}]}), "p1"),
            with(serde_json::json!({"pane": "p1", "tabs": [{"file": "a//b"}]}), "p1"),
            with(serde_json::json!({"pane": "p1", "tabs": [{"file": "a", "mode": "raw"}]}), "p1"),
            with(serde_json::json!({"pane": "p1", "tabs": [{"terminal": "../up"}]}), "p1"),
            with(serde_json::json!({"pane": "p1", "tabs": [{"terminal": "x", "argv": ["sh"]}]}), "p1"),
            with(serde_json::json!({"pane": "p1", "tabs": [{"chat": "abc"}]}), "p1"),
            with(serde_json::json!({"pane": "p1", "tabs": [{"file": "a"}], "active": 1}), "p1"),
        ];
        let l = merge_layout(LayoutSettings::default(), &serde_json::json!({"panes": {"/keep": two_panes()}})).unwrap();
        for bad in bads {
            assert!(merge_layout(l.clone(), &serde_json::json!({"panes": bad})).is_err(), "{bad}");
        }
        // One bad folder in a patch refuses the whole patch.
        assert!(merge_layout(l.clone(), &serde_json::json!({"panes": {"/ok": two_panes(), "/bad": {"tree": leaf("p1"), "focused": "p2"}}})).is_err());
        let path = scratch("panes-refused");
        let store = Store::at(path.clone());
        store.update(|s| {
            s.ui.layout = Some(l.clone());
            Ok(())
        }).unwrap();
        let before = std::fs::read_to_string(&path).unwrap();
        let r = store.update(|s| {
            s.ui.layout = Some(merge_layout(s.ui.layout.clone().unwrap_or_default(), &serde_json::json!({"panes": {"/keep": {"tree": {"pane": "p1", "tabs": [{"file": "../x"}]}, "focused": "p1"}}}))?);
            Ok(())
        });
        assert!(r.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn panes_read_and_round_trip() {
        let s: Settings = serde_json::from_str(&format!(r#"{{"ui":{{"layout":{{"terminalDock":"top","panes":{{"/r":{}}}}}}}}}"#, serde_json::json!({"tree": two_panes()["tree"], "focused": "p2", "at": 5}))).unwrap();
        let p = s.ui.layout.as_ref().unwrap().panes.clone().unwrap();
        assert_eq!(p["/r"]["tree"]["b"]["tabs"][0]["terminal"], "src");
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["ui"]["layout"]["panes"]["/r"]["at"], 5);
        let s: Settings = serde_json::from_str(r#"{"ui":{"layout":{"terminalDock":"top"}}}"#).unwrap();
        assert!(serde_json::to_value(&s).unwrap()["ui"]["layout"].get("panes").is_none(), "no tree: the key is absent, not null");
    }

    #[test]
    fn tiling_always_opens_native() {
        assert_eq!(effective_title_bar(Some("custom"), true), "native");
        assert_eq!(effective_title_bar(Some("native"), true), "native");
        assert_eq!(effective_title_bar(None, true), "native");
        assert_eq!(effective_title_bar(Some("custom"), false), "custom");
        assert_eq!(effective_title_bar(Some("native"), false), "native");
        assert_eq!(effective_title_bar(Some("frameless"), false), "native");
        assert_eq!(effective_title_bar(None, false), "native");
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("colony-settings-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
    }

    /// Writers of different keys, in parallel, each `ROUNDS` times: every key ends at its
    /// writer's last value. `stores` > 1 gives each writer its own `Store` on the same file
    /// (another Colony process: only the file lock is shared).
    fn concurrent_writers_keep_every_key(name: &str, stores: usize) {
        const ROUNDS: u32 = 40;
        let path = scratch(name);
        std::fs::write(&path, r#"{"editor":{"command":"zed"},"future":{"kept":true}}"#).unwrap();
        let shared: Vec<std::sync::Arc<Store>> = (0..stores).map(|_| std::sync::Arc::new(Store::at(path.clone()))).collect();
        let store = |i: usize| shared[i % stores].clone();
        let mut threads = Vec::new();
        let s = store(0);
        threads.push(std::thread::spawn(move || {
            for i in 0..ROUNDS {
                let skin = SKINS[i as usize % SKINS.len()].to_string();
                s.update(|x| Ok(x.ui.skin = Some(skin))).unwrap();
            }
        }));
        let s = store(1);
        threads.push(std::thread::spawn(move || {
            for i in 0..ROUNDS {
                s.update(|x| {
                    let l = merge_layout(x.ui.layout.clone().unwrap_or_default(), &serde_json::json!({"explorerWidth": 100 + i}))?;
                    x.ui.layout = Some(l);
                    Ok(())
                })
                .unwrap();
            }
        }));
        let s = store(2);
        threads.push(std::thread::spawn(move || {
            for i in 0..ROUNDS {
                s.update(|x| Ok(x.ui.title_bar = Some(TITLE_BARS[i as usize % 2].to_string()))).unwrap();
            }
        }));
        for w in 0..2u32 {
            let s = store(3 + w as usize);
            threads.push(std::thread::spawn(move || {
                for i in 0..ROUNDS {
                    s.update(|x| Ok(x.workspaces.entry(format!("/w/{w}")).or_default().max_ticks = Some(i))).unwrap();
                }
            }));
        }
        for t in threads {
            t.join().unwrap();
        }
        let s = load(&path).unwrap();
        let last = ROUNDS as usize - 1;
        assert_eq!(s.ui.skin.as_deref(), Some(SKINS[last % SKINS.len()]));
        assert_eq!(s.ui.layout.and_then(|l| l.explorer_width), Some(100 + last as u32));
        assert_eq!(s.ui.title_bar.as_deref(), Some(TITLE_BARS[last % 2]));
        for w in 0..2 {
            assert_eq!(s.workspaces[&format!("/w/{w}")].max_ticks, Some(last as u32), "/w/{w}");
        }
        assert_eq!(s.editor.command, Some(serde_json::json!("zed")));
        assert_eq!(s.extra["future"], serde_json::json!({"kept": true}));
        let dir = path.parent().unwrap();
        let left: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name()).filter(|n| n.to_string_lossy().ends_with(".tmp")).collect();
        assert!(left.is_empty(), "temp files left: {left:?}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_updates_to_different_keys_all_survive() {
        concurrent_writers_keep_every_key("race", 1);
    }

    #[test]
    fn two_stores_on_one_file_do_not_drop_each_other() {
        concurrent_writers_keep_every_key("race2", 5);
    }

    #[test]
    fn a_failed_update_or_unreadable_file_writes_nothing() {
        let path = scratch("nowrite");
        let store = Store::at(path.clone());
        store.update(|x| Ok(x.ui.skin = Some("legacy".into()))).unwrap();
        let before = std::fs::read_to_string(&path).unwrap();
        assert!(store.update(|x| { x.ui.skin = Some("omarchy".into()); Err::<(), _>("refused".into()) }).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        std::fs::write(&path, "{not json").unwrap();
        assert!(store.update(|x| Ok(x.ui.skin = Some("omarchy".into()))).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{not json");
        // ensure keeps an existing file, and creates the template when there is none
        assert_eq!(store.ensure().unwrap(), path);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{not json");
        std::fs::remove_file(&path).unwrap();
        store.ensure().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), TEMPLATE);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn missing_file_is_default() {
        let s = load(Path::new("/nonexistent/colony/settings.json")).unwrap();
        assert!(s.workspaces.is_empty());
    }
}
