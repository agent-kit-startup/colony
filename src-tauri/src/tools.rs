//! Locating the host binaries Colony drives (node, agent-kit, git, the user's shell).
//!
//! A desktop launcher (Hyprland, a .desktop file) often starts the app without the
//! interactive shell's PATH, so mise / cargo / ~/.local/bin entries are missing. Colony
//! extends PATH once at startup with the well-known user-local tool directories so every
//! child process (dashboard server, run-plan driver, git) resolves the same tools the
//! operator's terminal does.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Newest `~/.local/share/mise/installs/node/<version>/bin` directory, if any.
fn mise_node_bin_dirs() -> Vec<PathBuf> {
    let Some(home) = home() else { return vec![] };
    let root = home.join(".local/share/mise/installs/node");
    let Ok(entries) = std::fs::read_dir(&root) else { return vec![] };
    let mut dirs: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let bin = e.path().join("bin");
            if !bin.join("node").exists() {
                return None;
            }
            let modified = e.metadata().and_then(|m| m.modified()).ok()?;
            Some((modified, bin))
        })
        .collect();
    dirs.sort_by(|a, b| b.0.cmp(&a.0));
    dirs.into_iter().map(|(_, p)| p).collect()
}

/// Extra directories appended to PATH when they exist and are not already present.
fn extra_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = home() {
        out.push(home.join(".local/share/mise/shims"));
        out.push(home.join(".local/bin"));
        out.push(home.join(".cargo/bin"));
    }
    out.extend(mise_node_bin_dirs().into_iter().take(1));
    out.push(PathBuf::from("/usr/local/bin"));
    out.push(PathBuf::from("/usr/bin"));
    out
}

/// Extend the process PATH with user-local tool directories. Call before any thread starts.
/// Returns the directories that were added.
pub fn extend_process_path() -> Vec<PathBuf> {
    let current: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    let mut added = Vec::new();
    let mut all = current.clone();
    for dir in extra_dirs() {
        if dir.is_dir() && !all.contains(&dir) {
            all.push(dir.clone());
            added.push(dir);
        }
    }
    if !added.is_empty() {
        if let Ok(joined) = std::env::join_paths(&all) {
            // SAFETY (edition 2021: safe fn): called from main before threads are spawned.
            std::env::set_var("PATH", joined);
        }
    }
    added
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata()
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Resolve `name` on PATH, honoring an explicit override env var.
pub fn find_bin(name: &str, override_env: Option<&str>) -> Option<PathBuf> {
    if let Some(var) = override_env {
        if let Some(v) = std::env::var_os(var) {
            let p = PathBuf::from(v);
            if is_executable(&p) {
                return Some(p);
            }
        }
    }
    let path: OsString = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(name))
        .find(|p| is_executable(p))
}

pub fn agent_kit_bin() -> Option<PathBuf> {
    find_bin("agent-kit", Some("COLONY_AGENT_KIT_BIN"))
}

pub fn node_bin() -> Option<PathBuf> {
    find_bin("node", Some("COLONY_NODE_BIN"))
}

pub fn git_bin() -> Option<PathBuf> {
    find_bin("git", Some("COLONY_GIT_BIN"))
}

pub fn user_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "/bin/bash".into())
}

/// Make a spawned helper (dashboard server, run-plan driver) receive SIGTERM when Colony
/// dies, even on a crash or `kill`, so no loopback server is left behind.
pub fn die_with_parent(cmd: &mut std::process::Command) {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: prctl is async-signal-safe and touches no Rust state in the child.
        unsafe {
            cmd.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                Ok(())
            });
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = cmd;
}
