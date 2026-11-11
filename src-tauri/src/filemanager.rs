//! Open in terminal file manager (File menu `file-manager`, the Explorer's menu row and the
//! palette; kit shell ADR 2026-10-24, amend 2026-10-29 points 1 and 4; plan
//! colony-explorer-file-ops e3). The `fileManager` setting, else the first of yazi, lf, nnn,
//! ranger and broot on PATH, runs as a drawer tab through `pty_spawn` in the folder the operator
//! picked (the PTY's working directory: no path argument is passed). Nothing is ever installed:
//! with none on PATH the page shows a hint naming an install command.
//!
//! The lookup reads the host PATH (an AppImage's own entries removed, appimage.rs), and the tab
//! starts with the host environment (`pty_spawn` `hostEnv`), so the program loads the host's
//! libraries rather than the AppImage's bundled ones.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::{settings, tools, AppState};

/// Detected in this order (the plan's list).
pub const FILE_MANAGERS: [&str; 5] = ["yazi", "lf", "nnn", "ranger", "broot"];

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileManagerLaunch {
    /// The drawer tab's argv (the program as found on PATH); empty when none was found.
    pub argv: Vec<String>,
    /// The tab label: the program's name.
    pub label: String,
    /// `settings` (the `fileManager` setting), `PATH` (detected), or "" when none was found.
    pub source: String,
    /// With no file manager: what to install (an install command when a package manager is
    /// on PATH). Colony runs none of it.
    pub hint: String,
}

fn basename(s: &str) -> &str {
    s.rsplit('/').next().unwrap_or(s)
}

/// Package managers and the line the hint names for each (the first one on PATH wins).
const INSTALLERS: [(&str, &str); 5] = [("pacman", "sudo pacman -S yazi"), ("apt", "sudo apt install nnn"), ("dnf", "sudo dnf install nnn"), ("zypper", "sudo zypper install nnn"), ("brew", "brew install yazi")];

fn install_hint(find: &dyn Fn(&str) -> Option<PathBuf>) -> String {
    let how = match INSTALLERS.iter().find(|(pm, _)| find(pm).is_some()) {
        Some((_, line)) => format!("Install one, for example `{line}`,"),
        None => "Install one with your package manager".to_string(),
    };
    format!("No terminal file manager on PATH (yazi, lf, nnn, ranger or broot). {how} then try again, or name one in settings.json \"fileManager\". Colony installs nothing.")
}

/// The launch plan (pure, unit-tested): `setting` is settings.json `fileManager` (a string split
/// on whitespace, or an argv array); `find` resolves a program name on the host PATH.
pub(crate) fn plan(setting: Option<&serde_json::Value>, find: &dyn Fn(&str) -> Option<PathBuf>) -> Result<FileManagerLaunch, String> {
    if let Some(v) = setting.filter(|v| !v.is_null()) {
        let words: Vec<String> = match v {
            serde_json::Value::String(s) => s.split_whitespace().map(String::from).collect(),
            serde_json::Value::Array(a) => a.iter().map(|x| x.as_str().map(String::from).ok_or("fileManager: an array must hold strings only")).collect::<Result<_, _>>()?,
            _ => return Err("fileManager must be a string or an array of strings".into()),
        };
        let Some(first) = words.first() else { return Err("fileManager is empty".into()) };
        let prog = find(first).ok_or_else(|| format!("fileManager {first} is not on PATH"))?;
        let mut argv = vec![prog.display().to_string()];
        argv.extend(words[1..].iter().cloned());
        return Ok(FileManagerLaunch { argv, label: basename(first).to_string(), source: "settings".into(), hint: String::new() });
    }
    for name in FILE_MANAGERS {
        if let Some(p) = find(name) {
            return Ok(FileManagerLaunch { argv: vec![p.display().to_string()], label: name.into(), source: "PATH".into(), hint: String::new() });
        }
    }
    Ok(FileManagerLaunch { argv: Vec::new(), label: String::new(), source: String::new(), hint: install_hint(find) })
}

/// `name` on `path` (a PATH value); a name with a slash is taken as a path to the program.
fn find_on(path: &OsStr, name: &str) -> Option<PathBuf> {
    if name.is_empty() {
        return None;
    }
    if name.contains('/') {
        let p = PathBuf::from(name);
        return tools::is_executable(&p).then_some(p);
    }
    std::env::split_paths(path).map(|d| d.join(name)).find(|p| tools::is_executable(p))
}

