//! Resolve on a conflicting PR (plan colony-git-tab-forge-ux r3; git-cicd ADR amend 2026-11-08
//! point 4, operator answer `forge-ux-resolve-before-x7`): a worktree of the PR branch beside
//! the operator's checkout, with the base merged in, where a terminal tab then lists the
//! conflicts and runs `agent-kit conflicts propose` per file.
//!
//! This is an operator click, not a host request kind: nothing is pushed, nothing is merged on
//! the forge, and the operator's own checkout is never switched. The merge stays in the
//! worktree until the operator pushes it (terminal, or the `push-branch` kind). A same-repo PR
//! gets its own branch name, so a push goes back to the PR; a fork PR is checked out detached
//! (Colony never pushes to another repository).

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::forge::{Forge, Op};
use crate::hostreq::valid_branch;
use crate::{gitops, workspace, AppState};

/// Never through an `ext::` transport the repository's config might name (hostreq.rs, same rule).
const NO_EXT: [&str; 2] = ["-c", "protocol.ext.allow=never"];

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrWorktree {
    pub number: u64,
    pub path: String,
    /// The local branch checked out there (None: a fork PR, detached).
    pub branch: Option<String>,
    pub base: String,
    /// The worktree was there already (Resolve clicked again).
    pub reused: bool,
    /// Files git left unmerged.
    pub conflicted: Vec<String>,
    /// `agent-kit` as Colony runs it (program, then its arguments); empty when no engine.
    pub kit: Vec<String>,
    pub note: String,
}

/// `git worktree list --porcelain` as (path, branch ref) pairs.
fn worktrees(root: &Path) -> Result<Vec<(PathBuf, Option<String>)>, String> {
    let out = gitops::git(root, &["worktree", "list", "--porcelain"])?;
    let mut list = Vec::new();
    for block in out.split("\n\n") {
        let mut path = None;
        let mut branch = None;
        for l in block.lines() {
            if let Some(p) = l.strip_prefix("worktree ") {
                path = Some(PathBuf::from(p));
            } else if let Some(b) = l.strip_prefix("branch ") {
                branch = Some(b.to_string());
            }
        }
        if let Some(p) = path {
            list.push((p, branch));
        }
    }
    Ok(list)
}

