//! Native menu bar (File, View, Run, Help). The items come from `src/menu.json`, the one
//! command source: its `menus` are this bar, its `config` the action rows of Workspace →
//! Config (settings only; the window renders those, never here). Every id sits in exactly one
//! of the two and is a key of the window's action map (src/main.ts `runAction`); the tests
//! below check that against main.ts. A click emits `colony-menu` with the item id to the
//! main window; the window runs the action.
//!
//! No accelerators and no mnemonics: GTK binds them on the window, before the webview,
//! and would take Ctrl+P, Alt+F, ... from the terminals and the editor. The window's own
//! keyboard handler keeps the shortcuts.

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuBuilder, MenuItemKind, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::AppState;

/// The event the window listens to (payload: the item id).
pub const EVENT: &str = "colony-menu";

const SPEC: &str = include_str!("../../src/menu.json");

#[derive(Deserialize, Debug)]
struct Spec {
    menus: Vec<SpecMenu>,
    /// The action rows of Workspace → Config (src/main.ts renders them; not in the bar).
    #[serde(default)]
    config: Vec<SpecItem>,
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

fn parse_str(text: &str) -> Result<Spec, String> {
    let spec: Spec = serde_json::from_str(text).map_err(|e| format!("src/menu.json: {e}"))?;
    let mut seen = std::collections::HashSet::new();
    let mut check = |i: &SpecItem| {
        if !valid_id(&i.id) || !seen.insert(i.id.clone()) {
            return Err(format!("src/menu.json: bad or duplicate id {:?}", i.id));
        }
        if i.label.trim().is_empty() || i.label.contains('&') || i.label.contains('_') {
            return Err(format!("src/menu.json: label of {} is empty or has a mnemonic marker", i.id));
        }
        Ok(())
    };
    for m in &spec.menus {
        if m.label.trim().is_empty() || m.items.is_empty() {
            return Err("src/menu.json: a menu without a label or items".into());
        }
        for i in m.items.iter().filter(|i| !i.separator) {
            check(i)?;
        }
    }
    // One id, one place: a Config row may not repeat a menu bar item (nor carry a separator:
    // the Config pane draws its own section breaks).
    for i in &spec.config {
        check(i)?;
    }
    Ok(spec)
}

fn parse() -> Result<Spec, String> {
    parse_str(SPEC)
}

/// Every action id of the menu bar, in menu order.
pub fn ids() -> Vec<String> {
    parse().map(|s| s.menus.into_iter().flat_map(|m| m.items).filter(|i| !i.separator).map(|i| i.id).collect()).unwrap_or_default()
}

fn spec() -> tauri::Result<Spec> {
    parse().map_err(|e| tauri::Error::Io(std::io::Error::other(e)))
}

fn submenu<R: Runtime, M: Manager<R>>(manager: &M, m: &SpecMenu) -> tauri::Result<Submenu<R>> {
    let mut sub = SubmenuBuilder::new(manager, &m.label);
    for i in &m.items {
        sub = if i.separator { sub.separator() } else { sub.text(i.id.as_str(), &i.label) };
    }
    sub.build()
}

/// The menu bar for the main window (native title bar).
pub fn build<R: Runtime, M: Manager<R>>(manager: &M) -> tauri::Result<Menu<R>> {
    let mut bar = MenuBuilder::new(manager);
    for m in &spec()?.menus {
        bar = bar.item(&submenu(manager, m)?);
    }
    bar.build()
}

/// Custom title bar: no GTK menu bar above the webview (it would sit over Colony's own
/// title bar); the title bar's File / View / Run / Help buttons open the same menu, by
/// index, as a native popup under the button (logical coordinates in the window).
#[tauri::command]
pub fn menu_popup(window: tauri::WebviewWindow, index: usize, x: f64, y: f64) -> Result<(), String> {
    let spec = spec().map_err(|e| e.to_string())?;
    let m = spec.menus.get(index).ok_or_else(|| format!("No menu {index}"))?;
    let sub = submenu(&window, m).map_err(|e| e.to_string())?;
    window.popup_menu_at(&sub, tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())
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

    const MAIN_TS: &str = include_str!("../../src/main.ts");

    /// The action ids of Workspace → Config (settings only; never in the menu bar).
    fn config_ids() -> Vec<String> {
        parse().unwrap().config.into_iter().map(|i| i.id).collect()
    }

    /// The text of `main.ts` from `start` to the first `end` after it.
    fn main_ts_block(start: &str, end: &str) -> &'static str {
        let from = MAIN_TS.find(start).unwrap_or_else(|| panic!("main.ts has no {start:?}"));
        let rest = &MAIN_TS[from..];
        &rest[..rest.find(end).unwrap_or_else(|| panic!("main.ts: {start:?} has no {end:?}"))]
    }

    /// The keys of the ACTIONS map in main.ts: its lines at a 2-space indent, `"a:b": ...` or `a: ...`.
    fn action_keys() -> Vec<String> {
        main_ts_block("const ACTIONS", "\n};")
            .lines()
            .filter_map(|l| {
                let entry = l.strip_prefix("  ").filter(|e| !e.starts_with(' '))?;
                let key = match entry.strip_prefix('"') {
                    Some(quoted) => quoted.split_once("\":")?.0,
                    None => entry.split_once(':')?.0,
                };
                valid_id(key).then(|| key.to_string())
            })
            .collect()
    }

