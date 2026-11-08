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

// ---- Commit graph (plan colony-explorer-git-workbench x6) ------------------------------
// Read-only: `git log`, `git show` and `git diff-tree` on the workspace repository. No
// rebase, cherry-pick, reset or checkout command exists here (git-cicd ADR amend
// 2026-11-07: the graph is read-only). Commit text is untrusted: the frontend renders it as
// text nodes only.

const MAX_GRAPH_PAGE: usize = 500;

/// One decoration on a commit. `kind`: `branch` (refs/heads), `remote` (refs/remotes),
/// `tag` (refs/tags) or `other`. `head` is true on the branch HEAD points at.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphRef {
    name: String,
    kind: &'static str,
    head: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    hash: String,
    parents: Vec<String>,
    refs: Vec<GraphRef>,
    author: String,
    /// Author date, strict ISO 8601.
    date: String,
    subject: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPage {
    is_repo: bool,
    /// The commit HEAD points at (also when detached), or null on an unborn branch.
    head: Option<String>,
    /// HEAD's branch, or null when detached.
    branch: Option<String>,
    /// The current branch's upstream as a short remote ref (`origin/main`), if any.
    upstream: Option<String>,
    commits: Vec<GraphCommit>,
    /// Another page exists after this one.
    more: bool,
}

/// Parse a `%D` list printed with `--decorate=full`. `refs/remotes/<remote>/HEAD` (a
/// symbolic pointer, not a position) is dropped; a detached `HEAD` alone adds no label.
pub fn parse_decorations(d: &str) -> Vec<GraphRef> {
    let mut out = Vec::new();
    for part in d.split(", ").map(str::trim).filter(|p| !p.is_empty()) {
        let (head, full) = match part.strip_prefix("HEAD -> ") {
            Some(r) => (true, r),
            None if part == "HEAD" => continue,
            None => (false, part.strip_prefix("tag: ").unwrap_or(part)),
        };
        let (kind, name) = if let Some(n) = full.strip_prefix("refs/heads/") {
            ("branch", n)
        } else if let Some(n) = full.strip_prefix("refs/remotes/") {
            if n.ends_with("/HEAD") {
                continue;
            }
            ("remote", n)
        } else if let Some(n) = full.strip_prefix("refs/tags/") {
            ("tag", n)
        } else {
            ("other", full)
        };
        out.push(GraphRef { name: name.to_string(), kind, head });
    }
    out
}

/// Parse `git log -z --format=%H%x1f%P%x1f%D%x1f%an%x1f%aI%x1f%s`. The subject is the last
/// field, so a stray unit separator in it cannot shift the others.
pub fn parse_graph_log(raw: &str) -> Vec<GraphCommit> {
    raw.split('\0')
        .map(|r| r.trim_start_matches('\n'))
        .filter(|r| !r.is_empty())
        .filter_map(|r| {
            let f: Vec<&str> = r.splitn(6, '\x1f').collect();
            if f.len() < 6 || !is_hash(f[0]) {
                return None;
            }
            Some(GraphCommit {
                hash: f[0].to_string(),
                parents: f[1].split(' ').filter(|p| !p.is_empty()).map(str::to_string).collect(),
                refs: parse_decorations(f[2]),
                author: f[3].to_string(),
                date: f[4].to_string(),
                subject: f[5].trim_end_matches('\n').to_string(),
            })
        })
        .collect()
}

