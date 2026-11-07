//! File → New window (Ctrl+Shift+N, the Commands palette) and the welcome screen's "New
//! window" on a recent folder: start another Colony process with `--new-instance`, so it
//! skips the single-instance socket (instance.rs) and opens a window of its own.
//!
//! The first window keeps its folder and its socket: the desktop entry, `colony` and
//! `colony <folder>` still reach it. The new process gets the folder when one is given;
//! without one it opens on the welcome screen (`StartupInfo::new_instance`), not on the last
//! folder. It runs the same binary (`$APPIMAGE` for an AppImage, whose mounted
//! `current_exe()` goes away with the first process), with the same `COLONY_ENGINE`, in its
//! own session, so closing the first window leaves it running.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::AppState;

/// The flag that skips the single-instance socket (instance.rs `socket_path`).
pub const NEW_INSTANCE: &str = "--new-instance";

/// Variables a new window never inherits: a smoke run's log and pauses belong to its window.
const NOT_INHERITED: &[&str] = &["COLONY_SMOKE", "COLONY_SMOKE_SHOTS"];

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NewWindow {
    /// The program and its arguments.
    pub argv: Vec<String>,
    /// `COLONY_ENGINE` as the new window gets it (the engine this window runs on).
    pub engine: Option<String>,
    /// False on a smoke run: the plan only, nothing started.
    pub spawned: bool,
}

/// What to start (pure, so it is unit-tested): the binary, `--new-instance`, then the folder.
fn plan(exe: &Path, appimage: Option<&Path>, folder: Option<&Path>, engine: Option<&str>) -> NewWindow {
    let program = appimage.filter(|p| p.is_absolute()).unwrap_or(exe);
    let mut argv = vec![program.display().to_string(), NEW_INSTANCE.to_string()];
    if let Some(f) = folder {
        argv.push(f.display().to_string());
    }
    NewWindow { argv, engine: engine.filter(|e| !e.is_empty()).map(str::to_string), spawned: false }
}

/// An existing directory, absolute and resolved, or a plain reason.
fn folder_of(folder: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(folder).canonicalize().map_err(|e| format!("{folder}: {e}"))?;
    if !p.is_dir() {
        return Err(format!("Not a folder: {}", p.display()));
    }
    Ok(p)
}

/// Open a new Colony window, on `folder` or on the welcome screen. A smoke run gets the plan
/// and starts nothing.
#[tauri::command]
pub fn spawn_new_window(state: State<'_, AppState>, folder: Option<String>) -> Result<NewWindow, String> {
    let folder = folder.filter(|f| !f.trim().is_empty()).map(|f| folder_of(&f)).transpose()?;
    let exe = std::env::current_exe().map_err(|e| format!("Colony's own path: {e}"))?;
    let appimage = std::env::var_os("APPIMAGE").map(PathBuf::from);
    let engine = std::env::var("COLONY_ENGINE").ok();
    let mut out = plan(&exe, appimage.as_deref(), folder.as_deref(), engine.as_deref());
    if state.startup.lock().ok().and_then(|s| s.smoke.clone()).is_some() {
        return Ok(out);
    }
    let cwd = folder.clone().or_else(|| std::env::current_dir().ok()).unwrap_or_else(|| PathBuf::from("/"));
    let mut env: Vec<(String, Option<String>)> = NOT_INHERITED.iter().map(|k| (k.to_string(), None)).collect();
    env.push(("COLONY_ENGINE".into(), out.engine.clone()));
    crate::launch::spawn_detached_env(&out.argv, &cwd, &env)?;
    out.spawned = true;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = "/opt/colony/colony";

    #[test]
    fn a_folder_rides_after_the_flag() {
        let p = plan(Path::new(EXE), None, Some(Path::new("/w/b")), None);
        assert_eq!(p.argv, vec![EXE, "--new-instance", "/w/b"]);
        assert!(!p.spawned);
    }

    #[test]
    fn no_folder_is_the_flag_alone() {
        // The new window opens on the welcome screen (lib.rs StartupInfo::new_instance).
        assert_eq!(plan(Path::new(EXE), None, None, None).argv, vec![EXE, "--new-instance"]);
    }

    #[test]
    fn the_engine_passes_through_and_an_empty_one_is_none() {
        assert_eq!(plan(Path::new(EXE), None, None, Some("/home/u/agent-kit-dev")).engine.as_deref(), Some("/home/u/agent-kit-dev"));
        assert_eq!(plan(Path::new(EXE), None, None, Some("")).engine, None);
        assert_eq!(plan(Path::new(EXE), None, None, None).engine, None);
    }

    #[test]
    fn an_appimage_restarts_the_image_not_its_mount() {
        let p = plan(Path::new("/tmp/.mount_ColonyX/usr/bin/colony"), Some(Path::new("/home/u/Colony.AppImage")), None, None);
        assert_eq!(p.argv[0], "/home/u/Colony.AppImage");
        // A relative `$APPIMAGE` is not trusted: the running binary is.
        assert_eq!(plan(Path::new(EXE), Some(Path::new("Colony.AppImage")), None, None).argv[0], EXE);
    }

    #[cfg(unix)]
    #[test]
    fn the_flag_is_the_one_single_instance_skips() {
        assert!(crate::instance::skips_socket(["--new-instance".to_string()]));
        assert!(crate::instance::skips_socket(plan(Path::new(EXE), None, Some(Path::new("/w")), None).argv.into_iter().skip(1)));
        assert!(!crate::instance::skips_socket(["/w".to_string()]));
    }

    #[test]
    fn only_existing_folders() {
        let dir = std::env::temp_dir().join(format!("colony-newwindow-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("f.txt");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(folder_of(dir.to_str().unwrap()).unwrap(), dir.canonicalize().unwrap());
        assert!(folder_of(file.to_str().unwrap()).unwrap_err().starts_with("Not a folder"));
        assert!(folder_of(dir.join("missing").to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
