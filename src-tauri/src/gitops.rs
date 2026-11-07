//! Git panel: status, diff, commit, push with the system git. Hooks always run (no
//! `--no-verify`), pushes are never forced, and pushing a production branch (branchrule.rs)
//! needs the operator to type `yes`.

use std::path::Path;
use std::process::Command;

use serde::Serialize;
use tauri::State;

use crate::{branchrule, tools, workspace, AppState};

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

pub(crate) fn git(root: &Path, args: &[&str]) -> Result<String, String> {
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

#[tauri::command(async)]
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
    let prod_branch = branchrule::production_branch(&root, &branch).is_some();
    Ok(GitStatus { is_repo: true, prod_branch, branch, header, files })
}

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn git_push(state: State<'_, AppState>, typed_confirm: Option<String>) -> Result<String, String> {
    let root = workspace::workspace_root(&state)?;
    let branch = current_branch(&root)?;
    if branch == "HEAD" {
        return Err("Detached HEAD: check out a branch before pushing".into());
    }
    if let Some(why) = branchrule::production_branch(&root, &branch) {
        if typed_confirm.as_deref().map(str::trim) != Some("yes") {
            return Err(format!("Pushing {branch} is a production promotion ({why}): type yes to confirm"));
        }
    }
    let has_upstream = git(&root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).is_ok();
    if has_upstream {
        git(&root, &["push"])
    } else {
        git(&root, &["push", "-u", "origin", &branch])
    }
}

/// One Explorer git mark (plan colony-explorer-git-workbench x2): an absolute path and its
/// letter. `M` modified (or type change), `A` added, `U` untracked, `D` deleted, `R` renamed
/// or copied, `!` conflicted, `I` ignored. A path ending in `/` is a whole folder git
/// collapsed (untracked or ignored): its contents take its mark.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitMark {
    path: String,
    mark: char,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitMarks {
    is_repo: bool,
    marks: Vec<GitMark>,
}

/// Letter of an ordinary (`1`) record's XY: a deletion on either side wins, then an
/// addition in the index, then any other change.
fn ordinary_mark(xy: &str) -> char {
    let (x, y) = (xy.chars().next().unwrap_or('.'), xy.chars().nth(1).unwrap_or('.'));
    if x == 'D' || y == 'D' {
        'D'
    } else if x == 'A' {
        'A'
    } else {
        'M'
    }
}

/// Parse `git status --porcelain=v2 -z --untracked-files=normal --ignored=traditional`
/// into marks with paths relative to the repository top level (`/` separators, as git
/// prints them). Unknown records are skipped.
pub fn parse_porcelain_v2_marks(raw: &str) -> Vec<(String, char)> {
    let mut out = Vec::new();
    let mut fields = raw.split('\0');
    while let Some(f) = fields.next() {
        let rest = |n: usize| f.splitn(n + 1, ' ').nth(n).map(str::to_string);
        match f.as_bytes().first() {
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            Some(b'1') => {
                if let (Some(xy), Some(p)) = (f.split(' ').nth(1), rest(8)) {
                    out.push((p, ordinary_mark(xy)));
                }
            }
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>, then the original path
            Some(b'2') => {
                if let Some(p) = rest(9) {
                    out.push((p, 'R'));
                }
                fields.next();
            }
            // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            Some(b'u') => {
                if let Some(p) = rest(10) {
                    out.push((p, '!'));
                }
            }
            Some(b'?') => {
                if let Some(p) = rest(1) {
                    out.push((p, 'U'));
                }
            }
            Some(b'!') => {
                if let Some(p) = rest(1) {
                    out.push((p, 'I'));
                }
            }
            _ => {}
        }
    }
    out
}