/// A full or abbreviated object name, lowercase hex: never an option or a revision
/// expression (`-`, `..`, `^`, `@{}`), checked before it reaches git.
pub fn is_hash(s: &str) -> bool {
    (7..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn repo_top(root: &Path) -> Option<std::path::PathBuf> {
    git_stdout(root, &["rev-parse", "--show-toplevel"]).ok().map(|t| Path::new(t.trim()).to_path_buf())
}

/// One page of the commit graph: local branches, remote-tracking branches, tags and HEAD,
/// newest first in date order (children always before parents), `limit` commits after
/// `skip`. One `git log` call per page.
pub fn graph_page(root: &Path, skip: usize, limit: usize) -> Result<GraphPage, String> {
    let Some(top) = repo_top(root) else {
        return Ok(GraphPage { is_repo: false, head: None, branch: None, upstream: None, commits: vec![], more: false });
    };
    let head = git_stdout(&top, &["rev-parse", "--verify", "--quiet", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| is_hash(s));
    let branch = git_stdout(&top, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let upstream = git_stdout(&top, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let limit = limit.clamp(1, MAX_GRAPH_PAGE);
    let skip_arg = format!("--skip={skip}");
    let n_arg = format!("--max-count={}", limit + 1);
    let mut args = vec!["log", "--branches", "--tags", "--remotes", "--date-order", "--decorate=full", "-z", "--format=%H%x1f%P%x1f%D%x1f%an%x1f%aI%x1f%s", &skip_arg, &n_arg];
    // An unborn HEAD (fresh repository) is not a revision: leave it out instead of failing.
    if head.is_some() {
        args.push("HEAD");
    }
    args.push("--");
    let raw = match git_stdout(&top, &args) {
        Ok(r) => r,
        // No commit at all yet: an empty graph, not an error.
        Err(_) if head.is_none() => String::new(),
        Err(e) => return Err(e),
    };
    let mut commits = parse_graph_log(&raw);
    let more = commits.len() > limit;
    commits.truncate(limit);
    Ok(GraphPage { is_repo: true, head, branch, upstream, commits, more })
}

#[tauri::command(async)]
pub fn git_graph(state: State<'_, AppState>, skip: usize, limit: usize) -> Result<GraphPage, String> {
    let root = workspace::workspace_root(&state)?;
    graph_page(&root, skip, limit)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    /// `A`, `M`, `D`, `R`, `C`, `T` (the letter git prints, score dropped).
    status: String,
    path: String,
    old_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    hash: String,
    parents: Vec<String>,
    author: String,
    email: String,
    date: String,
    /// Full message (subject and body).
    message: String,
    /// Changed files against the first parent (a root commit: against the empty tree).
    files: Vec<CommitFile>,
}

/// Parse `git diff-tree -r -M --name-status -z`: a status field, then one path (two for a
/// rename or copy). A leading commit id line (single-argument form) is skipped.
pub fn parse_name_status(raw: &str) -> Vec<CommitFile> {
    let mut out = Vec::new();
    let mut f = raw.split('\0').filter(|x| !x.is_empty());
    while let Some(st) = f.next() {
        let st = st.trim_start_matches('\n');
        let letter = st.chars().next().unwrap_or(' ');
        if !"AMDRCTUX".contains(letter) || st.len() > 4 {
            continue;
        }
        if letter == 'R' || letter == 'C' {
            let (Some(old), Some(new)) = (f.next(), f.next()) else { break };
            out.push(CommitFile { status: letter.to_string(), path: new.to_string(), old_path: Some(old.to_string()) });
        } else if let Some(p) = f.next() {
            out.push(CommitFile { status: letter.to_string(), path: p.to_string(), old_path: None });
        }
    }
    out
}

pub fn commit_detail(root: &Path, hash: &str) -> Result<CommitDetail, String> {
    if !is_hash(hash) {
        return Err("Not a commit id".into());
    }
    let top = repo_top(root).ok_or("Not a git repository")?;
    let raw = git_stdout(&top, &["show", "--no-patch", "-z", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%B", hash, "--"])?;
    let f: Vec<&str> = raw.trim_end_matches('\0').splitn(6, '\x1f').collect();
    if f.len() < 6 {
        return Err(format!("Unexpected git show output for {hash}"));
    }
    let full = f[0].to_string();
    let parents: Vec<String> = f[1].split(' ').filter(|p| !p.is_empty()).map(str::to_string).collect();
    let names = match parents.first() {
        Some(p) => git_stdout(&top, &["diff-tree", "-r", "-M", "--name-status", "-z", p, &full, "--"])?,
        None => git_stdout(&top, &["diff-tree", "-r", "--root", "--name-status", "-z", &full, "--"])?,
    };
    Ok(CommitDetail {
        hash: full,
        parents,
        author: f[2].to_string(),
        email: f[3].to_string(),
        date: f[4].to_string(),
        message: f[5].trim_end().to_string(),
        files: parse_name_status(&names),
    })
}

#[tauri::command(async)]
pub fn git_commit_detail(state: State<'_, AppState>, hash: String) -> Result<CommitDetail, String> {
    let root = workspace::workspace_root(&state)?;
    commit_detail(&root, &hash)
}

/// One file's diff in a commit, against the first parent (a root commit: as added). The
/// path is a literal pathspec (no `:(magic)`), relative to the repository top level.
pub fn commit_file_diff(root: &Path, hash: &str, path: &str) -> Result<String, String> {
    if !is_hash(hash) {
        return Err("Not a commit id".into());
    }
    let top = repo_top(root).ok_or("Not a git repository")?;
    let parent = git_stdout(&top, &["rev-parse", "--verify", "--quiet", &format!("{hash}^1")]).ok().map(|s| s.trim().to_string()).filter(|s| is_hash(s));
    let mut out = match parent {
        Some(p) => git_stdout(&top, &["--literal-pathspecs", "diff", "-M", &p, hash, "--", path])?,
        None => git_stdout(&top, &["--literal-pathspecs", "show", "--format=", hash, "--", path])?,
    };
    if out.len() > MAX_DIFF_BYTES {
        let mut cut = MAX_DIFF_BYTES;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        out.push_str("\n... (diff truncated)\n");
    }
    Ok(out)
}

#[tauri::command(async)]
pub fn git_commit_diff(state: State<'_, AppState>, hash: String, path: String) -> Result<String, String> {
    let root = workspace::workspace_root(&state)?;
    commit_file_diff(&root, &hash, &path)
}

#[cfg(test)]
mod graph_tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn decorations_split_by_kind_and_head() {
        let refs = parse_decorations("HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1.0, refs/stash");
        assert_eq!(
            refs,
            vec![
                GraphRef { name: "main".into(), kind: "branch", head: true },
                GraphRef { name: "origin/main".into(), kind: "remote", head: false },
                GraphRef { name: "v1.0".into(), kind: "tag", head: false },
                GraphRef { name: "refs/stash".into(), kind: "other", head: false },
            ]
        );
        assert!(parse_decorations("HEAD").is_empty(), "a detached HEAD alone has no label");
        assert!(parse_decorations("").is_empty());
    }

    #[test]
    fn log_records_parse_with_the_subject_last() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let c = "c".repeat(40);
        let raw = format!(
            "{a}\x1f{b} {c}\x1fHEAD -> refs/heads/main\x1fAna\x1f2026-11-08T10:00:00+00:00\x1fMerge x \x1f odd\0\n{b}\x1f\x1f\x1fBo\x1f2026-11-07T10:00:00+00:00\x1froot\0not-a-record\0"
        );
        let got = parse_graph_log(&raw);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].parents, vec![b.clone(), c]);
        assert_eq!(got[0].subject, "Merge x \x1f odd");
        assert_eq!(got[0].refs[0].name, "main");
        assert!(got[1].parents.is_empty());
        assert_eq!(got[1].subject, "root");
    }

    #[test]
    fn hashes_refuse_options_and_revision_expressions() {
        assert!(is_hash("abc1234"));
        assert!(is_hash(&"f".repeat(40)));
        for bad in ["abc12", "-abc1234", "--output=x", "HEAD", "abc1234^1", "abc1234..def5678", "ABC1234", "abc1234 ", "@{u}"] {
            assert!(!is_hash(bad), "{bad}");
        }
    }

    #[test]
    fn name_status_reads_renames_and_plain_records() {
        let raw = "M\0src/a.ts\0R087\0old name.md\0new name.md\0A\0b.rs\0D\0gone.txt\0";
        let got = parse_name_status(raw);
        assert_eq!(got.len(), 4);
        assert_eq!(got[1], CommitFile { status: "R".into(), path: "new name.md".into(), old_path: Some("old name.md".into()) });
        assert_eq!(got[3].status, "D");
    }

    fn scratch(name: &str) -> (std::path::PathBuf, impl Fn(&[&str]) -> String) {
        let dir = std::env::temp_dir().join(format!("colony-graph-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.clone();
        let git = move |args: &[&str]| {
            let ok = Command::new("git")
                .arg("-C")
                .arg(&d)
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
        (dir, git)
    }

    #[test]
    fn a_real_repository_with_a_merge_and_a_tag_pages_and_shows() {
        let (dir, git) = scratch("merge");
        git(&["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("a.txt"), "1\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "base"]);
        git(&["tag", "v0.1"]);
        git(&["checkout", "-q", "-b", "side"]);
        std::fs::write(dir.join("b.txt"), "side\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "side work"]);
        git(&["checkout", "-q", "main"]);
        std::fs::write(dir.join("a.txt"), "2\n").unwrap();
        git(&["commit", "-q", "-am", "main work"]);
        git(&["merge", "-q", "--no-ff", "side", "-m", "Merge side"]);

        let page = graph_page(&dir, 0, 500).unwrap();
        assert!(page.is_repo);
        assert_eq!(page.branch.as_deref(), Some("main"));
        assert_eq!(page.upstream, None);
        assert!(!page.more);
        let subjects: Vec<&str> = page.commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects.len(), 4);
        assert_eq!(subjects[0], "Merge side");
        assert_eq!(subjects[3], "base");
        let merge = &page.commits[0];
        assert_eq!(merge.parents.len(), 2);
        assert_eq!(page.head.as_deref(), Some(merge.hash.as_str()));
        assert!(merge.refs.iter().any(|r| r.name == "main" && r.head && r.kind == "branch"));
        assert!(page.commits[3].refs.iter().any(|r| r.name == "v0.1" && r.kind == "tag"));
        // Children always come before their parents (date order keeps topology).
        for (i, c) in page.commits.iter().enumerate() {
            for p in &c.parents {
                let at = page.commits.iter().position(|x| &x.hash == p).unwrap();
                assert!(at > i, "{} before its parent", c.subject);
            }
        }

        let first = graph_page(&dir, 0, 3).unwrap();
        assert_eq!(first.commits.len(), 3);
        assert!(first.more);
        let rest = graph_page(&dir, 3, 3).unwrap();
        assert_eq!(rest.commits.len(), 1);
        assert!(!rest.more);
        assert_eq!(rest.commits[0].subject, "base");

        let detail = commit_detail(&dir, &merge.hash).unwrap();
        assert_eq!(detail.message, "Merge side");
        assert_eq!(detail.parents.len(), 2);
        assert_eq!(detail.files, vec![CommitFile { status: "A".into(), path: "b.txt".into(), old_path: None }], "a merge lists what it brought in against its first parent");
        let root = &page.commits[3].hash;
        let rd = commit_detail(&dir, root).unwrap();
        assert_eq!(rd.files[0].path, "a.txt");
        let diff = commit_file_diff(&dir, root, "a.txt").unwrap();
        assert!(diff.contains("+1"), "{diff}");
        let diff = commit_file_diff(&dir, &merge.hash, "b.txt").unwrap();
        assert!(diff.contains("+side"), "{diff}");
        assert!(commit_detail(&dir, "--output=/tmp/x").is_err());
        assert!(commit_file_diff(&dir, "HEAD", "a.txt").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_repository_and_a_plain_folder_are_not_errors() {
        let (dir, git) = scratch("empty");
        let plain = graph_page(&dir, 0, 50).unwrap();
        assert!(!plain.is_repo);
        git(&["init", "-q", "-b", "main"]);
        let fresh = graph_page(&dir, 0, 50).unwrap();
        assert!(fresh.is_repo);
        assert!(fresh.commits.is_empty());
        assert_eq!(fresh.head, None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
