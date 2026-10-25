//! omarchy-shell integration (kit ADR 2026-10-23 Omarchy reference platform, o3): a bar
//! widget, menu entries, and the status they read. Everything here is opt-in from
//! `More → Omarchy integration…`, which shows the plan (every file and command) before it
//! runs, and has a matching Remove.
//!
//! - **Status:** each Colony window on Omarchy keeps `$XDG_RUNTIME_DIR/colony/<pid>/status.json`
//!   (open gates, live runs, folder), removed on exit. `colony status --bar` aggregates the
//!   live ones as Waybar-style JSON; Colony's own runtime dir, nothing under Omarchy's.
//! - **Bar widget:** a third-party omarchy-shell plugin, `~/.config/omarchy/plugins/missionkit.colony/`
//!   (`packaging/omarchy/missionkit.colony/`, valid for `omarchy plugin validate`), then
//!   `omarchy-shell shell rescanPlugins` and `omarchy-plugin-enable`, so Omarchy's own
//!   tooling places it in `shell.json` (Colony never edits that canonical, unmerged file).
//! - **Menu entries:** a block between `// colony:begin` and `// colony:end` in
//!   `~/.config/omarchy/extensions/omarchy-menu.jsonc`, right after its opening brace, every
//!   entry with a trailing comma (the menu's JSONC reader drops full-line comments and
//!   trailing commas). A `colony` entry of the user's own outside the markers blocks it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const PLUGIN_ID: &str = "missionkit.colony";
const PLUGIN_MANIFEST: &str = include_str!("../../packaging/omarchy/missionkit.colony/manifest.json");
const PLUGIN_QML: &str = include_str!("../../packaging/omarchy/missionkit.colony/Colony.qml");
/// The Colony mark at bar size, next to `Colony.qml`, which tints it with the bar colours.
const PLUGIN_ICON: &str = include_str!("../../packaging/omarchy/missionkit.colony/colony-icon.svg");
const PLUGIN_ICON_FILE: &str = "colony-icon.svg";
/// The menu's icon for Colony: Nerd Font `fae-planet` (U+E22E), a ringed planet, the glyph
/// closest to the Colony mark. The menu JSONC takes a font glyph only (no image path), so the
/// menu cannot show the mark itself; the bar widget does.
const MENU_GLYPH: char = '\u{e22e}';
const BEGIN: &str = "// colony:begin";
const END: &str = "// colony:end";
const OMARCHY_BIN: &str = "/usr/share/omarchy/bin";

fn plugin_dir(home: &Path) -> PathBuf {
    home.join(".config/omarchy/plugins").join(PLUGIN_ID)
}

fn menu_file(home: &Path) -> PathBuf {
    home.join(".config/omarchy/extensions/omarchy-menu.jsonc")
}