/// stdout only (no stderr mixed in), for machine-read output.
fn git_stdout(root: &Path, args: &[&str]) -> Result<String, String> {
    let bin = tools::git_bin().ok_or("git not found on PATH")?;
    let out = Command::new(bin).arg("-C").arg(root).args(args).output().map_err(|e| format!("git failed to start: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(format!("git {} failed ({}): {}", args.join(" "), out.status, String::from_utf8_lossy(&out.stderr).trim()))
    }
}

/// The Explorer's git marks: one `git status` call for the whole repository (never one per
/// row). Untracked and ignored folders come back collapsed (`normal` / `traditional`), so a
/// big ignored tree (node_modules, target) is one line. Read-only.
#[tauri::command(async)]
pub fn git_marks(state: State<'_, AppState>) -> Result<GitMarks, String> {
    let root = workspace::workspace_root(&state)?;
    let Ok(top) = git_stdout(&root, &["rev-parse", "--show-toplevel"]) else {
        return Ok(GitMarks { is_repo: false, marks: vec![] });
    };
    let top = Path::new(top.trim()).to_path_buf();
    let raw = git_stdout(&root, &["status", "--porcelain=v2", "-z", "--untracked-files=normal", "--ignored=traditional"])?;
    let marks = parse_porcelain_v2_marks(&raw)
        .into_iter()
        .map(|(p, mark)| {
            let dir = p.ends_with('/');
            let mut abs = top.join(p.trim_end_matches('/')).display().to_string();
            if dir {
                abs.push('/');
            }
            GitMark { path: abs, mark }
        })
        .collect();
    Ok(GitMarks { is_repo: true, marks })
}

#[cfg(test)]
mod marks_tests {
    use super::parse_porcelain_v2_marks;

    #[test]
    fn porcelain_v2_records_map_to_marks() {
        let h = "a".repeat(40);
        let raw = [
            format!("1 .M N... 100644 100644 100644 {h} {h} src/main.ts"),
            format!("1 M. N... 100644 100644 100644 {h} {h} staged.ts"),
            format!("1 A. N... 000000 100644 100644 {h} {h} new file.ts"),
            format!("1 .D N... 100644 100644 000000 {h} {h} gone.ts"),
            format!("1 D. N... 100644 000000 000000 {h} {h} staged-gone.ts"),
            format!("1 .T N... 100644 100644 120000 {h} {h} link"),
            format!("2 R. N... 100644 100644 100644 {h} {h} R100 docs/new name.md"),
            "docs/old name.md".to_string(),
            format!("u UU N... 100644 100644 100644 100644 {h} {h} {h} conflict.rs"),
            "? notes.txt".to_string(),
            "? scratch/".to_string(),
            "! node_modules/".to_string(),
            "! .env".to_string(),
            String::new(),
        ]
        .join("\0");
        assert_eq!(
            parse_porcelain_v2_marks(&raw),
            vec![
                ("src/main.ts".to_string(), 'M'),
                ("staged.ts".to_string(), 'M'),
                ("new file.ts".to_string(), 'A'),
                ("gone.ts".to_string(), 'D'),
                ("staged-gone.ts".to_string(), 'D'),
                ("link".to_string(), 'M'),
                ("docs/new name.md".to_string(), 'R'),
                ("conflict.rs".to_string(), '!'),
                ("notes.txt".to_string(), 'U'),
                ("scratch/".to_string(), 'U'),
                ("node_modules/".to_string(), 'I'),
                (".env".to_string(), 'I'),
            ]
        );
    }

    #[test]
    fn empty_and_unknown_records_are_skipped() {
        assert!(parse_porcelain_v2_marks("").is_empty());
        assert!(parse_porcelain_v2_marks("# branch.oid abc\0").is_empty());
    }

    #[test]
    fn a_real_repository_reports_each_mark() {
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!("colony-marks-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            let ok = Command::new("git")
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
            assert!(ok.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&ok.stderr));
            String::from_utf8_lossy(&ok.stdout).to_string()
        };
        git(&["init", "-q", "-b", "main"]);
        std::fs::write(dir.join(".gitignore"), "build/\n").unwrap();
        std::fs::write(dir.join("keep.txt"), "a\n").unwrap();
        std::fs::write(dir.join("gone.txt"), "a\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "base"]);
        std::fs::write(dir.join("keep.txt"), "b\n").unwrap();
        std::fs::remove_file(dir.join("gone.txt")).unwrap();
        std::fs::write(dir.join("new.txt"), "n\n").unwrap();
        std::fs::create_dir_all(dir.join("build/deep")).unwrap();
        std::fs::write(dir.join("build/deep/out.o"), "o\n").unwrap();
        let raw = git(&["status", "--porcelain=v2", "-z", "--untracked-files=normal", "--ignored=traditional"]);
        let mut got = parse_porcelain_v2_marks(&raw);
        got.sort();
        assert_eq!(
            got,
            vec![
                ("build/".to_string(), 'I'),
                ("gone.txt".to_string(), 'D'),
                ("keep.txt".to_string(), 'M'),
                ("new.txt".to_string(), 'U'),
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
