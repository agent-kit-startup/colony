//! Conflict window (plan colony-explorer-git-workbench x7; git-cicd ADR amend 2026-11-07).
//!
//! Colony asks the kit, never a model: `agent-kit conflicts --json` lists the unmerged
//! paths parsed into hunks, and `agent-kit conflicts propose <path> --json` runs the
//! zero-tool `resolve-conflicts` session and returns checked, verified proposals. Neither
//! writes the working tree, stages or commits. The operator applies hunks in the window,
//! saves through the jailed `write_text_file`, and stages through the `stage-resolved` host
//! kind (hostreq.rs) after its Approve card. Committing, continuing and pushing stay with
//! the operator; aborting a merge is a confirmed click here.

use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::Value;
use tauri::State;

use crate::{gitops, tools, workspace, AppState};

/// Backends `propose` accepts (the kit refuses others: no read-only argv elsewhere).
pub const PROPOSE_BACKENDS: &[&str] = &["auto", "claude", "cursor-agent"];

/// A repository-relative path as git and the kit print it: never absolute, never an option,
/// no `.` / `..` segment, no control characters.
pub fn valid_repo_path(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 4096
        && !p.starts_with(['/', '-'])
        && !p.chars().any(|c| c.is_control())
        && p.split('/').all(|s| !s.is_empty() && s != "." && s != "..")
}

pub(crate) fn kit(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let kit = crate::engine::kit_command()?;
    let mut cmd = Command::new(&kit.program);
    tools::die_with_parent(&mut cmd);
    cmd.args(&kit.args)
        .args(args)
        .arg("--cwd")
        .arg(root)
        .current_dir(root)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("agent-kit {} failed to start: {e}", args.join(" ")))
}

const NO_COMMAND: &str = "This engine has no `agent-kit conflicts`: update it in Run → Engine… (the command ships after Agent Kit 6.14.0), or resolve in the editor";

/// The kit's JSON on stdout when there is one (propose prints its result with a non-zero
/// exit when hunks stay unresolved or verification fails); otherwise the error it printed.
pub fn kit_json(out: &std::process::Output) -> Result<Value, String> {
    let stdout = String::from_utf8_lossy(&out.stdout);
    if let Ok(v) = serde_json::from_str::<Value>(stdout.trim()) {
        if v.is_object() {
            return Ok(v);
        }
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    // citty prints "Unknown command conflicts" and the usage (stdout or stderr by version).
    let all = format!("{stdout}\n{err}");
    if all.contains("Unknown command") || all.contains("unknown command") {
        return Err(NO_COMMAND.into());
    }
    Err(if err.is_empty() { format!("agent-kit exited with {}", out.status) } else { err })
}

#[tauri::command(async)]
pub fn conflicts_list(state: State<'_, AppState>) -> Result<Value, String> {
    let root = workspace::workspace_root(&state)?;
    kit_json(&kit(&root, &["conflicts", "--json"])?)
}

/// `agent-kit conflicts propose <path> --json`: minutes with verification on. Nothing is
/// written; the window shows each proposal with its rationale before anything changes.
#[tauri::command(async)]
pub fn conflicts_propose(state: State<'_, AppState>, path: String, backend: Option<String>, verify: bool) -> Result<Value, String> {
    let root = workspace::workspace_root(&state)?;
    if !valid_repo_path(&path) {
        return Err(format!("Not a repository path: {path}"));
    }
    let backend = backend.unwrap_or_else(|| "auto".into());
    if !PROPOSE_BACKENDS.contains(&backend.as_str()) {
        return Err(format!("Backend must be one of {}", PROPOSE_BACKENDS.join(", ")));
    }
    // The path is checked above (never an option), so it goes in as the positional.
    let mut args = vec!["conflicts", "propose", &path, "--json", "--backend", &backend];
    if !verify {
        args.push("--no-verify");
    }
    kit_json(&kit(&root, &args)?)
}

/// `git merge --abort`, only while a merge is in progress (MERGE_HEAD). A rebase or a
/// cherry-pick is aborted by the operator in the terminal.
pub fn merge_abort(root: &Path) -> Result<String, String> {
    if gitops::git(root, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_err() {
        return Err("No merge in progress (a rebase or cherry-pick is aborted from the terminal)".into());
    }
    gitops::git(root, &["merge", "--abort"])
}

#[tauri::command(async)]
pub fn git_merge_abort(state: State<'_, AppState>) -> Result<String, String> {
    let root = workspace::workspace_root(&state)?;
    merge_abort(&root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_paths_refuse_escapes_and_options() {
        for ok in ["a.txt", "src/main.ts", "dir with space/f.rs", ".github/workflows/ci.yml"] {
            assert!(valid_repo_path(ok), "{ok}");
        }
        for bad in ["", "/etc/passwd", "-x", "--output=y", "../up", "a/../b", "a//b", "./a", "a/", "a\nb", "a\0b"] {
            assert!(!valid_repo_path(bad), "{bad:?}");
        }
    }

    fn out(code: i32, stdout: &str, stderr: &str) -> std::process::Output {
        use std::os::unix::process::ExitStatusExt;
        std::process::Output { status: std::process::ExitStatus::from_raw(code << 8), stdout: stdout.as_bytes().to_vec(), stderr: stderr.as_bytes().to_vec() }
    }

    #[test]
    fn kit_json_reads_results_even_on_a_non_zero_exit() {
        let v = kit_json(&out(1, "{\"schema\":1,\"path\":\"a.txt\",\"unresolvedHunks\":[2]}\n", "")).unwrap();
        assert_eq!(v["path"], "a.txt");
        assert_eq!(kit_json(&out(1, "", "agent-kit conflicts needs a git repository")).unwrap_err(), "agent-kit conflicts needs a git repository");
        assert_eq!(kit_json(&out(1, "", "Unknown command conflicts")).unwrap_err(), NO_COMMAND);
        assert_eq!(kit_json(&out(1, "Unknown command conflicts\nUSAGE `agent-kit <command>`", "")).unwrap_err(), NO_COMMAND, "kit 6.14 prints it on stdout");
        assert!(kit_json(&out(0, "[1,2]", "")).is_err(), "only an object is a result");
    }

    #[test]
    fn merge_abort_needs_a_merge_in_progress() {
        let dir = std::env::temp_dir().join(format!("colony-abort-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            let o = Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(args)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@example.com")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@example.com")
                .output()
                .unwrap();
            o.status.success()
        };
        assert!(git(&["init", "-q", "-b", "main"]));
        std::fs::write(dir.join("a.txt"), "base\n").unwrap();
        assert!(git(&["add", "-A"]) && git(&["commit", "-q", "-m", "base"]));
        assert!(merge_abort(&dir).is_err(), "nothing to abort");
        assert!(git(&["checkout", "-q", "-b", "side"]));
        std::fs::write(dir.join("a.txt"), "side\n").unwrap();
        assert!(git(&["commit", "-q", "-am", "side"]));
        assert!(git(&["checkout", "-q", "main"]));
        std::fs::write(dir.join("a.txt"), "main\n").unwrap();
        assert!(git(&["commit", "-q", "-am", "main"]));
        assert!(!git(&["merge", "-q", "side"]), "the merge conflicts");
        assert!(merge_abort(&dir).is_ok());
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "main\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