/// The menu block, markers included, one line per entry.
pub fn menu_block() -> String {
    let when = r#""when":"command -v colony""#;
    let rows = [
        format!(r#""colony": {{"icon":"{MENU_GLYPH}","label":"Colony","description":"Mission Kit cockpit",{when}}},"#),
        format!(r#""colony.open": {{"icon":"{MENU_GLYPH}","label":"Open Colony","description":"Focus the Colony window, or start it",{when},"action":"colony"}},"#),
        format!(r#""colony.inbox": {{"icon":"{}","label":"Colony Inbox","description":"Open HITL gates of the running windows",{when},"action":"colony --inbox"}},"#, '\u{f009a}'),
        format!(r#""colony.folder": {{"icon":"{}","label":"Open folder in Colony","description":"Pick a folder in the running window",{when},"action":"colony --open-folder"}},"#, '\u{f07b}'),
    ];
    let mut out = format!("  {BEGIN} (written by Colony: More → Omarchy integration…; its Remove deletes this block)\n");
    for r in rows {
        out.push_str("  ");
        out.push_str(&r);
        out.push('\n');
    }
    out.push_str("  ");
    out.push_str(END);
    out.push('\n');
    out
}

/// The text without Colony's marked block (and whether there was one).
fn strip_block(text: &str) -> (String, bool) {
    let mut out = String::with_capacity(text.len());
    let (mut inside, mut found) = (false, false);
    for line in text.split_inclusive('\n') {
        let t = line.trim_start();
        if !inside && t.starts_with(BEGIN) {
            inside = true;
            found = true;
            continue;
        }
        if inside {
            if t.starts_with(END) {
                inside = false;
            }
            continue;
        }
        out.push_str(line);
    }
    (out, found)
}

/// A `"colony"` / `"colony.*"` key outside Colony's block: the user's own entry.
fn has_own_colony_key(text: &str) -> bool {
    text.lines().filter(|l| !l.trim_start().starts_with("//")).any(|l| l.contains("\"colony\"") || l.contains("\"colony."))
}

/// The menu file with Colony's block (replacing an older one); `Err` when it cannot be placed.
pub fn menu_with_block(current: Option<&str>) -> Result<String, String> {
    let Some(text) = current else { return Ok(format!("{{\n{}}}\n", menu_block())) };
    let (rest, _) = strip_block(text);
    if has_own_colony_key(&rest) {
        return Err("the menu file already has a \"colony\" entry of its own; Colony leaves it alone".into());
    }
    // The first `{` on a line that is not a comment opens the object.
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if !line.trim_start().starts_with("//") {
            if let Some(i) = line.find('{') {
                let at = offset + i + 1;
                let nl = if rest[at..].starts_with('\n') { 1 } else { 0 };
                let split = at + nl;
                let lead = if nl == 1 { "" } else { "\n" };
                return Ok(format!("{}{lead}{}{}", &rest[..split], menu_block(), &rest[split..]));
            }
        }
        offset += line.len();
    }
    Err("the menu file has no JSON object to add to".into())
}

/// One step of a plan, as the panel lists it before anything runs.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    /// `write`, `remove` or `run`.
    pub kind: String,
    /// The file path, or the command line.
    pub target: String,
    #[serde(skip)]
    contents: Option<String>,
    #[serde(skip)]
    argv: Vec<String>,
}

impl Step {
    fn write(path: PathBuf, contents: String) -> Self {
        Step { kind: "write".into(), target: path.display().to_string(), contents: Some(contents), argv: vec![] }
    }
    fn remove(path: PathBuf) -> Self {
        Step { kind: "remove".into(), target: path.display().to_string(), contents: None, argv: vec![] }
    }
    fn run(argv: &[&str]) -> Self {
        let argv: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
        Step { kind: "run".into(), target: argv.join(" "), contents: None, argv }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// `install` or `remove`.
    pub action: String,
    /// `absent`, `installed` or `conflict: <why>`.
    pub widget: String,
    pub menu: String,
    pub steps: Vec<Step>,
    /// Why nothing can run (both parts in conflict, or nothing to remove).
    pub blocked: Option<String>,
}

fn bin(name: &str) -> String {
    let p = Path::new(OMARCHY_BIN).join(name);
    if p.exists() { p.display().to_string() } else { name.to_string() }
}

/// The widget's state: ours (manifest id matches), absent, or someone else's directory.
fn widget_state(home: &Path) -> String {
    let dir = plugin_dir(home);
    if !dir.exists() {
        return "absent".into();
    }
    #[derive(Deserialize)]
    struct Id {
        id: String,
    }
    match std::fs::read_to_string(dir.join("manifest.json")).ok().and_then(|t| serde_json::from_str::<Id>(&t).ok()) {
        Some(m) if m.id == PLUGIN_ID => "installed".into(),
        _ => format!("conflict: {} exists and is not Colony's plugin", dir.display()),
    }
}

fn menu_state(home: &Path) -> (String, Option<String>) {
    let text = std::fs::read_to_string(menu_file(home)).ok();
    match text.as_deref() {
        None => ("absent".into(), None),
        Some(t) => {
            let (rest, found) = strip_block(t);
            if has_own_colony_key(&rest) {
                ("conflict: the menu file already has a \"colony\" entry of its own".into(), text)
            } else if found {
                ("installed".into(), text)
            } else {
                ("absent".into(), text)
            }
        }
    }
}

/// What Install would do under `home` (also an update: our files are rewritten).
pub fn install_plan(home: &Path) -> Plan {
    let widget = widget_state(home);
    let (menu, text) = menu_state(home);
    let mut steps = Vec::new();
    if !widget.starts_with("conflict") {
        let dir = plugin_dir(home);
        steps.push(Step::write(dir.join("manifest.json"), PLUGIN_MANIFEST.into()));
        steps.push(Step::write(dir.join("Colony.qml"), PLUGIN_QML.into()));
        steps.push(Step::write(dir.join(PLUGIN_ICON_FILE), PLUGIN_ICON.into()));
    }
    if !menu.starts_with("conflict") {
        if let Ok(next) = menu_with_block(text.as_deref()) {
            steps.push(Step::write(menu_file(home), next));
        }
    }
    if !widget.starts_with("conflict") {
        steps.push(Step::run(&[bin("omarchy-shell").as_str(), "shell", "rescanPlugins"]));
        steps.push(Step::run(&[bin("omarchy-plugin-enable").as_str(), PLUGIN_ID]));
    }
    let blocked = steps.is_empty().then(|| "Both the bar widget and the menu entries are blocked by files of your own.".to_string());
    Plan { action: "install".into(), widget, menu, steps, blocked }
}

/// What Remove would do: only Colony's own files and block.
pub fn remove_plan(home: &Path) -> Plan {
    let widget = widget_state(home);
    let (menu, text) = menu_state(home);
    let mut steps = Vec::new();
    if widget == "installed" {
        steps.push(Step::run(&[bin("omarchy-plugin-disable").as_str(), PLUGIN_ID]));
        let dir = plugin_dir(home);
        steps.push(Step::remove(dir.join("manifest.json")));
        steps.push(Step::remove(dir.join("Colony.qml")));
        steps.push(Step::remove(dir.join(PLUGIN_ICON_FILE)));
        steps.push(Step::remove(dir));
    }
    if menu == "installed" {
        if let Some(t) = text {
            steps.push(Step::write(menu_file(home), strip_block(&t).0));
        }
    }
    if widget == "installed" {
        steps.push(Step::run(&[bin("omarchy-shell").as_str(), "shell", "rescanPlugins"]));
    }
    let blocked = steps.is_empty().then(|| "Nothing of Colony's is installed.".to_string());
    Plan { action: "remove".into(), widget, menu, steps, blocked }
}

fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("colony-tmp-{}", std::process::id()));
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)
}

