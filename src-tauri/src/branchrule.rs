//! Which branches count as production, for the Git tab's push button and for host
//! requests (merge-pr into a production base, push-branch of a production branch).
//!
//! `production`, `prod` and `release` always are. The default branch (`main` or
//! `master`) is production only when the repository also has an `origin/staging` branch:
//! in a staging flow `main` is the release line, while in a repository without `staging`
//! `main` is where development lands. `origin/HEAD` is deliberately not consulted: a
//! clone made from `staging`, or a forge whose default branch is `staging`, would invert
//! the rule. Host requests use the stricter `request_production_reason`: `main` and
//! `master` always count there, because the request's folder is the requester's.

use std::path::Path;

use crate::gitops;

/// Always production, whatever the repository's flow.
pub const ALWAYS_PRODUCTION: &[&str] = &["production", "prod", "release"];
/// The default branch names, production in a staging flow.
const DEFAULT_BRANCHES: &[&str] = &["main", "master"];

/// What the rule needs to know about a repository.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RepoFlow {
    /// `refs/remotes/origin/staging` exists.
    pub has_staging: bool,
}

/// The rule itself (pure): `None` when `branch` is not production, else why it is.
pub fn production_reason(branch: &str, flow: &RepoFlow) -> Option<String> {
    let branch = branch.trim();
    if ALWAYS_PRODUCTION.contains(&branch) {
        return Some(format!("{branch} is always a production branch"));
    }
    (flow.has_staging && DEFAULT_BRANCHES.contains(&branch)).then(|| format!("{branch} is the default branch and the repository has origin/staging"))
}

/// The rule for host requests (merge-pr, push-branch filed by an agent or started from a
/// card): `main` and `master` always count, whatever the local refs say. The staging-flow
/// test reads `refs/remotes/origin/staging` in the request's own folder, which the requester
/// controls (delete the ref, or file from a single-branch clone), so it cannot decide
/// whether a typed yes is needed (security review 2026-10-24, finding 2).
pub fn request_production_reason(branch: &str) -> Option<String> {
    let branch = branch.trim();
    if ALWAYS_PRODUCTION.contains(&branch) {
        return Some(format!("{branch} is always a production branch"));
    }
    DEFAULT_BRANCHES.contains(&branch).then(|| format!("{branch} is a default branch: a host request treats it as production"))
}

/// Read the repository facts the rule needs (no network: local refs only).
pub fn repo_flow(root: &Path) -> RepoFlow {
    RepoFlow { has_staging: gitops::git(root, &["rev-parse", "--verify", "--quiet", "refs/remotes/origin/staging"]).is_ok() }
}

/// `production_reason` for a branch of the repository at `root`.
pub fn production_branch(root: &Path, branch: &str) -> Option<String> {
    production_reason(branch, &repo_flow(root))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flow(staging: bool) -> RepoFlow {
        RepoFlow { has_staging: staging }
    }

    #[test]
    fn always_production_names() {
        for b in ["production", "prod", "release"] {
            assert!(production_reason(b, &flow(false)).is_some(), "{b}");
            assert!(production_reason(b, &flow(true)).is_some(), "{b}");
        }
    }

    #[test]
    fn main_is_development_without_staging() {
        for b in ["main", "master", "staging", "feat/x"] {
            assert_eq!(production_reason(b, &flow(false)), None, "{b}");
        }
    }

    #[test]
    fn default_branch_is_production_with_staging() {
        assert!(production_reason("main", &flow(true)).is_some());
        assert!(production_reason("master", &flow(true)).is_some());
        for b in ["staging", "feat/x", "trunk"] {
            assert_eq!(production_reason(b, &flow(true)), None, "{b}");
        }
    }

    #[test]
    fn host_requests_treat_default_branches_as_production_always() {
        for b in ["main", "master", "production", "prod", "release"] {
            assert!(request_production_reason(b).is_some(), "{b}");
        }
        for b in ["staging", "feat/x", "mainline", "chore/sync-staging-main-abc1234"] {
            assert_eq!(request_production_reason(b), None, "{b}");
        }
    }

    #[test]
    fn reads_flow_from_a_repository() {
        let dir = crate::hostreq::test_dir("branchrule");
        let g = |args: &[&str]| gitops::git(&dir, args).unwrap();
        g(&["init", "-q", "-b", "main"]);
        g(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
        assert_eq!(repo_flow(&dir), flow(false));
        assert_eq!(production_branch(&dir, "main"), None);
        // A clone made from staging: origin/HEAD points there, main is still production.
        g(&["update-ref", "refs/remotes/origin/staging", "HEAD"]);
        g(&["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/staging"]);
        assert_eq!(repo_flow(&dir), flow(true));
        assert!(production_branch(&dir, "main").is_some());
        assert_eq!(production_branch(&dir, "staging"), None);
        assert_eq!(production_branch(&dir, "feat/x"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
