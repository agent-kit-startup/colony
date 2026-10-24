//! Native menu bar (File, View, Run, Help). The items come from `src/menu.json`, the same
//! file the window's action map reads (src/main.ts `runAction`), so the menu bar and the
//! More menu run one set of actions and there is no second list here. A click emits
//! `colony-menu` with the item id to the main window; the window runs the action.
//!
//! No accelerators and no mnemonics: GTK binds them on the window, before the webview,
//! and would take Ctrl+P, Alt+F, ... from the terminals and the editor. The window's own
//! keyboard handler keeps the shortcuts.

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuBuilder, MenuItemKind, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::AppState;

/// The event the window listens to (payload: the item id).
pub const EVENT: &str = "colony-menu";

const SPEC: &str = include_str!("../../src/menu.json");

#[derive(Deserialize, Debug)]
struct Spec {
    menus: Vec<SpecMenu>,
}

#[derive(Deserialize, Debug)]
struct SpecMenu {
    label: String,
    items: Vec<SpecItem>,
}

#[derive(Deserialize, Debug)]
struct SpecItem {
    #[serde(default)]
    id: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    separator: bool,
}

/// One menu of the installed menu bar, read back from the window (COLONY_SMOKE, tests).
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MenuState {
    label: String,
    items: Vec<MenuItemState>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MenuItemState {
    id: String,
    label: String,
    enabled: bool,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b':')
}

fn parse() -> Result<Spec, String> {
    let spec: Spec = serde_json::from_str(SPEC).map_err(|e| format!("src/menu.json: {e}"))?;
    let mut seen = std::collections::HashSet::new();
    for m in &spec.menus {
        if m.label.trim().is_empty() || m.items.is_empty() {
            return Err("src/menu.json: a menu without a label or items".into());
        }
        for i in &m.items {
            if i.separator {
                continue;
            }
            if !valid_id(&i.id) || !seen.insert(i.id.as_str()) {
                return Err(format!("src/menu.json: bad or duplicate id {:?}", i.id));
            }
            if i.label.trim().is_empty() || i.label.contains('&') || i.label.contains('_') {
                return Err(format!("src/menu.json: label of {} is empty or has a mnemonic marker", i.id));
            }
        }
    }
    Ok(spec)
}

/// Every action id of the menu bar, in menu order.
pub fn ids() -> Vec<String> {
    parse().map(|s| s.menus.into_iter().flat_map(|m| m.items).filter(|i| !i.separator).map(|i| i.id).collect()).unwrap_or_default()
}

/// The menu bar for the main window.
pub fn build<R: Runtime, M: Manager<R>>(manager: &M) -> tauri::Result<Menu<R>> {
    let spec = parse().map_err(|e| tauri::Error::Io(std::io::Error::other(e)))?;
    let mut bar = MenuBuilder::new(manager);
    for m in &spec.menus {
        let mut sub = SubmenuBuilder::new(manager, &m.label);
        for i in &m.items {
            sub = if i.separator { sub.separator() } else { sub.text(i.id.as_str(), &i.label) };
        }
        bar = bar.item(&sub.build()?);
    }
    bar.build()
}

/// A menu click (or the smoke's): hand a known id to the main window.
pub fn forward<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    if !ids().iter().any(|x| x == id) {
        return Err(format!("Unknown menu item: {id}"));
    }
    app.emit_to("main", EVENT, id).map_err(|e| e.to_string())
}

/// The installed menu bar as the window has it (empty when it has none).
#[tauri::command]
pub fn menu_state(window: tauri::WebviewWindow) -> Result<Vec<MenuState>, String> {
    let Some(bar) = window.menu() else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for kind in bar.items().map_err(|e| e.to_string())? {
        let MenuItemKind::Submenu(sub) = kind else { continue };
        let mut items = Vec::new();
        for item in sub.items().map_err(|e| e.to_string())? {
            if let MenuItemKind::MenuItem(i) = item {
                items.push(MenuItemState { id: i.id().0.clone(), label: i.text().map_err(|e| e.to_string())?, enabled: i.is_enabled().map_err(|e| e.to_string())? });
            }
        }
        out.push(MenuState { label: sub.text().map_err(|e| e.to_string())?, items });
    }
    Ok(out)
}

/// COLONY_SMOKE only: the same path as a click on a menu item (refused when the smoke is off).
#[tauri::command]
pub fn smoke_menu_click(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    if state.startup.lock().ok().and_then(|s| s.smoke.clone()).is_none() {
        return Err("not a smoke run".into());
    }
    forward(&app, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_parses_with_unique_plain_ids() {
        let spec = parse().unwrap();
        let labels: Vec<&str> = spec.menus.iter().map(|m| m.label.as_str()).collect();
        assert_eq!(labels, ["File", "View", "Run", "Help"]);
        let ids = ids();
        assert!(ids.len() >= 20, "{ids:?}");
        for want in ["open-folder", "close-window", "terminal", "quick-open", "commands", "run-plan", "interactive", "about"] {
            assert!(ids.iter().any(|i| i == want), "missing {want}");
        }
    }

    #[test]
    fn ids_are_checked() {
        assert!(valid_id("view:plans"));
        assert!(!valid_id(""));
        assert!(!valid_id("View"));
        assert!(!valid_id("a b"));
        assert!(!valid_id(&"x".repeat(65)));
    }
}