/// Run a plan's steps in order; a failed command is reported and the rest still runs
/// (files stay as written, the report says what to run by hand).
pub fn apply<R: Fn(&[String]) -> Result<String, String>>(plan: &Plan, run: R) -> Vec<String> {
    let mut report = Vec::new();
    for s in &plan.steps {
        let r = match s.kind.as_str() {
            "write" => write_atomic(Path::new(&s.target), s.contents.as_deref().unwrap_or("")).map(|_| format!("wrote {}", s.target)).map_err(|e| e.to_string()),
            "remove" => {
                let p = Path::new(&s.target);
                let r = if p.is_dir() { std::fs::remove_dir(p) } else { std::fs::remove_file(p) };
                match r {
                    Ok(()) => Ok(format!("removed {}", s.target)),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(format!("already gone: {}", s.target)),
                    Err(e) => Err(e.to_string()),
                }
            }
            _ => run(&s.argv).map(|out| format!("ran {}{}", s.target, if out.trim().is_empty() { String::new() } else { format!(": {}", out.trim()) })),
        };
        report.push(match r {
            Ok(m) => m,
            Err(e) => format!("failed: {} ({e})", s.target),
        });
    }
    report
}

fn run_command(argv: &[String]) -> Result<String, String> {
    let (cmd, args) = argv.split_first().ok_or("empty command")?;
    let out = std::process::Command::new(cmd).args(args).stdin(std::process::Stdio::null()).output().map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() { Ok(text) } else { Err(text.trim().to_string()) }
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from).ok_or_else(|| "HOME is not set".into())
}