/// Prepare (or reuse) the worktree for PR `pr` (one `gh pr view` answer) of the repository at
/// `root`, fetching from its `origin`.
pub fn pr_worktree(root: &Path, pr: &Value) -> Result<PrWorktree, String> {
    let n = pr.get("number").and_then(Value::as_u64).filter(|n| *n > 0).ok_or("gh pr view has no PR number")?;
    let head = pr.get("headRefName").and_then(Value::as_str).unwrap_or_default();
    let base = pr.get("baseRefName").and_then(Value::as_str).unwrap_or_default();
    if !valid_branch(head) || !valid_branch(base) {
        return Err(format!("PR #{n}: unexpected branch names ({base:?} <- {head:?})"));
    }
    // A missing field counts as a fork: Colony then never names a branch after its head.
    let fork = pr.get("isCrossRepository").and_then(Value::as_bool) != Some(false);
    let top = PathBuf::from(gitops::git(root, &["rev-parse", "--show-toplevel"])?.trim()).canonicalize().map_err(|e| e.to_string())?;
    // The base merge below is a commit: without a committer identity git refuses it. Checked
    // before anything is fetched or created, so a refusal leaves no half-made worktree; Colony
    // never invents an identity for the operator.
    if gitops::git(&top, &["var", "GIT_COMMITTER_IDENT"]).is_err() {
        return Err(format!(
            "Git has no committer identity (user.name and user.email) for {}, and Resolve merges origin/{base} into the PR branch. Set it with git config --global user.name \"Your Name\" and git config --global user.email you@example.com (drop --global for this repository only), then Resolve again",
            top.display()
        ));
    }
    let name = top.file_name().map(|s| s.to_string_lossy().to_string()).ok_or("The repository has no folder name")?;
    let path = top.parent().ok_or("The repository has no parent folder")?.join(format!("{name}-pr-{n}"));
    let pr_ref = format!("refs/remotes/origin/pr/{n}");
    let base_ref = format!("refs/remotes/origin/{base}");

    let mut specs = vec![format!("+refs/pull/{n}/head:{pr_ref}"), format!("+refs/heads/{base}:{base_ref}")];
    if !fork {
        specs.push(format!("+refs/heads/{head}:refs/remotes/origin/{head}"));
    }
    let mut fetch = vec![NO_EXT[0], NO_EXT[1], "fetch", "--no-tags", "origin"];
    fetch.extend(specs.iter().map(String::as_str));
    gitops::git(&top, &fetch)?;

    let mut notes: Vec<String> = Vec::new();
    let list = worktrees(&top)?;
    let canon = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let reused = path.exists();
    let branch = if reused {
        let Some((_, b)) = list.iter().find(|(p, _)| canon(p) == canon(&path)) else {
            return Err(format!("{} exists and is not a worktree of this repository: move it away, then Resolve again", path.display()));
        };
        notes.push("Reused the worktree from an earlier Resolve.".into());
        b.as_deref().and_then(|r| r.strip_prefix("refs/heads/")).map(str::to_string)
    } else if fork {
        gitops::git(&top, &["worktree", "add", "--detach", &path.display().to_string(), &pr_ref])?;
        notes.push("Fork PR: checked out detached. Colony never pushes to another repository; push only if the fork allows maintainer edits.".into());
        None
    } else {
        let local = format!("refs/heads/{head}");
        if gitops::git(&top, &["rev-parse", "--verify", "--quiet", &local]).is_ok() {
            if let Some((p, _)) = list.iter().find(|(_, b)| b.as_deref() == Some(local.as_str())) {
                return Err(format!("{head} is checked out at {}: resolve the conflicts there (git merge origin/{base})", p.display()));
            }
            if gitops::git(&top, &["merge-base", "--is-ancestor", &local, &pr_ref]).is_err() {
                return Err(format!("Your local {head} has commits the PR does not have: resolve in your own checkout, or push them first"));
            }
            gitops::git(&top, &["worktree", "add", &path.display().to_string(), head])?;
            gitops::git(&path, &["merge", "--ff-only", &pr_ref])?;
        } else {
            gitops::git(&top, &["worktree", "add", "--no-track", "-b", head, &path.display().to_string(), &pr_ref])?;
            gitops::git(&path, &["branch", &format!("--set-upstream-to=origin/{head}"), head])?;
        }
        Some(head.to_string())
    };

    // Merge the base in, unless a merge is under way there already (Resolve clicked again).
    if gitops::git(&path, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_err() {
        match gitops::git(&path, &["merge", "--no-edit", &base_ref]) {
            Ok(_) => notes.push(format!("origin/{base} merged in without conflicts: review it, then push.")),
            // Conflicts: git stops with MERGE_HEAD set, which is what Resolve is for.
            Err(_) if gitops::git(&path, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok() => {}
            Err(e) => return Err(e),
        }
    }
    let conflicted: Vec<String> = gitops::git(&path, &["diff", "--name-only", "--diff-filter=U"])?.lines().map(str::trim).filter(|l| crate::conflicts::valid_repo_path(l)).map(str::to_string).collect();
    let kit = match crate::engine::kit_command() {
        Ok(k) => std::iter::once(k.program.display().to_string()).chain(k.args.iter().map(|a| a.display().to_string())).collect(),
        Err(e) => {
            notes.push(format!("No agent-kit for proposals: {e}"));
            Vec::new()
        }
    };
    Ok(PrWorktree { number: n, path: path.display().to_string(), branch, base: base.to_string(), reused, conflicted, kit, note: notes.join(" ") })
}

#[tauri::command(async)]
pub fn forge_pr_worktree(state: State<'_, AppState>, number: u64) -> Result<PrWorktree, String> {
    let root = workspace::workspace_root(&state)?;
    let pr = Forge::detect()?.json(&root, &Op::PrView(number))?;
    pr_worktree(&root, &pr)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn g(dir: &Path, args: &[&str]) -> String {
        gitops::git(dir, args).unwrap().trim().to_string()
    }

    /// origin (bare) with main and staging; PR 5 is feat/x into staging, conflicting on a.txt.
    fn setup() -> (PathBuf, PathBuf) {
        let d = crate::hostreq::test_dir("prwt");
        let origin = d.join("origin.git");
        let work = d.join("repo");
        gitops::git(&d, &["init", "-q", "--bare", "-b", "main", &origin.display().to_string()]).unwrap();
        gitops::git(&d, &["clone", "-q", &origin.display().to_string(), &work.display().to_string()]).unwrap();
        // The identity lives in the repository config (shared with its worktrees), so the base
        // merge pr_worktree runs works on a machine with no global identity (CI runners).
        g(&work, &["config", "user.name", "t"]);
        g(&work, &["config", "user.email", "t@example.com"]);
        std::fs::write(work.join("a.txt"), "base\n").unwrap();
        g(&work, &["add", "-A"]);
        g(&work, &["commit", "-q", "-m", "base"]);
        g(&work, &["push", "-q", "origin", "HEAD:main", "HEAD:staging"]);
        g(&work, &["checkout", "-q", "-b", "feat/x"]);
        std::fs::write(work.join("a.txt"), "pr side\n").unwrap();
        g(&work, &["commit", "-q", "-am", "pr"]);
        g(&work, &["push", "-q", "origin", "feat/x", "feat/x:refs/pull/5/head"]);
        g(&work, &["checkout", "-q", "main"]);
        g(&work, &["branch", "-q", "-D", "feat/x"]);
        std::fs::write(work.join("a.txt"), "staging side\n").unwrap();
        g(&work, &["commit", "-q", "-am", "staging"]);
        g(&work, &["push", "-q", "origin", "HEAD:staging"]);
        g(&work, &["reset", "-q", "--hard", "origin/main"]);
        (d, work)
    }

    fn view(cross: bool) -> Value {
        json!({ "number": 5, "headRefName": "feat/x", "baseRefName": "staging", "isCrossRepository": cross })
    }

    #[test]
    fn a_same_repo_pr_gets_its_branch_with_the_base_merged_in() {
        let (d, work) = setup();
        let w = pr_worktree(&work, &view(false)).unwrap();
        assert_eq!(w.path, d.join("repo-pr-5").display().to_string());
        assert_eq!((w.branch.as_deref(), w.reused, w.conflicted.clone()), (Some("feat/x"), false, vec!["a.txt".to_string()]));
        let p = PathBuf::from(&w.path);
        assert!(gitops::git(&p, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok(), "the merge waits for the operator");
        assert_eq!(g(&p, &["rev-parse", "--abbrev-ref", "feat/x@{u}"]), "origin/feat/x", "a push goes back to the PR");
        assert_eq!(g(&work, &["rev-parse", "--abbrev-ref", "HEAD"]), "main", "the operator's checkout is untouched");
        // Clicked again: the same worktree, the merge still under way, nothing redone.
        let again = pr_worktree(&work, &view(false)).unwrap();
        assert_eq!((again.reused, again.conflicted, again.branch), (true, vec!["a.txt".to_string()], Some("feat/x".to_string())));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_fork_pr_is_detached_and_refusals_are_clear() {
        let (d, work) = setup();
        let w = pr_worktree(&work, &view(true)).unwrap();
        assert_eq!(w.branch, None);
        assert!(w.note.contains("Fork PR") && w.conflicted == ["a.txt"]);
        assert!(gitops::git(&work, &["rev-parse", "--verify", "--quiet", "refs/heads/feat/x"]).is_err(), "no local branch named after a fork's head");
        let _ = std::fs::remove_dir_all(&d);

        let (d, work) = setup();
        // The branch checked out in the operator's checkout: resolve there.
        g(&work, &["checkout", "-q", "-b", "feat/x", "origin/feat/x"]);
        assert!(pr_worktree(&work, &view(false)).unwrap_err().contains("checked out at"));
        // A local branch with commits the PR lacks: refused.
        g(&work, &["commit", "-q", "--allow-empty", "-m", "local only"]);
        g(&work, &["checkout", "-q", "main"]);
        assert!(pr_worktree(&work, &view(false)).unwrap_err().contains("commits the PR does not have"));
        // A folder in the way that is not a worktree.
        std::fs::create_dir_all(d.join("repo-pr-5")).unwrap();
        g(&work, &["branch", "-q", "-D", "feat/x"]);
        assert!(pr_worktree(&work, &view(false)).unwrap_err().contains("not a worktree"));
        // Hostile names never reach git.
        assert!(pr_worktree(&work, &json!({ "number": 5, "headRefName": "--upload-pack=x", "baseRefName": "staging", "isCrossRepository": false })).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn no_committer_identity_is_refused_before_any_worktree() {
        let (d, work) = setup();
        // Empty values in the repository config override any global identity, so this stands
        // for a machine with none (exported GIT_COMMITTER_NAME/EMAIL would still win over it).
        g(&work, &["config", "user.name", ""]);
        g(&work, &["config", "user.email", ""]);
        let e = pr_worktree(&work, &view(false)).unwrap_err();
        assert!(e.contains("no committer identity") && e.contains("git config --global user.name") && e.contains("user.email"), "{e}");
        assert!(!d.join("repo-pr-5").exists(), "nothing created");
        let _ = std::fs::remove_dir_all(&d);
    }
}
