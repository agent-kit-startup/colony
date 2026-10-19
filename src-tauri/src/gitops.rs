//! Git panel: status, diff, commit, push with the system git. Hooks always run (no
//! `--no-verify`), pushes are never forced, and pushing a production branch needs the
//! operator to type `yes`.

use std::path::Path;
use std::process::Command;

use serde::Serialize;
use tauri::State;

use crate::{tools, workspace, AppState};

/// Branches whose push counts as a production promotion.
const PROD_BRANCHES: &[&str] = &["main", "master", "prod", "production", "release"];
const MAX_DIFF_BYTES: usize = 400 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    xy: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    is_repo: bool,
    branch: String,
    header: String,
    prod_branch: bool,
    files: Vec<FileStatus>,
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let bin = tools::git_bin().ok_or("git not found on PATH")?;
    let out = Command::new(bin)
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| format!("git failed to start: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if out.status.success() {
        Ok(format!("{stdout}{stderr}"))
    } else {
        Err(format!("git {} failed ({}):\n{stdout}{stderr}", args.join(" "), out.status))
    }
}

fn current_branch(root: &Path) -> Result<String, String> {
    Ok(git(root, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string())
}

#[tauri::command]
pub fn git_status(state: State<'_, AppState>) -> Result<GitStatus, String> {
    let root = workspace::workspace_root(&state)?;
    if !root.join(".git").exists() {
        return Ok(GitStatus { is_repo: false, branch: String::new(), header: String::new(), prod_branch: false, files: vec![] });
    }
    let raw = git(&root, &["status", "--porcelain=v1", "--branch", "--untracked-files=all"])?;
    let mut header = String::new();
    let mut files = Vec::new();
    for line in raw.lines() {
        if let Some(h) = line.strip_prefix("## ") {
            header = h.to_string();
        } else if line.len() > 3 {
            files.push(FileStatus { xy: line[..2].to_string(), path: line[3..].to_string() });
        }
    }
    let branch = current_branch(&root).unwrap_or_default();
    Ok(GitStatus { is_repo: true, prod_branch: PROD_BRANCHES.contains(&branch.as_str()), branch, header, files })
}

#[tauri::command]
pub fn git_diff(state: State<'_, AppState>, path: Option<String>) -> Result<String, String> {
    let root = workspace::workspace_root(&state)?;
    let mut args = vec!["diff", "HEAD", "--"];
    let jailed;
    if let Some(p) = path {
        jailed = workspace::jail(&state, &p)?.display().to_string();
        args.push(&jailed);
    }
    let mut out = git(&root, &args).or_else(|_| git(&root, &["diff", "--cached"]))?;
    if out.len() > MAX_DIFF_BYTES {
        out.truncate(MAX_DIFF_BYTES);
        out.push_str("\n... (diff truncated)\n");
    }
    Ok(out)
}

#[tauri::command]
pub fn git_commit(state: State<'_, AppState>, message: String, stage_all: bool) -> Result<String, String> {
    let root = workspace::workspace_root(&state)?;
    if message.trim().is_empty() {
        return Err("Commit message is empty".into());
    }
    let mut log = String::new();
    if stage_all {
        log.push_str(&git(&root, &["add", "-A"])?);
    }
    log.push_str(&git(&root, &["commit", "-m", message.trim()])?);
    Ok(log)
}

#[tauri::command]
pub fn git_push(state: State<'_, AppState>, typed_confirm: Option<String>) -> Result<String, String> {
    let root = workspace::workspace_root(&state)?;
    let branch = current_branch(&root)?;
    if branch == "HEAD" {
        return Err("Detached HEAD: check out a branch before pushing".into());
    }
    if PROD_BRANCHES.contains(&branch.as_str()) && typed_confirm.as_deref().map(str::trim) != Some("yes") {
        return Err(format!("Pushing {branch} is a production promotion: type yes to confirm"));
    }
    let has_upstream = git(&root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).is_ok();
    if has_upstream {
        git(&root, &["push"])
    } else {
        git(&root, &["push", "-u", "origin", &branch])
    }
}