fn omarchy_only() -> Result<(), String> {
    if crate::omarchy::detected() { Ok(()) } else { Err("Omarchy is not installed here".into()) }
}

/// The plan for `install` or `remove`, listed before anything runs.
#[tauri::command]
pub fn omarchy_integration_plan(action: String) -> Result<Plan, String> {
    omarchy_only()?;
    let home = home()?;
    match action.as_str() {
        "install" => Ok(install_plan(&home)),
        "remove" => Ok(remove_plan(&home)),
        _ => Err(format!("unknown action {action}")),
    }
}

/// Run the plan for `action` (recomputed now) after the user confirmed the listed one.
#[tauri::command(async)]
pub fn omarchy_integration_apply(action: String) -> Result<Vec<String>, String> {
    let plan = omarchy_integration_plan(action)?;
    if let Some(why) = plan.blocked {
        return Err(why);
    }
    Ok(apply(&plan, run_command))
}

// ---- status ----------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Status {
    pub v: u32,
    pub pid: u32,
    pub folder: Option<String>,
    pub gates: u32,
    pub runs: u32,
}

/// `$XDG_RUNTIME_DIR/colony`, when there is a runtime dir.
fn runtime_base() -> Option<PathBuf> {
    std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).filter(|p| p.is_absolute() && p.is_dir()).map(|p| p.join("colony"))
}

/// This window's status file.
pub fn status_path() -> Option<PathBuf> {
    runtime_base().map(|b| b.join(std::process::id().to_string()).join("status.json"))
}

