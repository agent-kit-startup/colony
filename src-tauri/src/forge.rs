//! Forge adapter: pull requests, checks and CI runs through the operator's own forge CLI
//! (GitHub's `gh` for now). Colony never reads, stores or relays a token: every call runs
//! the CLI as the user, with the CLI's own login. Merges never pass `--admin` or `--auto`.
//!
//! `Provider` maps each operation to an argv, so another forge (GitLab's `glab`) is one
//! more arm per operation.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::{tools, workspace, AppState};

const MAX_OUTPUT_BYTES: usize = 400 * 1024;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    #[default]
    Squash,
    Merge,
    Rebase,
}

impl MergeMethod {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "squash" => Some(Self::Squash),
            "merge" => Some(Self::Merge),
            "rebase" => Some(Self::Rebase),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Squash => "squash",
            Self::Merge => "merge",
            Self::Rebase => "rebase",
        }
    }
}

/// One forge operation (what Colony may ask the forge CLI to do).
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    AuthStatus,
    ListPrs,
    PrView(u64),
    PrChecks(u64),
    PrDiff(u64),
    PrWeb(u64),
    /// Merge, optionally only if the head is still this commit (`--match-head-commit`).
    Merge(u64, MergeMethod, Option<String>),
    Runs { branch: Option<String> },
    RunView(u64),
    RerunFailed(u64),
    /// Open a pull request. Colony builds every field (hostreq `pr_plan`); never `--web`,
    /// `--fill` or a draft toggle from the requester.
    PrCreate { base: String, head: String, title: String, body: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    GitHub,
}

const PR_LIST_FIELDS: &str = "number,title,headRefName,baseRefName,isDraft,mergeable,reviewDecision,statusCheckRollup,url";
const PR_VIEW_FIELDS: &str = "number,title,state,headRefName,headRefOid,baseRefName,isDraft,mergeable,mergeStateStatus,reviewDecision,url,author,isCrossRepository,headRepositoryOwner";
const RUN_FIELDS: &str = "databaseId,displayTitle,workflowName,headBranch,headSha,event,status,conclusion,createdAt,url";

impl Provider {
    pub fn bin_name(self) -> &'static str {
        match self {
            Self::GitHub => "gh",
        }
    }

    fn override_env(self) -> &'static str {
        match self {
            Self::GitHub => "COLONY_GH_BIN",
        }
    }

    /// The CLI argv for `op` (pure, unit-tested).
    pub fn argv(self, op: &Op) -> Vec<String> {
        let v = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        match self {
            Self::GitHub => match op {
                Op::AuthStatus => v(&["auth", "status"]),
                Op::ListPrs => v(&["pr", "list", "--state", "open", "--limit", "50", "--json", PR_LIST_FIELDS]),
                Op::PrView(n) => v(&["pr", "view", &n.to_string(), "--json", PR_VIEW_FIELDS]),
                Op::PrChecks(n) => v(&["pr", "checks", &n.to_string()]),
                Op::PrDiff(n) => v(&["pr", "diff", &n.to_string()]),
                Op::PrWeb(n) => v(&["pr", "view", &n.to_string(), "--web"]),
                Op::Merge(n, m, head) => {
                    let mut a = v(&["pr", "merge", &n.to_string(), &format!("--{}", m.as_str())]);
                    if let Some(h) = head.as_deref().filter(|h| h.len() == 40 && h.bytes().all(|c| c.is_ascii_hexdigit())) {
                        a.extend(["--match-head-commit".to_string(), h.to_string()]);
                    }
                    a
                }
                Op::Runs { branch } => {
                    let mut a = v(&["run", "list", "--limit", "30", "--json", RUN_FIELDS]);
                    if let Some(b) = branch {
                        a.extend(["--branch".to_string(), b.clone()]);
                    }
                    a
                }
                Op::RunView(id) => v(&["run", "view", &id.to_string(), "--json", RUN_FIELDS]),
                Op::RerunFailed(id) => v(&["run", "rerun", &id.to_string(), "--failed"]),
                Op::PrCreate { base, head, title, body } => v(&["pr", "create", "--base", base, "--head", head, "--title", title, "--body", body]),
            },
        }
    }
}

/// The forge CLI found on PATH (or through `COLONY_GH_BIN`).
pub struct Forge {
    pub provider: Provider,
    pub bin: PathBuf,
}

/// Result of one CLI call: the exit status and everything it printed.
pub struct Output {
    pub ok: bool,
    pub text: String,
}

impl Forge {
    pub fn detect() -> Result<Forge, String> {
        let provider = Provider::GitHub;
        tools::find_bin(provider.bin_name(), Some(provider.override_env()))
            .map(|bin| Forge { provider, bin })
            .ok_or_else(|| "gh (GitHub CLI) not found on PATH: install it and run gh auth login".into())
    }