/// The PATH a host program sees: this process's, without the AppImage's own entries.
fn host_path() -> OsString {
    #[cfg(target_os = "linux")]
    if let Some((_, value)) = crate::appimage::process_host_env_changes().into_iter().find(|(k, _)| k == "PATH") {
        return value.unwrap_or_default();
    }
    std::env::var_os("PATH").unwrap_or_default()
}

/// Read-only: what Open in terminal file manager would run (the page opens the drawer tab
/// with `pty_spawn`, `hostEnv` on, in the picked folder) or the not-installed hint.
#[tauri::command]
pub fn file_manager_launch(state: State<'_, AppState>) -> Result<FileManagerLaunch, String> {
    let setting = settings::current(&state)?.file_manager;
    let path = host_path();
    plan(setting.as_ref(), &|name| find_on(&path, name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A PATH holding exactly `bins` (as `/bin/<name>`).
    fn on_path(bins: &'static [&'static str]) -> impl Fn(&str) -> Option<PathBuf> {
        move |n: &str| bins.contains(&n).then(|| PathBuf::from(format!("/bin/{n}")))
    }

    #[test]
    fn first_on_path_wins_in_the_plan_order() {
        let p = plan(None, &on_path(&["broot", "nnn", "lf"])).unwrap();
        assert_eq!((p.argv, p.label.as_str(), p.source.as_str(), p.hint.as_str()), (vec!["/bin/lf".to_string()], "lf", "PATH", ""));
        assert_eq!(plan(None, &on_path(&["ranger", "yazi"])).unwrap().label, "yazi");
        assert_eq!(plan(None, &on_path(&["broot"])).unwrap().argv, ["/bin/broot"]);
    }

    #[test]
    fn the_setting_overrides_the_detection() {
        let p = plan(Some(&json!("nnn -d")), &on_path(&["yazi", "nnn"])).unwrap();
        assert_eq!((p.argv, p.label.as_str(), p.source.as_str()), (vec!["/bin/nnn".to_string(), "-d".to_string()], "nnn", "settings"));
        let a = plan(Some(&json!(["ranger", "--choosedir=/tmp/x"])), &on_path(&["ranger"])).unwrap();
        assert_eq!(a.argv, ["/bin/ranger", "--choosedir=/tmp/x"]);
        // null is the same as no setting.
        assert_eq!(plan(Some(&json!(null)), &on_path(&["lf"])).unwrap().source, "PATH");
    }

    #[test]
    fn a_setting_that_is_not_on_path_or_malformed_is_an_error() {
        assert_eq!(plan(Some(&json!("mc")), &on_path(&["yazi"])).unwrap_err(), "fileManager mc is not on PATH");
        assert!(plan(Some(&json!("  ")), &on_path(&["yazi"])).is_err());
        assert!(plan(Some(&json!([])), &on_path(&["yazi"])).is_err());
        assert!(plan(Some(&json!(["yazi", 3])), &on_path(&["yazi"])).is_err());
        assert!(plan(Some(&json!(7)), &on_path(&["yazi"])).is_err());
    }

    #[test]
    fn none_installed_gives_a_hint_and_no_argv() {
        let arch = plan(None, &on_path(&["pacman", "fzf"])).unwrap();
        assert!(arch.argv.is_empty() && arch.source.is_empty());
        assert!(arch.hint.contains("`sudo pacman -S yazi`") && arch.hint.contains("Colony installs nothing"), "{}", arch.hint);
        assert!(plan(None, &on_path(&["apt"])).unwrap().hint.contains("`sudo apt install nnn`"));
        let bare = plan(None, &on_path(&[])).unwrap();
        assert!(bare.hint.contains("with your package manager") && !bare.hint.contains('`'), "{}", bare.hint);
    }

    #[test]
    fn find_on_reads_the_given_path_only() {
        let dir = std::env::temp_dir().join(format!("colony-fm-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("lf");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&bin, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        std::fs::write(dir.join("nnn"), "not executable").unwrap();
        let path = dir.as_os_str();
        assert_eq!(find_on(path, "lf"), Some(bin.clone()));
        assert_eq!(find_on(path, "nnn"), None);
        assert_eq!(find_on(path, "yazi"), None);
        assert_eq!(find_on(OsStr::new(""), "lf"), None);
        assert_eq!(find_on(OsStr::new("/nonexistent"), bin.to_str().unwrap()), Some(bin.clone()));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