/// Keep this window's status for the bar widget (Omarchy only; a no-op elsewhere).
#[tauri::command]
pub fn shell_status_set(folder: Option<String>, gates: u32, runs: u32) -> Result<(), String> {
    if !crate::omarchy::detected() {
        return Ok(());
    }
    let Some(path) = status_path() else { return Ok(()) };
    let s = Status { v: 1, pid: std::process::id(), folder, gates, runs };
    if let Some(dir) = path.parent() {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(|e| e.to_string())?;
    }
    write_atomic(&path, &serde_json::to_string(&s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// The status of every live window under `base`.
fn live_statuses(base: &Path) -> Vec<Status> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(base).into_iter().flatten().flatten() {
        let Ok(pid) = e.file_name().to_string_lossy().parse::<u32>() else { continue };
        if !crate::hostreq::pid_alive(pid) {
            continue;
        }
        let Some(s) = std::fs::read_to_string(e.path().join("status.json")).ok().and_then(|t| serde_json::from_str::<Status>(&t).ok()) else { continue };
        if s.pid == pid {
            out.push(s);
        }
    }
    out.sort_by_key(|s| s.pid);
    out
}

/// Waybar-style JSON for the bar widget.
pub fn bar_json(all: &[Status]) -> serde_json::Value {
    let gates: u32 = all.iter().map(|s| s.gates).sum();
    let runs: u32 = all.iter().map(|s| s.runs).sum();
    let plural = |n: u32, w: &str| format!("{n} {w}{}", if n == 1 { "" } else { "s" });
    let tooltip = if all.is_empty() {
        "Colony is not running".to_string()
    } else {
        all.iter()
            .map(|s| {
                let name = s.folder.as_deref().and_then(|f| Path::new(f).file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "no folder".into());
                format!("{name}: {}, {}", plural(s.gates, "gate"), plural(s.runs, "run"))
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let class = if all.is_empty() { "none" } else if gates > 0 { "gate" } else if runs > 0 { "running" } else { "idle" };
    serde_json::json!({
        "text": if gates > 0 { gates.to_string() } else { String::new() },
        "tooltip": tooltip,
        "class": class,
        "gates": gates,
        "runs": runs,
        "windows": all.len(),
    })
}

/// `colony status [--bar]`: print the aggregate status, no GUI.
pub fn cli_main() -> i32 {
    let all = runtime_base().map(|b| live_statuses(&b)).unwrap_or_default();
    println!("{}", bar_json(&all));
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("colony-omarchy-shell-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// The menu's own reader (MenuModel.js stripJsonc): full-line comments and trailing commas go.
    fn strip_jsonc(raw: &str) -> String {
        let no_comments: String = raw.split_inclusive('\n').filter(|l| !l.trim_start().starts_with("//")).collect();
        let mut out = String::new();
        let chars: Vec<char> = no_comments.chars().collect();
        for (i, c) in chars.iter().enumerate() {
            if *c == ',' && chars[i + 1..].iter().find(|c| !c.is_whitespace()).is_some_and(|n| *n == '}' || *n == ']') {
                continue;
            }
            out.push(*c);
        }
        out
    }

    const OMARCHY_TEMPLATE: &str = "{\n  // Extend the Quickshell Omarchy menu with JSONC.\n  // \"personal\": {\"icon\":\"\",\"label\":\"Personal\"},\n}\n";

    #[test]
    fn block_parses_in_the_template_an_empty_file_and_after_user_entries() {
        for current in [Some(OMARCHY_TEMPLATE), None, Some("{\n  \"mine\": {\"label\":\"Mine\",\"action\":\"x\"}\n}\n"), Some("{ \"mine\": {\"label\":\"Mine\"} }")] {
            let text = menu_with_block(current).unwrap();
            let v: serde_json::Value = serde_json::from_str(&strip_jsonc(&text)).unwrap_or_else(|e| panic!("{e}\n{text}"));
            assert_eq!(v["colony.inbox"]["action"], "colony --inbox");
            assert_eq!(v["colony"]["when"], "command -v colony");
            if let Some(c) = current {
                if c.contains("mine") {
                    assert!(v.get("mine").is_some());
                }
            }
        }
    }

    #[test]
    fn install_twice_keeps_one_block_and_remove_restores_the_file() {
        let once = menu_with_block(Some(OMARCHY_TEMPLATE)).unwrap();
        let twice = menu_with_block(Some(&once)).unwrap();
        assert_eq!(once, twice);
        assert_eq!(strip_block(&twice).0, OMARCHY_TEMPLATE);
    }

    #[test]
    fn a_colony_entry_of_the_users_own_blocks_the_menu() {
        let own = "{\n  \"colony\": {\"label\":\"My Colony\"},\n}\n";
        assert!(menu_with_block(Some(own)).is_err());
        // Commented out it is not an entry.
        assert!(menu_with_block(Some("{\n  // \"colony\": {},\n}\n")).is_ok());
        assert!(menu_with_block(Some("// only a comment\n")).is_err());
    }

    #[test]
    fn plans_on_a_scratch_home_list_every_file_and_command() {
        let home = tmp("plan");
        let p = install_plan(&home);
        assert_eq!((p.widget.as_str(), p.menu.as_str()), ("absent", "absent"));
        let targets: Vec<_> = p.steps.iter().map(|s| (s.kind.as_str(), s.target.replace(&home.display().to_string(), "~"))).collect();
        assert_eq!(targets[0], ("write", "~/.config/omarchy/plugins/missionkit.colony/manifest.json".into()));
        assert_eq!(targets[1], ("write", "~/.config/omarchy/plugins/missionkit.colony/Colony.qml".into()));
        assert_eq!(targets[2], ("write", "~/.config/omarchy/plugins/missionkit.colony/colony-icon.svg".into()));
        assert_eq!(targets[3], ("write", "~/.config/omarchy/extensions/omarchy-menu.jsonc".into()));
        assert!(targets[4].1.ends_with("omarchy-shell shell rescanPlugins"));
        assert!(targets[5].1.ends_with("omarchy-plugin-enable missionkit.colony"));
        assert!(remove_plan(&home).blocked.is_some());

        // Apply with a recording runner: no omarchy command really runs.
        let ran = std::sync::Mutex::new(Vec::new());
        let report = apply(&p, |argv| {
            ran.lock().unwrap().push(argv.join(" "));
            Ok(String::new())
        });
        assert!(report.iter().all(|l| !l.starts_with("failed")), "{report:?}");
        assert_eq!(ran.lock().unwrap().len(), 2);
        assert_eq!(std::fs::read_to_string(plugin_dir(&home).join("Colony.qml")).unwrap(), PLUGIN_QML);
        assert_eq!(std::fs::read_to_string(plugin_dir(&home).join("colony-icon.svg")).unwrap(), PLUGIN_ICON);
        assert_eq!(install_plan(&home).widget, "installed");
        assert_eq!(install_plan(&home).menu, "installed");

        let r = remove_plan(&home);
        assert!(r.steps[0].target.ends_with("omarchy-plugin-disable missionkit.colony"));
        assert!(r.steps.iter().any(|s| s.kind == "remove" && s.target.ends_with("missionkit.colony/colony-icon.svg")));
        let report = apply(&r, |_| Ok(String::new()));
        assert!(report.iter().all(|l| !l.starts_with("failed")), "{report:?}");
        assert!(!plugin_dir(&home).exists());
        let menu = std::fs::read_to_string(menu_file(&home)).unwrap();
        assert!(!menu.contains("colony"), "{menu}");
    }

    #[test]
    fn someone_elses_plugin_dir_is_never_touched() {
        let home = tmp("conflict");
        let dir = plugin_dir(&home);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), r#"{"id":"someone.else"}"#).unwrap();
        let p = install_plan(&home);
        assert!(p.widget.starts_with("conflict"));
        assert!(p.steps.iter().all(|s| !s.target.contains("plugins/")), "{:?}", p.steps);
        assert!(remove_plan(&home).steps.iter().all(|s| !s.target.contains("plugins/")));
    }

    #[test]
    fn a_failed_command_is_reported_and_files_stay() {
        let home = tmp("fail");
        let report = apply(&install_plan(&home), |_| Err("shell not running".into()));
        assert!(report.iter().any(|l| l.starts_with("failed:") && l.contains("shell not running")));
        assert!(plugin_dir(&home).join("manifest.json").exists());
    }

    #[test]
    fn bar_json_sums_live_windows() {
        let none = bar_json(&[]);
        assert_eq!(none["class"], "none");
        assert_eq!(none["text"], "");
        let all = [
            Status { v: 1, pid: 10, folder: Some("/w/alpha".into()), gates: 2, runs: 1 },
            Status { v: 1, pid: 11, folder: None, gates: 0, runs: 1 },
        ];
        let j = bar_json(&all);
        assert_eq!(j["text"], "2");
        assert_eq!(j["class"], "gate");
        assert_eq!(j["windows"], 2);
        assert_eq!(j["tooltip"], "alpha: 2 gates, 1 run\nno folder: 0 gates, 1 run");
    }

    #[test]
    fn live_statuses_skip_dead_pids_and_foreign_files() {
        let base = tmp("status");
        let me = std::process::id();
        std::fs::create_dir_all(base.join(me.to_string())).unwrap();
        std::fs::write(base.join(me.to_string()).join("status.json"), format!(r#"{{"v":1,"pid":{me},"gates":1,"runs":0}}"#)).unwrap();
        // A pid that is not running (pid_max is far below this) and a non-pid entry.
        std::fs::create_dir_all(base.join("2147483000")).unwrap();
        std::fs::write(base.join("2147483000/status.json"), r#"{"v":1,"pid":2147483000,"gates":5}"#).unwrap();
        std::fs::create_dir_all(base.join("requests")).unwrap();
        let s = live_statuses(&base);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].gates, 1);
    }

    #[test]
    fn shipped_plugin_manifest_names_its_entry_point() {
        let m: serde_json::Value = serde_json::from_str(PLUGIN_MANIFEST).unwrap();
        assert_eq!(m["id"], PLUGIN_ID);
        assert_eq!(m["schemaVersion"], 1);
        assert_eq!(m["entryPoints"]["barWidget"], "Colony.qml");
        assert!(PLUGIN_QML.contains("\"status\", \"--bar\""));
    }

    /// The `d` / `cx` / `cy` attributes of an SVG, in order.
    fn shape_attrs(svg: &str) -> Vec<String> {
        let mut out = Vec::new();
        for key in [" d=\"", " cx=\"", " cy=\""] {
            let mut rest = svg;
            while let Some(i) = rest.find(key) {
                rest = &rest[i + key.len()..];
                let end = rest.find('"').unwrap();
                out.push(format!("{}{}", key.trim(), &rest[..end]));
                rest = &rest[end..];
            }
        }
        out
    }

    #[test]
    fn the_bar_widget_shows_the_colony_mark_tinted_with_the_bar_colours() {
        // Not the robot (nf-md-robot U+F06A9, the surrogate pair QML spells it with).
        for robot in ["\\uDB81\\uDEA9", "\u{f06a9}", "f06a9"] {
            assert!(!PLUGIN_QML.contains(robot), "robot glyph {robot} still in Colony.qml");
            assert!(!menu_block().contains(robot), "robot glyph {robot} still in the menu");
        }
        // The mark, as an Image beside the QML, tinted by MultiEffect with foreground / urgent.
        assert!(PLUGIN_QML.contains("Qt.resolvedUrl(\"colony-icon.svg\")"));
        assert!(PLUGIN_QML.contains("import QtQuick.Effects"));
        assert!(PLUGIN_QML.contains("colorizationColor: root.tint"));
        assert!(PLUGIN_QML.contains("root.gates > 0 ? root.bar.urgent : root.bar.foreground"));
        // White, so the tint is the bar colour itself.
        assert!(PLUGIN_ICON.contains("stroke=\"#FFFFFF\"") && !PLUGIN_ICON.contains("#E6E6E6"));
        // The bar cut keeps the brand mark's planet, ring and moon (only the highlight arc goes).
        let brand = shape_attrs(include_str!("../../assets/brand/colony-icon.svg"));
        let bar = shape_attrs(PLUGIN_ICON);
        assert_eq!(bar.len(), 4, "{bar:?}");
        for a in &bar {
            assert!(brand.contains(a), "{a} is not in assets/brand/colony-icon.svg");
        }
        // The menu takes a glyph only: the ringed planet for Colony and Open Colony.
        let menu: serde_json::Value = serde_json::from_str(&strip_jsonc(&menu_with_block(None).unwrap())).unwrap();
        assert_eq!(menu["colony"]["icon"], "\u{e22e}");
        assert_eq!(menu["colony.open"]["icon"], "\u{e22e}");
    }

    #[test]
    fn an_install_from_before_the_icon_still_removes_cleanly() {
        let home = tmp("old-install");
        let dir = plugin_dir(&home);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), PLUGIN_MANIFEST).unwrap();
        std::fs::write(dir.join("Colony.qml"), "// 1.0.0").unwrap();
        let report = apply(&remove_plan(&home), |_| Ok(String::new()));
        assert!(report.iter().all(|l| !l.starts_with("failed")), "{report:?}");
        assert!(report.iter().any(|l| l.starts_with("already gone:") && l.ends_with("colony-icon.svg")), "{report:?}");
        assert!(!dir.exists());
    }
}
