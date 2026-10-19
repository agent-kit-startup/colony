//! "Open in my editor": hand the current file or folder to the user's own editor.
//!
//! Resolution: the `editor.command` setting, else `$VISUAL`, else `$EDITOR`, else
//! `xdg-open`. `$VISUAL` / `$EDITOR` are terminal conventions (git runs them in the
//! terminal it was started from), so by default they run in a new Colony terminal tab
//! through `sh -c '<editor> "$@"'`, exactly like git does; this also covers wrappers such
//! as `omarchy-launch-editor --inline`. A configured command runs detached unless it is a
//! known terminal editor or `editor.terminal` says otherwise. `xdg-open` always runs
//! detached. The path is always passed as its own argument, never interpolated.

use std::path::Path;
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::State;

use crate::{settings, workspace, AppState};

/// Editors that need a terminal to draw in.
const TUI_EDITORS: &[&str] = &["vi", "vim", "nvim", "nano", "micro", "hx", "helix", "kak", "emacs", "mg", "joe", "ne", "fresh"];

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorLaunch {
    /// `terminal`: the UI opens a terminal tab running `argv`; `detached`: already started.
    mode: String,
    argv: Vec<String>,
    /// Where the editor choice came from: `settings`, `VISUAL`, `EDITOR` or `xdg-open`.
    source: String,
    label: String,
}

fn basename(s: &str) -> &str {
    s.rsplit('/').next().unwrap_or(s)
}

/// Build the launch plan (pure, so it is unit-tested). `env` returns `$VISUAL` / `$EDITOR`.
fn plan(cfg: &settings::EditorSettings, env: impl Fn(&str) -> Option<String>, path: &str) -> Result<EditorLaunch, String> {
    let label_for = |prog: &str| format!("{} {}", basename(prog), basename(path.trim_end_matches('/')));
    if let Some(cmd) = &cfg.command {
        let words: Vec<String> = match cmd {
            serde_json::Value::String(s) => s.split_whitespace().map(String::from).collect(),
            serde_json::Value::Array(a) => a.iter().map(|v| v.as_str().map(String::from).ok_or("editor.command array must hold strings")).collect::<Result<_, _>>()?,
            _ => return Err("editor.command must be a string or an array of strings".into()),
        };
        if words.is_empty() {
            return Err("editor.command is empty".into());
        }
        let mut argv: Vec<String> = Vec::with_capacity(words.len() + 1);
        let mut placed = false;
        for w in &words {
            if w.contains("{path}") {
                argv.push(w.replace("{path}", path));
                placed = true;
            } else {
                argv.push(w.clone());
            }
        }
        if !placed {
            argv.push(path.to_string());
        }
        let terminal = cfg.terminal.unwrap_or_else(|| TUI_EDITORS.contains(&basename(&words[0])));
        let label = label_for(&words[0]);
        return Ok(EditorLaunch { mode: if terminal { "terminal" } else { "detached" }.into(), argv, source: "settings".into(), label });
    }
    for var in ["VISUAL", "EDITOR"] {
        let Some(editor) = env(var).filter(|v| !v.trim().is_empty()) else { continue };
        let editor = editor.trim().to_string();
        let first = editor.split_whitespace().next().unwrap_or("").to_string();
        let argv = vec!["/bin/sh".into(), "-c".into(), format!("{editor} \"$@\""), basename(&first).to_string(), path.to_string()];
        let terminal = cfg.terminal.unwrap_or(true);
        return Ok(EditorLaunch { mode: if terminal { "terminal" } else { "detached" }.into(), argv, source: var.into(), label: label_for(&first) });
    }
    Ok(EditorLaunch { mode: "detached".into(), argv: vec!["xdg-open".into(), path.to_string()], source: "xdg-open".into(), label: label_for("xdg-open") })
}

/// Start a GUI program in its own session with no stdio, so it outlives Colony.
fn spawn_detached(argv: &[String], cwd: &Path) -> Result<(), String> {
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe and touches no Rust state in the child.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    let mut child = cmd.spawn().map_err(|e| format!("{} failed to start: {e}", argv[0]))?;
    // Reap it when it exits (xdg-open returns at once; an editor may stay open).
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Open `path` (a file or folder inside the workspace) in the user's editor.
#[tauri::command]
pub fn open_in_editor(state: State<'_, AppState>, path: String) -> Result<EditorLaunch, String> {
    let target = workspace::jail(&state, &path)?;
    if !target.exists() {
        return Err(format!("Not found: {}", target.display()));
    }
    let cfg = settings::current(&state).map(|s| s.editor).unwrap_or_default();
    let launch = plan(&cfg, |k| std::env::var(k).ok(), &target.display().to_string())?;
    if launch.mode == "detached" {
        let root = workspace::workspace_root(&state)?;
        spawn_detached(&launch.argv, &root)?;
    }
    Ok(launch)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(cmd: Option<serde_json::Value>, terminal: Option<bool>) -> settings::EditorSettings {
        settings::EditorSettings { command: cmd, terminal }
    }

    #[test]
    fn env_editor_runs_in_a_terminal_via_sh() {
        let env = |k: &str| (k == "EDITOR").then(|| "omarchy-launch-editor --inline".to_string());
        let p = plan(&cfg(None, None), env, "/w/a b.md").unwrap();
        assert_eq!(p.mode, "terminal");
        assert_eq!(p.source, "EDITOR");
        assert_eq!(p.argv, vec!["/bin/sh", "-c", "omarchy-launch-editor --inline \"$@\"", "omarchy-launch-editor", "/w/a b.md"]);
    }

    #[test]
    fn visual_wins_over_editor() {
        let env = |k: &str| Some(if k == "VISUAL" { "code --wait" } else { "nvim" }.to_string());
        assert_eq!(plan(&cfg(None, None), env, "/w/x").unwrap().source, "VISUAL");
    }

    #[test]
    fn falls_back_to_xdg_open_detached() {
        let p = plan(&cfg(None, None), |_| None, "/w").unwrap();
        assert_eq!((p.mode.as_str(), p.argv[0].as_str()), ("detached", "xdg-open"));
    }

    #[test]
    fn settings_command_array_with_placeholder() {
        let c = cfg(Some(serde_json::json!(["zed", "--add", "{path}"])), None);
        let p = plan(&c, |_| Some("nvim".into()), "/w/f.rs").unwrap();
        assert_eq!(p.mode, "detached");
        assert_eq!(p.argv, vec!["zed", "--add", "/w/f.rs"]);
    }

    #[test]
    fn settings_tui_string_goes_to_terminal() {
        let p = plan(&cfg(Some(serde_json::json!("/usr/bin/nvim -p")), None), |_| None, "/w/f").unwrap();
        assert_eq!(p.mode, "terminal");
        assert_eq!(p.argv, vec!["/usr/bin/nvim", "-p", "/w/f"]);
    }

    #[test]
    fn terminal_override_applies_to_env_editor() {
        let p = plan(&cfg(None, Some(false)), |k| (k == "EDITOR").then(|| "gedit".into()), "/w/f").unwrap();
        assert_eq!(p.mode, "detached");
    }

    #[test]
    fn rejects_bad_command_shape() {
        assert!(plan(&cfg(Some(serde_json::json!(3)), None), |_| None, "/w").is_err());
        assert!(plan(&cfg(Some(serde_json::json!("  ")), None), |_| None, "/w").is_err());
    }
}