    fn output(&self, cwd: &Path, op: &Op) -> Result<std::process::Output, String> {
        Command::new(&self.bin)
            .args(self.provider.argv(op))
            .current_dir(cwd)
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1")
            .env("NO_COLOR", "1")
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("{} failed to start: {e}", self.bin.display()))
    }

    pub fn exec(&self, cwd: &Path, op: &Op) -> Result<Output, String> {
        let out = self.output(cwd, op)?;
        let mut text = String::from_utf8_lossy(&out.stdout).to_string();
        text.push_str(&String::from_utf8_lossy(&out.stderr));
        if text.len() > MAX_OUTPUT_BYTES {
            let mut cut = MAX_OUTPUT_BYTES;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
            text.push_str("\n... (output truncated)\n");
        }
        Ok(Output { ok: out.status.success(), text })
    }

    /// Run `op` and require success.
    pub fn run(&self, cwd: &Path, op: &Op) -> Result<String, String> {
        let o = self.exec(cwd, op)?;
        if o.ok {
            Ok(o.text)
        } else {
            Err(format!("{} {} failed:\n{}", self.provider.bin_name(), self.provider.argv(op).join(" "), o.text.trim()))
        }
    }

    /// Run a `--json` operation and parse its stdout.
    pub fn json(&self, cwd: &Path, op: &Op) -> Result<Value, String> {
        let out = self.output(cwd, op)?;
        if !out.status.success() {
            return Err(format!(
                "{} {} failed:\n{}",
                self.provider.bin_name(),
                self.provider.argv(op).join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        serde_json::from_slice(&out.stdout).map_err(|e| format!("Unexpected {} output: {e}", self.provider.bin_name()))
    }

    /// `gh pr checks` exits non-zero while checks are pending or failing: keep its text.
    pub fn checks_text(&self, cwd: &Path, pr: u64) -> String {
        match self.exec(cwd, &Op::PrChecks(pr)) {
            Ok(o) => o.text.trim().to_string(),
            Err(e) => e,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeStatus {
    provider: String,
    /// The CLI binary, `None` when it is not installed.
    bin: Option<String>,
    authenticated: bool,
    detail: String,
}

fn root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    workspace::workspace_root(state)
}

/// Is the forge CLI installed and logged in? Never an error: the UI shows the state.
#[tauri::command(async)]
pub fn forge_status(state: State<'_, AppState>) -> ForgeStatus {
    let forge = match Forge::detect() {
        Ok(f) => f,
        Err(detail) => return ForgeStatus { provider: "github".into(), bin: None, authenticated: false, detail },
    };
    let cwd = root(&state).unwrap_or_else(|_| PathBuf::from("/"));
    let (authenticated, detail) = match forge.exec(&cwd, &Op::AuthStatus) {
        Ok(o) => (o.ok, o.text.trim().to_string()),
        Err(e) => (false, e),
    };
    ForgeStatus { provider: "github".into(), bin: Some(forge.bin.display().to_string()), authenticated, detail }
}

#[tauri::command(async)]
pub fn forge_prs(state: State<'_, AppState>) -> Result<Value, String> {
    Forge::detect()?.json(&root(&state)?, &Op::ListPrs)
}

/// Recent workflow runs, optionally only those of `branch`.
#[tauri::command(async)]
pub fn forge_runs(state: State<'_, AppState>, branch: Option<String>) -> Result<Value, String> {
    let branch = branch.map(|b| b.trim().to_string()).filter(|b| !b.is_empty());
    if let Some(b) = &branch {
        if !crate::hostreq::valid_branch(b) {
            return Err(format!("Not a branch name: {b}"));
        }
    }
    Forge::detect()?.json(&root(&state)?, &Op::Runs { branch })
}

/// The operator's own click in the CI/CD tab: rerun the failed jobs of one run.
#[tauri::command(async)]
pub fn forge_rerun_failed(state: State<'_, AppState>, run_id: u64) -> Result<String, String> {
    Forge::detect()?.run(&root(&state)?, &Op::RerunFailed(run_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_argv_never_admin_or_auto() {
        for m in [MergeMethod::Squash, MergeMethod::Merge, MergeMethod::Rebase] {
            let a = Provider::GitHub.argv(&Op::Merge(12, m, None));
            assert_eq!(a, vec!["pr".to_string(), "merge".into(), "12".into(), format!("--{}", m.as_str())]);
            let oid = "0123456789abcdef0123456789abcdef01234567";
            let p = Provider::GitHub.argv(&Op::Merge(12, m, Some(oid.into())));
            assert_eq!(&p[4..], ["--match-head-commit", oid]);
            assert_eq!(Provider::GitHub.argv(&Op::Merge(12, m, Some("--admin".into()))).len(), 4, "a non-sha head is dropped");
            assert!(!a.iter().any(|x| x == "--admin" || x == "--auto"));
        }
    }

    #[test]
    fn list_and_rerun_argv() {
        let a = Provider::GitHub.argv(&Op::ListPrs);
        assert_eq!(&a[..2], ["pr", "list"]);
        assert!(a.contains(&PR_LIST_FIELDS.to_string()));
        assert_eq!(Provider::GitHub.argv(&Op::RerunFailed(99)), ["run", "rerun", "99", "--failed"]);
        let r = Provider::GitHub.argv(&Op::Runs { branch: Some("feat/x".into()) });
        assert_eq!(&r[r.len() - 2..], ["--branch", "feat/x"]);
    }

    #[test]
    fn pr_create_argv_is_fixed_fields_only() {
        let a = Provider::GitHub.argv(&Op::PrCreate { base: "main".into(), head: "staging".into(), title: "T; rm -rf /".into(), body: "$(x)".into() });
        assert_eq!(a, ["pr", "create", "--base", "main", "--head", "staging", "--title", "T; rm -rf /", "--body", "$(x)"]);
        assert!(!a.iter().any(|x| x == "--web" || x == "--fill" || x == "--draft"));
    }

    #[test]
    fn merge_methods_parse() {
        assert_eq!(MergeMethod::parse("rebase"), Some(MergeMethod::Rebase));
        assert_eq!(MergeMethod::parse("--admin"), None);
        assert_eq!(MergeMethod::default(), MergeMethod::Squash);
    }
}