    /// The quoted strings of a `[...]` list in main.ts that starts after `start`.
    fn quoted_list(after: &str) -> Vec<String> {
        main_ts_block(after, "]").split('"').skip(1).step_by(2).map(String::from).collect()
    }

    /// Every `view:<id>` the window resolves: the rail items, and Workspace's sections.
    fn view_ids() -> Vec<String> {
        let rail = main_ts_block("const RAIL: RailItem[] = [", "\n];");
        let mut out: Vec<String> = rail
            .lines()
            .filter(|l| l.contains("views: "))
            .filter_map(|l| l.split("id: \"").nth(1)?.split('"').next().map(|id| format!("view:{id}")))
            .collect();
        out.extend(quoted_list("const WORKSPACE_SECTIONS = [").into_iter().map(|v| format!("view:{v}")));
        out
    }

    #[test]
    fn no_action_is_in_both_the_menu_bar_and_config() {
        let bar = ids();
        let config = config_ids();
        assert!(!config.is_empty(), "Config has no action rows");
        for id in &config {
            assert!(!bar.contains(id), "{id} is in the menu bar and in Config");
        }
    }

    /// The settings Workspace → Config may hold as action rows (Skin, Title bar and Rail are
    /// markup in main.ts). Views, commands, About and Engine live in the menu bar: a new id
    /// here is a decision.
    const CONFIG_SETTINGS: &[&str] = &["omarchy"];

    #[test]
    fn config_holds_settings_only() {
        for id in config_ids() {
            assert!(CONFIG_SETTINGS.contains(&id.as_str()), "{id} in Config: Config holds settings only (CONFIG_SETTINGS)");
        }
        // Config's action rows come from menu.json, not from markup in main.ts.
        let markup = main_ts_block("<div id=\"settings-pane\"", "</div>\n<div id=\"quick\"");
        assert!(!markup.contains("data-cmd"), "main.ts hard-codes a Config action row: {markup}");
    }

    #[test]
    fn the_rail_has_no_more_menu() {
        // (`top-more-menu` is the top bar's overflow of agent actions, not the rail's More.)
        for gone in ["\"btn-more\"", "\"more-menu\"", "toggleMore", "OFF_RAIL_VIEWS"] {
            assert!(!MAIN_TS.contains(gone), "{gone}: no More menu and no off-rail views (ADR 2026-10-24 amend 2026-10-28)");
        }
    }

    #[test]
    fn every_action_is_in_exactly_one_menu() {
        let keys = action_keys();
        assert!(keys.len() >= 20 && keys.iter().any(|k| k == "new-terminal") && keys.iter().any(|k| k == "settings"), "{keys:?}");
        let all: Vec<String> = ids().into_iter().chain(config_ids()).collect();
        for k in &keys {
            assert_eq!(all.iter().filter(|i| *i == k).count(), 1, "action {k} is not in exactly one of the menu bar and Config");
        }
        let views = view_ids();
        for id in &all {
            if id.starts_with("view:") {
                assert!(views.contains(id), "{id} names no view ({views:?})");
            } else {
                assert!(keys.contains(id), "{id} has no action in main.ts ACTIONS");
            }
        }
    }

    #[test]
    fn view_items_resolve() {
        let views = view_ids();
        for want in ["view:mission", "view:ship", "view:workspace", "view:plans", "view:config", "view:flight", "view:activity", "view:terminals"] {
            assert!(views.iter().any(|v| v == want), "{want} not in {views:?}");
        }
        assert!(!views.iter().any(|v| v == "view:terminal"), "Terminal is a toggle, not a view");
    }

    #[test]
    fn a_duplicate_id_is_refused() {
        let twice_in_bar = r#"{"menus":[{"label":"A","items":[{"id":"x","label":"X"},{"id":"x","label":"X again"}]}]}"#;
        assert!(parse_str(twice_in_bar).is_err());
        let bar_and_config = r#"{"menus":[{"label":"A","items":[{"id":"x","label":"X"}]}],"config":[{"id":"x","label":"X"}]}"#;
        assert!(parse_str(bar_and_config).is_err());
        let twice_in_config = r#"{"menus":[{"label":"A","items":[{"id":"x","label":"X"}]}],"config":[{"id":"y","label":"Y"},{"id":"y","label":"Y"}]}"#;
        assert!(parse_str(twice_in_config).is_err());
        let fine = r#"{"menus":[{"label":"A","items":[{"id":"x","label":"X"}]}],"config":[{"id":"y","label":"Y"}]}"#;
        assert_eq!(parse_str(fine).map(|s| s.config.len()), Ok(1));
        let separator_in_config = r#"{"menus":[{"label":"A","items":[{"id":"x","label":"X"}]}],"config":[{"separator":true}]}"#;
        assert!(parse_str(separator_in_config).is_err());
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
