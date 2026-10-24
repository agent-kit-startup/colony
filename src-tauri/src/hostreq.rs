//! Host actions: Colony is the harness for the git / forge loop.
//!
//! An agent running inside Colony (an interactive `claude` / `codex` in a terminal tab, or
//! an `agent-kit run-plan` driver run) that cannot or must not merge a PR, rerun failed
//! checks or push a branch itself files a request with the same binary in CLI mode:
//!
//! ```text
//! "$COLONY_HOST_CLI" request merge-pr 12 [--method squash|merge|rebase] [--reason "..."]
//! "$COLONY_HOST_CLI" request rerun-checks <run-id> | --pr 12
//! "$COLONY_HOST_CLI" request push-branch [<branch>]
//! "$COLONY_HOST_CLI" request open-pr promote | staging-sync
//! ```
//!
//! The CLI writes `<id>.request.json` into the spool named by `COLONY_HOST_SPOOL` (a
//! per-instance 0700 folder) and blocks until `<id>.response.json` appears. Colony shows
//! each request as an approval card and runs the action, with the operator's own `git` /
//! `gh` login, only after the operator clicks Approve (a production base or branch needs a
//! typed `yes`). The spool can never approve anything: a response file written by someone
//! else only fools that requester, because Colony performs the action itself after the
//! click and only then writes the response. The kinds are a closed allowlist: no shell,
//! no arbitrary command, no hook names.
//!
//! Exit codes: 0 approved and succeeded, 2 denied by the operator, 3 approved but the
//! action failed, 4 timeout (or Colony went away), 64 usage error or no Colony host.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::State;

use crate::forge::{Forge, MergeMethod, Op};
use crate::{branchrule, gitops, workspace, AppState};

pub const SPOOL_ENV: &str = "COLONY_HOST_SPOOL";
pub const CLI_ENV: &str = "COLONY_HOST_CLI";
pub const KINDS: &[&str] = &["merge-pr", "rerun-checks", "push-branch", "open-pr"];
const PROTOCOL: u32 = 1;
const MAX_REQUEST_BYTES: u64 = 64 * 1024;
const MAX_REASON_CHARS: usize = 2000;
const MAX_PENDING: usize = 50;
const POLL: Duration = Duration::from_millis(500);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// A requester whose action is already running when its timeout hits waits this much longer.
const RUNNING_GRACE: Duration = Duration::from_secs(15 * 60);
const HOST_PID_FILE: &str = "host.pid";

pub const EXIT_OK: i32 = 0;
pub const EXIT_DENIED: i32 = 2;
pub const EXIT_FAILED: i32 = 3;
pub const EXIT_TIMEOUT: i32 = 4;
pub const EXIT_USAGE: i32 = 64;

const USAGE: &str = "usage: colony request <kind> [args] [--reason \"...\"] [--timeout 30m]

kinds (closed allowlist):
  merge-pr <number> [--method squash|merge|rebase]   merge a pull request (default squash)
  rerun-checks <run-id> | --pr <number>              rerun the failed jobs of a workflow run
  push-branch [<branch>]                             push a branch (default: the current one;
                                                     never forced, never a production branch)
  open-pr promote | staging-sync                     open one of the two ship-lane pull requests:
                                                     staging -> main, or the staging fast-forward
                                                     sync (origin/main pushed to a new chore/ branch,
                                                     PR into staging); branches, title and body are
                                                     fixed by Colony

Waits for the operator's click in Colony. --timeout takes seconds or 90s / 30m / 2h
(default 30m). Exit: 0 approved and succeeded, 2 denied, 3 approved but failed,
4 timeout, 64 usage error or no Colony host (COLONY_HOST_SPOOL unset).";

// ---- the request vocabulary ------------------------------------------------------------

/// The two pull requests of the ship lane Colony can open (`open-pr`). Nothing else about
/// them is chosen by the requester: the branches come from the repository's own
/// `origin/staging` and default branch, the title and body are written here.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PrShape {
    /// `staging` -> the default branch (`main` / `master`), merged later with a typed yes.
    Promote,
    /// The staging fast-forward sync: the default branch's tip pushed to a new
    /// `chore/sync-staging-<main>-<sha7>` branch, PR into `staging`.
    StagingSync,
}

impl PrShape {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "promote" => Some(Self::Promote),
            "staging-sync" => Some(Self::StagingSync),
            _ => None,
        }
    }
}

/// One allowlisted host action, as filed by the requester.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", content = "args", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Action {
    MergePr {
        number: u64,
        #[serde(default)]
        method: MergeMethod,
    },
    /// Exactly one of `run` (a workflow run id) and `pr` (rerun the failed runs of that
    /// PR's head commit).
    RerunChecks {
        #[serde(default)]
        run: Option<u64>,
        #[serde(default)]
        pr: Option<u64>,
    },
    PushBranch {
        #[serde(default)]
        branch: Option<String>,
    },
    OpenPr {
        shape: PrShape,
    },
}

impl Action {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Action::MergePr { number, .. } if *number == 0 => Err("merge-pr needs a PR number".into()),
            Action::RerunChecks { run, pr } => match (run, pr) {
                (Some(r), None) if *r > 0 => Ok(()),
                (None, Some(p)) if *p > 0 => Ok(()),
                _ => Err("rerun-checks needs exactly one of <run-id> or --pr <number>".into()),
            },
            Action::PushBranch { branch: Some(b) } if !valid_branch(b) => Err(format!("Not a branch name: {b}")),
            _ => Ok(()),
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Action::MergePr { .. } => "merge-pr",
            Action::RerunChecks { .. } => "rerun-checks",
            Action::PushBranch { .. } => "push-branch",
            Action::OpenPr { .. } => "open-pr",
        }
    }

    pub fn summary(&self) -> String {
        match self {
            Action::MergePr { number, method } => format!("merge PR #{number} ({})", method.as_str()),
            Action::RerunChecks { run: Some(r), .. } => format!("rerun the failed jobs of run {r}"),
            Action::RerunChecks { pr, .. } => format!("rerun the failed checks of PR #{}", pr.unwrap_or(0)),
            Action::PushBranch { branch } => format!("push {}", branch.as_deref().unwrap_or("the current branch")),
            Action::OpenPr { shape: PrShape::Promote } => "open the staging -> main pull request".into(),
            Action::OpenPr { shape: PrShape::StagingSync } => "open the staging fast-forward sync pull request".into(),
        }
    }

    fn to_parts(&self) -> (String, Value) {
        let v = serde_json::to_value(self).unwrap_or(Value::Null);
        (self.kind().to_string(), v.get("args").cloned().unwrap_or(Value::Null))
    }

    fn from_parts(kind: &str, args: &Value) -> Result<Action, String> {
        if !KINDS.contains(&kind) {
            return Err(format!("Kind {kind:?} is not allowed (allowed: {})", KINDS.join(", ")));
        }
        let a: Action = serde_json::from_value(json!({ "kind": kind, "args": args })).map_err(|e| format!("Bad {kind} arguments: {e}"))?;
        a.validate()?;
        Ok(a)
    }
}

/// A branch name Colony is willing to pass to git (a conservative subset of
/// `git check-ref-format --branch`; never an option).
pub fn valid_branch(b: &str) -> bool {
    !b.is_empty()
        && b.len() <= 200
        && !b.starts_with(['-', '/', '.', '+'])
        && !b.ends_with(['/', '.'])
        && !b.ends_with(".lock")
        && !b.contains("..")
        && !b.contains("//")
        && !b.contains("/.")
        && b != "HEAD"
        && b.chars().all(|c| c.is_ascii_alphanumeric() || "._/-+".contains(c))
}

/// `<id>.request.json`: what the CLI writes into the spool.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub v: u32,
    pub id: String,
    pub kind: String,
    pub args: Value,
    #[serde(default)]
    pub reason: String,
    pub cwd: String,
    /// The `colony request` process (its death withdraws the request).
    pub pid: u32,
    /// Its parent: the agent or shell that asked.
    #[serde(default)]
    pub ppid: u32,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Succeeded,
    Failed,
    Denied,
}

impl Outcome {
    pub fn exit_code(self) -> i32 {
        match self {
            Outcome::Succeeded => EXIT_OK,
            Outcome::Denied => EXIT_DENIED,
            Outcome::Failed => EXIT_FAILED,
        }
    }
}

/// `<id>.response.json`: written by Colony after the operator decided.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub v: u32,
    pub id: String,
    pub outcome: Outcome,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub output: String,
    pub decided_at: String,
}

// ---- small helpers ---------------------------------------------------------------------

/// RFC 3339 UTC timestamp (no date crate needed: days-to-civil, H. Hinnant).
fn iso(t: SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn now() -> String {
    iso(SystemTime::now())
}

/// 128-bit random request id (hex), from the kernel's CSPRNG.
fn nonce() -> Result<String, String> {
    use std::io::Read;
    let mut b = [0u8; 16];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).map_err(|e| format!("no randomness: {e}"))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

fn request_path(spool: &Path, id: &str) -> PathBuf {
    spool.join(format!("{id}.request.json"))
}
fn running_path(spool: &Path, id: &str) -> PathBuf {
    spool.join(format!("{id}.running.json"))
}
fn response_path(spool: &Path, id: &str) -> PathBuf {
    spool.join(format!("{id}.response.json"))
}

/// Write `bytes` to `path` atomically (temp file in the same folder, mode 0600, rename).
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    drop(f);
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

pub(crate) fn pid_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    // SAFETY: signal 0 only checks that the process exists.
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// The Colony instance that owns `spool` is still running.
fn host_alive(spool: &Path) -> bool {
    std::fs::read_to_string(spool.join(HOST_PID_FILE)).ok().and_then(|s| s.trim().parse::<u32>().ok()).is_some_and(pid_alive)
}

fn parse_number(s: &str, what: &str) -> Result<u64, String> {
    let t = s.strip_prefix('#').unwrap_or(s);
    match t.parse::<u64>() {
        Ok(n) if n > 0 && t.bytes().all(|c| c.is_ascii_digit()) => Ok(n),
        _ => Err(format!("{what} must be a positive number, got {s:?}")),
    }
}

fn parse_timeout(s: &str) -> Result<Duration, String> {
    let (num, mult) = match s.as_bytes().last() {
        Some(b's') => (&s[..s.len() - 1], 1),
        Some(b'm') => (&s[..s.len() - 1], 60),
        Some(b'h') => (&s[..s.len() - 1], 3600),
        _ => (s, 1),
    };
    match num.parse::<u64>() {
        Ok(n) if n > 0 && n * mult <= 24 * 3600 => Ok(Duration::from_secs(n * mult)),
        _ => Err(format!("--timeout takes seconds or 90s / 30m / 2h (at most 24h), got {s:?}")),
    }
}

// ---- CLI mode: `colony request ...` ----------------------------------------------------

#[derive(Debug, PartialEq)]
pub struct CliRequest {
    pub action: Action,
    pub reason: String,
    pub timeout: Duration,
}

/// Parse the arguments after `request` (pure, unit-tested).
pub fn parse_cli(args: &[String]) -> Result<CliRequest, String> {
    let mut pos: Vec<&str> = Vec::new();
    let (mut reason, mut timeout, mut method, mut pr) = (None, None, None, None);
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        let (name, inline) = match a.split_once('=') {
            Some((n, v)) if n.starts_with("--") => (n, Some(v.to_string())),
            _ => (a, None),
        };
        let value = |i: &mut usize| -> Result<String, String> {
            if let Some(v) = inline.clone() {
                return Ok(v);
            }
            *i += 1;
            args.get(*i).cloned().ok_or_else(|| format!("{name} needs a value"))
        };
        match name {
            "--reason" => reason = Some(value(&mut i)?),
            "--timeout" => timeout = Some(parse_timeout(&value(&mut i)?)?),
            "--method" => method = Some(value(&mut i)?),
            "--pr" => pr = Some(value(&mut i)?),
            "--" => {
                pos.extend(args[i + 1..].iter().map(String::as_str));
                break;
            }
            _ if a.starts_with('-') => return Err(format!("Unknown option {a}")),
            _ => pos.push(a),
        }
        i += 1;
    }
    let Some((&kind, rest)) = pos.split_first() else { return Err("Missing the request kind".into()) };
    let no = |what: &Option<String>, opt: &str| match what {
        Some(_) => Err(format!("{opt} does not apply to {kind}")),
        None => Ok(()),
    };
    let action = match kind {
        "merge-pr" => {
            no(&pr, "--pr")?;
            let [n] = rest else { return Err("merge-pr takes exactly one PR number".into()) };
            let method = match method.as_deref() {
                None => MergeMethod::Squash,
                Some(m) => MergeMethod::parse(m).ok_or_else(|| format!("--method must be squash, merge or rebase, got {m:?}"))?,
            };
            Action::MergePr { number: parse_number(n, "The PR number")?, method }
        }
        "rerun-checks" => {
            no(&method, "--method")?;
            match (rest, pr.as_deref()) {
                ([r], None) => Action::RerunChecks { run: Some(parse_number(r, "The run id")?), pr: None },
                ([], Some(p)) => Action::RerunChecks { run: None, pr: Some(parse_number(p, "--pr")?) },
                _ => return Err("rerun-checks takes exactly one of <run-id> or --pr <number>".into()),
            }
        }
        "push-branch" => {
            no(&method, "--method")?;
            no(&pr, "--pr")?;
            match rest {
                [] => Action::PushBranch { branch: None },
                [b] => Action::PushBranch { branch: Some(b.to_string()) },
                _ => return Err("push-branch takes at most one branch".into()),
            }
        }
        "open-pr" => {
            no(&method, "--method")?;
            no(&pr, "--pr")?;
            let [shape] = rest else { return Err("open-pr takes exactly one shape: promote or staging-sync".into()) };
            Action::OpenPr { shape: PrShape::parse(shape).ok_or_else(|| format!("open-pr shape must be promote or staging-sync, got {shape:?}"))? }
        }
        other => return Err(format!("Kind {other:?} is not allowed (allowed: {})", KINDS.join(", "))),
    };
    action.validate()?;
    let reason: String = reason.unwrap_or_default().trim().chars().take(MAX_REASON_CHARS).collect();
    Ok(CliRequest { action, reason, timeout: timeout.unwrap_or(DEFAULT_TIMEOUT) })
}

/// Entry point of `colony request ...` (argv[1] == "request"): never starts the GUI.
pub fn cli_main() -> i32 {
    let args: Vec<String> = std::env::args().skip(2).collect();
    let spool = std::env::var_os(SPOOL_ENV).map(PathBuf::from).filter(|p| !p.as_os_str().is_empty());
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    cli_run(&args, spool, &cwd, POLL)
}

pub fn cli_run(args: &[String], spool: Option<PathBuf>, cwd: &Path, poll: Duration) -> i32 {
    if matches!(args.first().map(String::as_str), Some("-h" | "--help" | "help")) {
        println!("{USAGE}");
        return EXIT_OK;
    }
    let req = match parse_cli(args) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("colony request: {e}\n\n{USAGE}");
            return EXIT_USAGE;
        }
    };
    let Some(spool) = spool else {
        eprintln!("colony request: no Colony host: {SPOOL_ENV} is not set (run it in a Colony terminal tab or an agent run started by Colony)");
        return EXIT_USAGE;
    };
    if !host_alive(&spool) {
        eprintln!("colony request: no Colony host at {} (the Colony window that set {SPOOL_ENV} is gone)", spool.display());
        return EXIT_USAGE;
    }
    let mut action = req.action;
    // push-branch: pin the branch now, so the card shows exactly what will be pushed.
    if let Action::PushBranch { branch } = &mut action {
        if branch.is_none() {
            match gitops::git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).map(|s| s.trim().to_string()) {
                Ok(b) if b != "HEAD" && valid_branch(&b) => *branch = Some(b),
                Ok(_) => {
                    eprintln!("colony request: detached HEAD: name the branch to push");
                    return EXIT_USAGE;
                }
                Err(e) => {
                    eprintln!("colony request: {e}");
                    return EXIT_USAGE;
                }
            }
        }
        let b = branch.clone().unwrap_or_default();
        if let Some(why) = branchrule::request_production_reason(&b) {
            eprintln!("colony request: refused: {why}. A production branch is pushed by the operator from Colony's Git tab, never on request.");
            return EXIT_USAGE;
        }
    }
    let id = match nonce() {
        Ok(id) => id,
        Err(e) => {
            eprintln!("colony request: {e}");
            return EXIT_USAGE;
        }
    };
    let (kind, args) = action.to_parts();
    let request = Request {
        v: PROTOCOL,
        id: id.clone(),
        kind,
        args,
        reason: req.reason,
        cwd: cwd.display().to_string(),
        pid: std::process::id(),
        // SAFETY: getppid never fails.
        ppid: unsafe { libc::getppid() } as u32,
        created_at: now(),
    };
    let body = serde_json::to_vec_pretty(&request).unwrap_or_default();
    if let Err(e) = write_atomic(&request_path(&spool, &id), &body) {
        eprintln!("colony request: cannot write the request: {e}");
        return EXIT_USAGE;
    }
    eprintln!("colony request {id}: {} is waiting for the operator in Colony (Git tab, Requests)", action.summary());
    match wait_for_response(&spool, &id, req.timeout, poll) {
        Waited::Answered(r) => {
            match r.outcome {
                Outcome::Succeeded => println!("approved: {} succeeded", action.summary()),
                Outcome::Failed => println!("approved, but {} failed", action.summary()),
                Outcome::Denied => println!("denied by the operator: {}", r.reason.as_deref().filter(|s| !s.is_empty()).unwrap_or("no reason given")),
            }
            if !r.output.trim().is_empty() {
                println!("{}", r.output.trim_end());
            }
            r.outcome.exit_code()
        }
        Waited::TimedOut => {
            eprintln!("colony request {id}: no answer within {}s: withdrawn", req.timeout.as_secs());
            EXIT_TIMEOUT
        }
        Waited::HostGone => {
            eprintln!("colony request {id}: Colony exited before answering");
            EXIT_TIMEOUT
        }
    }
}

#[derive(Debug)]
pub enum Waited {
    Answered(Response),
    TimedOut,
    HostGone,
}

fn take_response(spool: &Path, id: &str) -> Option<Response> {
    let p = response_path(spool, id);
    let r: Response = serde_json::from_slice(&std::fs::read(&p).ok()?).ok()?;
    let _ = std::fs::remove_file(&p);
    (r.id == id).then_some(r)
}

/// Block until Colony answers, the timeout passes (the request is withdrawn, unless the
/// operator already approved it and the action is running) or Colony exits.
pub fn wait_for_response(spool: &Path, id: &str, timeout: Duration, poll: Duration) -> Waited {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(r) = take_response(spool, id) {
            let _ = std::fs::remove_file(request_path(spool, id));
            return Waited::Answered(r);
        }
        if !host_alive(spool) {
            let _ = std::fs::remove_file(request_path(spool, id));
            return Waited::HostGone;
        }
        if Instant::now() >= deadline {
            // Withdraw atomically: if Colony already claimed it, the action is running.
            let withdrawn = spool.join(format!("{id}.withdrawn"));
            if std::fs::rename(request_path(spool, id), &withdrawn).is_ok() {
                let _ = std::fs::remove_file(withdrawn);
                return Waited::TimedOut;
            }
            if let Some(r) = take_response(spool, id) {
                return Waited::Answered(r);
            }
            if Instant::now() >= deadline + RUNNING_GRACE || !running_path(spool, id).exists() {
                return Waited::TimedOut;
            }
        }
        std::thread::sleep(poll);
    }
}

// ---- host side: the spool, the pending cards, approve / deny ---------------------------

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    /// Filed through `colony request` (a CLI process waits for the answer).
    Agent,
    /// Created by the operator in Colony (e.g. the PR list's Merge button).
    Colony,
}

#[derive(Clone, Debug)]
struct Pending {
    req: Request,
    action: Action,
    origin: Origin,
    running: bool,
    /// What the card showed when its context first loaded; Approve acts on exactly that or
    /// refuses (security review 2026-10-24, findings 4 and 5).
    pin: Option<Pin>,
}

/// The facts a card showed, pinned for Approve.
#[derive(Clone, Debug, PartialEq)]
pub enum Pin {
    /// merge-pr: the PR's head commit (merged with `--match-head-commit`) and its base.
    Merge { head: String, base: String },
    /// open-pr: the whole plan (branches, sha, title, body).
    Plan(PrPlan),
}

/// One approval card, as the UI sees it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RequestView {
    id: String,
    kind: String,
    args: Value,
    summary: String,
    reason: String,
    cwd: String,
    pid: u32,
    created_at: String,
    origin: Origin,
    running: bool,
}

impl From<&Pending> for RequestView {
    fn from(p: &Pending) -> Self {
        RequestView {
            id: p.req.id.clone(),
            kind: p.req.kind.clone(),
            args: p.req.args.clone(),
            summary: p.action.summary(),
            reason: p.req.reason.clone(),
            cwd: p.req.cwd.clone(),
            pid: p.req.pid,
            created_at: p.req.created_at.clone(),
            origin: p.origin,
            running: p.running,
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HostEvent {
    Requests { items: Vec<RequestView>, spool: Option<String> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    outcome: Outcome,
    output: String,
}

/// Colony's side of the spool (managed Tauri state).
#[derive(Default)]
pub struct HostRequests {
    spool: Option<PathBuf>,
    items: Mutex<Vec<Pending>>,
    subs: Mutex<Vec<Channel<HostEvent>>>,
}

/// Where this instance's spool lives: `$XDG_RUNTIME_DIR/colony/<pid>/requests`, else
/// the app data folder (`$XDG_DATA_HOME/io.missionkit.colony/host/<pid>/requests`).
fn spool_base() -> Option<PathBuf> {
    if let Some(run) = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).filter(|p| p.is_dir()) {
        return Some(run.join("colony"));
    }
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?;
    Some(data.join("io.missionkit.colony").join("host"))
}

/// Remove the spools of Colony instances that are gone.
fn prune_stale(base: &Path) {
    let Ok(rd) = std::fs::read_dir(base) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if let Ok(pid) = name.parse::<u32>() {
            if pid != std::process::id() && !pid_alive(pid) {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
}

fn make_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

/// `current_exe`, minus the " (deleted)" suffix Linux adds after the binary was rebuilt
/// in place (the new binary at that path speaks the same protocol).
fn cli_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let s = exe.to_string_lossy();
    Some(s.strip_suffix(" (deleted)").map(PathBuf::from).unwrap_or(exe))
}

impl HostRequests {
    /// Create the spool and export `COLONY_HOST_SPOOL` / `COLONY_HOST_CLI` into this
    /// process's environment, so every terminal tab and agent run Colony starts inherits
    /// them. Call before any thread starts (it sets environment variables).
    pub fn prepare() -> HostRequests {
        let spool = spool_base().and_then(|base| {
            prune_stale(&base);
            let dir = base.join(std::process::id().to_string()).join("requests");
            make_private_dir(&base).ok()?;
            make_private_dir(dir.parent()?).ok()?;
            make_private_dir(&dir).ok()?;
            write_atomic(&dir.join(HOST_PID_FILE), std::process::id().to_string().as_bytes()).ok()?;
            Some(dir)
        });
        if let Some(dir) = &spool {
            // SAFETY (edition 2021: safe fn): called from run() before threads are spawned.
            std::env::set_var(SPOOL_ENV, dir);
            if let Some(cli) = cli_path() {
                std::env::set_var(CLI_ENV, cli);
            }
        } else {
            std::env::remove_var(SPOOL_ENV);
            std::env::remove_var(CLI_ENV);
        }
        HostRequests { spool, ..Default::default() }
    }

    #[cfg(test)]
    fn with_spool(spool: PathBuf) -> HostRequests {
        HostRequests { spool: Some(spool), ..Default::default() }
    }

    /// Poll the spool (~500 ms) for new requests and withdrawn ones.
    pub fn start_watcher(self: &Arc<Self>) {
        if self.spool.is_none() {
            return;
        }
        let me = self.clone();
        std::thread::spawn(move || loop {
            if me.scan() {
                me.broadcast();
            }
            std::thread::sleep(POLL);
        });
    }

    /// Remove this instance's spool (Colony exit).
    pub fn cleanup(&self) {
        if let Some(pid_dir) = self.spool.as_deref().and_then(Path::parent) {
            let _ = std::fs::remove_dir_all(pid_dir);
        }
    }

    fn views(&self) -> Vec<RequestView> {
        self.items.lock().map(|v| v.iter().map(RequestView::from).collect()).unwrap_or_default()
    }

    fn broadcast(&self) {
        let ev = HostEvent::Requests { items: self.views(), spool: self.spool.as_ref().map(|p| p.display().to_string()) };
        if let Ok(mut subs) = self.subs.lock() {
            subs.retain(|ch| ch.send(ev.clone()).is_ok());
        }
    }

    /// Read and check one request file. The file is untrusted input from another process:
    /// everything is re-validated against the allowlist here.
    fn load(path: &Path, id: &str) -> Result<(Request, Action), String> {
        let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
        if meta.len() > MAX_REQUEST_BYTES {
            return Err("request file too large".into());
        }
        let mut req: Request = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?).map_err(|e| format!("unreadable request: {e}"))?;
        if req.v != PROTOCOL || req.id != id {
            return Err("request id or protocol version mismatch".into());
        }
        let action = Action::from_parts(&req.kind, &req.args)?;
        let cwd = PathBuf::from(&req.cwd).canonicalize().map_err(|e| format!("cwd {}: {e}", req.cwd))?;
        if !cwd.is_dir() || gitops::git(&cwd, &["rev-parse", "--show-toplevel"]).is_err() {
            return Err(format!("cwd {} is not inside a git repository", cwd.display()));
        }
        req.cwd = cwd.display().to_string();
        req.reason = req.reason.trim().chars().take(MAX_REASON_CHARS).collect();
        Ok((req, action))
    }

    /// Answer a request without a card (invalid file, too many pending ones).
    fn reject(&self, spool: &Path, id: &str, why: &str) {
        let claimed = running_path(spool, id);
        if std::fs::rename(request_path(spool, id), &claimed).is_ok() {
            let _ = write_response(spool, id, Outcome::Denied, Some(format!("Colony refused the request: {why}")), String::new());
            let _ = std::fs::remove_file(claimed);
        }
    }

    /// One pass over the spool. Returns true when the pending list changed.
    fn scan(&self) -> bool {
        let Some(spool) = self.spool.as_deref() else { return false };
        let Ok(rd) = std::fs::read_dir(spool) else { return false };
        let known: HashSet<String> = self.items.lock().map(|v| v.iter().map(|p| p.req.id.clone()).collect()).unwrap_or_default();
        let mut present = HashSet::new();
        let mut fresh = Vec::new();
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let Some(id) = name.strip_suffix(".request.json") else { continue };
            if !valid_id(id) {
                let _ = std::fs::remove_file(e.path());
                continue;
            }
            present.insert(id.to_string());
            if known.contains(id) {
                continue;
            }
            match Self::load(&e.path(), id) {
                Ok((req, action)) => fresh.push(Pending { req, action, origin: Origin::Agent, running: false, pin: None }),
                Err(why) => self.reject(spool, id, &why),
            }
        }
        let Ok(mut items) = self.items.lock() else { return false };
        let before: Vec<String> = items.iter().map(|p| p.req.id.clone()).collect();
        items.retain(|p| {
            if p.origin == Origin::Colony || p.running {
                return true;
            }
            let keep = present.contains(&p.req.id) && pid_alive(p.req.pid);
            if !keep {
                let _ = std::fs::remove_file(request_path(spool, &p.req.id));
            }
            keep
        });
        for p in fresh {
            if items.len() >= MAX_PENDING {
                self.reject(spool, &p.req.id, "too many pending requests");
            } else if pid_alive(p.req.pid) {
                items.push(p);
            } else {
                let _ = std::fs::remove_file(request_path(spool, &p.req.id));
            }
        }
        items.iter().map(|p| p.req.id.clone()).collect::<Vec<_>>() != before
    }

    /// Keep the first context's facts for Approve (a later reload does not move the pin).
    fn pin_once(&self, id: &str, pin: Option<Pin>) {
        if let Ok(mut items) = self.items.lock() {
            if let Some(p) = items.iter_mut().find(|p| p.req.id == id && p.pin.is_none() && !p.running) {
                p.pin = pin;
            }
        }
    }

    fn get(&self, id: &str) -> Result<Pending, String> {
        self.items.lock().map_err(|_| "host request lock poisoned")?.iter().find(|p| p.req.id == id).cloned().ok_or_else(|| "That request is no longer pending".into())
    }

    /// Take a pending request for a decision: an agent request's file is renamed so a
    /// requester that times out at the same moment knows the action is under way.
    fn claim(&self, id: &str) -> Result<Pending, String> {
        let mut items = self.items.lock().map_err(|_| "host request lock poisoned")?;
        let idx = items.iter().position(|p| p.req.id == id).ok_or("That request is no longer pending")?;
        if items[idx].running {
            return Err("That request is already being handled".into());
        }
        if items[idx].origin == Origin::Agent {
            let spool = self.spool.as_deref().ok_or("no spool")?;
            if std::fs::rename(request_path(spool, id), running_path(spool, id)).is_err() {
                items.remove(idx);
                return Err("The requester withdrew this request (timeout or exit)".into());
            }
        }
        items[idx].running = true;
        Ok(items[idx].clone())
    }

    fn finish(&self, p: &Pending, outcome: Outcome, reason: Option<String>, output: String) {
        if p.origin == Origin::Agent {
            if let Some(spool) = self.spool.as_deref() {
                let _ = write_response(spool, &p.req.id, outcome, reason, output);
                let _ = std::fs::remove_file(running_path(spool, &p.req.id));
            }
        }
        if let Ok(mut items) = self.items.lock() {
            items.retain(|x| x.req.id != p.req.id);
        }
        self.broadcast();
    }

    /// Approve: re-derive the production rule from the repository and the forge (never
    /// from the UI), then run the action and answer the requester.
    pub fn approve(&self, id: &str, typed_confirm: Option<&str>) -> Result<Decision, String> {
        let p = self.get(id)?;
        let cwd = PathBuf::from(&p.req.cwd);
        if let Some(why) = production_gate(&p.action, &cwd)? {
            if typed_confirm.map(str::trim) != Some("yes") {
                return Err(format!("{why}: type yes on the card to approve"));
            }
        }
        let p = self.claim(id)?;
        self.broadcast();
        let (outcome, output) = match execute(&p.action, &cwd, p.pin.as_ref()) {
            Ok(out) => (Outcome::Succeeded, out),
            Err(out) => (Outcome::Failed, out),
        };
        self.finish(&p, outcome, None, output.clone());
        Ok(Decision { outcome, output })
    }

    pub fn deny(&self, id: &str, reason: Option<String>) -> Result<(), String> {
        let p = self.claim(id)?;
        let reason = reason.map(|r| r.trim().chars().take(MAX_REASON_CHARS).collect::<String>()).filter(|r| !r.is_empty());
        self.finish(&p, Outcome::Denied, reason, String::new());
        Ok(())
    }

    /// A request the operator starts in Colony (no CLI waits for it).
    pub fn add_local(&self, action: Action, cwd: &Path) -> Result<String, String> {
        action.validate()?;
        let id = nonce()?;
        let (kind, args) = action.to_parts();
        let req = Request { v: PROTOCOL, id: id.clone(), kind, args, reason: "Started in Colony".into(), cwd: cwd.display().to_string(), pid: std::process::id(), ppid: 0, created_at: now() };
        {
            let mut items = self.items.lock().map_err(|_| "host request lock poisoned")?;
            if items.iter().any(|p| p.origin == Origin::Colony && p.action == action && p.req.cwd == req.cwd) {
                return Err(format!("{} is already waiting on a card", action.summary()));
            }
            // Same cap as the spool (security review 2026-10-24, finding 7).
            if items.len() >= MAX_PENDING {
                return Err(format!("{MAX_PENDING} requests are already waiting: answer some first"));
            }
            items.push(Pending { req, action, origin: Origin::Colony, running: false, pin: None });
        }
        self.broadcast();
        Ok(id)
    }
}

fn write_response(spool: &Path, id: &str, outcome: Outcome, reason: Option<String>, output: String) -> Result<(), String> {
    let r = Response { v: PROTOCOL, id: id.to_string(), outcome, reason, output, decided_at: now() };
    write_atomic(&response_path(spool, id), &serde_json::to_vec_pretty(&r).map_err(|e| e.to_string())?)
}

/// What `open-pr` will do, derived from the repository's local remote-tracking refs (no
/// network). Every string that reaches `git` / `gh` is built here from validated branch
/// names and a hex sha; commit subjects only ever go into the PR body, as one argv value.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrPlan {
    shape: PrShape,
    base: String,
    head: String,
    /// `staging-sync`: the default branch's tip, pushed (never forced) to `head` first.
    push_sha: Option<String>,
    title: String,
    body: String,
    /// `git log --oneline` of what the PR carries (at most 30 lines).
    log: String,
}

const MAX_PR_LOG: usize = 30;

/// Host-request pushes run in the requester's folder: never through an `ext::` transport
/// its git config might name (security review 2026-10-24, finding 6). The repository's own
/// hooks still run: its pre-push guard is a safety layer, not a risk to switch off.
const NO_EXT_PROTOCOL: [&str; 2] = ["-c", "protocol.ext.allow=never"];

fn remote_ref_exists(cwd: &Path, branch: &str) -> bool {
    gitops::git(cwd, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/origin/{branch}")]).is_ok()
}

fn is_hex_sha(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

/// The plan for one ship-lane PR, or why Colony will not open it.
pub fn pr_plan(shape: PrShape, cwd: &Path) -> Result<PrPlan, String> {
    if !remote_ref_exists(cwd, "staging") {
        return Err("Refused: this repository has no origin/staging, so it has no staging flow to open a ship-lane PR in".into());
    }
    let main = ["main", "master"].into_iter().find(|b| remote_ref_exists(cwd, b)).ok_or("Refused: no origin/main or origin/master")?;
    // Same rule as the merge gate: with origin/staging, the default branch is production.
    branchrule::production_branch(cwd, main).ok_or_else(|| format!("Refused: {main} is not a production branch here"))?;
    let (base_ref, head_ref) = (format!("refs/remotes/origin/{main}"), "refs/remotes/origin/staging".to_string());
    let log_of = |range: &str| gitops::git(cwd, &["log", "--format=%h %s", "-n", &MAX_PR_LOG.to_string(), range, "--"]).map(|s| s.trim_end().to_string());
    match shape {
        PrShape::Promote => {
            let ahead: u64 = gitops::git(cwd, &["rev-list", "--count", &format!("{base_ref}..{head_ref}")])?.trim().parse().unwrap_or(0);
            if ahead == 0 {
                return Err(format!("Refused: origin/staging has nothing that origin/{main} lacks"));
            }
            let log = log_of(&format!("{base_ref}..{head_ref}"))?;
            // Commit subjects are repo text: inside a code block they cannot ping, link or
            // close issues (security review 2026-10-24, finding 8); backticks cannot end it.
            let list: String = log.lines().map(|l| format!("{}\n", l.replace('`', "'"))).collect();
            let more = if ahead as usize > MAX_PR_LOG { format!("... and {} more\n", ahead as usize - MAX_PR_LOG) } else { String::new() };
            let body = format!(
                "## Summary\n\nPromote `staging` to `{main}` ({ahead} commit(s)). Please merge with a merge commit, so `{main}` stays an ancestor of `staging`.\n\n```text\n{list}{more}```\n\nOpened from Colony (Git e CI/CD, Ship lane). The merge into `{main}` needs the operator's typed yes in Colony.\n"
            );
            Ok(PrPlan { shape, base: main.to_string(), head: "staging".into(), push_sha: None, title: format!("Promote staging to {main}"), body, log })
        }
        PrShape::StagingSync => {
            if gitops::git(cwd, &["merge-base", "--is-ancestor", &base_ref, &head_ref]).is_ok() {
                return Err(format!("Refused: origin/{main} is already an ancestor of origin/staging, nothing to sync"));
            }
            let sha = gitops::git(cwd, &["rev-parse", "--verify", &format!("{base_ref}^{{commit}}")])?.trim().to_string();
            if !is_hex_sha(&sha) {
                return Err(format!("Unexpected sha for origin/{main}: {sha}"));
            }
            let short = sha[..7].to_string();
            let head = format!("chore/sync-staging-{main}-{short}");
            if !valid_branch(&head) || branchrule::production_branch(cwd, &head).is_some() {
                return Err(format!("Refused: {head} is not a branch Colony pushes"));
            }
            let log = log_of(&format!("{head_ref}..{base_ref}"))?;
            let body = format!(
                "## Summary\n\nStaging fast-forward sync: brings `{main}` {short} onto `staging`, so `{main}` is an ancestor of `staging` again. The branch `{head}` is `origin/{main}` as is; no other changes.\n\nOpened from Colony (Git e CI/CD, Ship lane).\n"
            );
            Ok(PrPlan { shape, base: "staging".into(), head, push_sha: Some(sha), title: format!("chore: sync staging with {main} ({short})"), body, log })
        }
    }
}

/// The merge gate on one `gh pr view` answer (pure, unit-tested): `Err` when a fork PR
/// targets a production base (its head branch name, e.g. `staging`, is the fork's own and
/// proves nothing: security review 2026-10-24, finding 1), `Ok(Some(why))` when the typed
/// yes is needed.
pub fn merge_gate(number: u64, pr: &Value) -> Result<Option<String>, String> {
    let base = pr.get("baseRefName").and_then(Value::as_str).unwrap_or_default();
    let Some(why) = branchrule::request_production_reason(base) else { return Ok(None) };
    // A missing field counts as a fork: fail closed.
    if pr.get("isCrossRepository").and_then(Value::as_bool) != Some(false) {
        let owner = pr.pointer("/headRepositoryOwner/login").and_then(Value::as_str).unwrap_or("?");
        let head = pr.get("headRefName").and_then(Value::as_str).unwrap_or("?");
        return Err(format!("Refused: PR #{number} comes from another repository ({owner}:{head}) and targets {base}. A fork PR never merges into a production base from Colony"));
    }
    Ok(Some(format!("PR #{number} targets {base}: {why}")))
}

/// `Ok(Some(why))`: the action needs a typed yes. `Err`: never allowed on request.
fn production_gate(action: &Action, cwd: &Path) -> Result<Option<String>, String> {
    match action {
        Action::MergePr { number, .. } => {
            let pr = Forge::detect()?.json(cwd, &Op::PrView(*number))?;
            merge_gate(*number, &pr)
        }
        Action::PushBranch { branch } => {
            let b = branch.as_deref().ok_or("push-branch without a branch")?;
            match branchrule::request_production_reason(b) {
                Some(why) => Err(format!("Refused: {why}. Push a production branch yourself from the Git tab (typed yes)")),
                None => Ok(None),
            }
        }
        Action::RerunChecks { .. } => Ok(None),
        // Opening a PR merges nothing; the merge of the promote PR is its own merge-pr card,
        // with the typed yes. A plan Colony refuses (no staging flow, nothing to promote or
        // sync) is refused here, so the card cannot be approved.
        Action::OpenPr { shape } => pr_plan(*shape, cwd).map(|_| None),
    }
}

/// Run an approved action. `Err` carries the failure output.
fn execute(action: &Action, cwd: &Path, pin: Option<&Pin>) -> Result<String, String> {
    match action {
        Action::MergePr { number, method } => {
            let forge = Forge::detect()?;
            let pr = forge.json(cwd, &Op::PrView(*number))?;
            let (head, base) = merge_pin(&pr).ok_or_else(|| format!("PR #{number}: gh pr view has no head commit or base"))?;
            if let Some(Pin::Merge { head: h0, base: b0 }) = pin {
                if *b0 != base {
                    return Err(format!("Refused: PR #{number} now targets {base}, not {b0} as on the card. Deny it and file it again"));
                }
                // The head may have moved since the card: merge only what the card showed.
                return forge.run(cwd, &Op::Merge(*number, *method, Some(h0.clone())));
            }
            forge.run(cwd, &Op::Merge(*number, *method, Some(head)))
        }
        Action::RerunChecks { run: Some(id), .. } => Forge::detect()?.run(cwd, &Op::RerunFailed(*id)),
        Action::RerunChecks { pr, .. } => {
            let n = pr.ok_or("rerun-checks without a target")?;
            let forge = Forge::detect()?;
            let view = forge.json(cwd, &Op::PrView(n))?;
            let head = view.get("headRefName").and_then(Value::as_str).unwrap_or_default().to_string();
            let sha = view.get("headRefOid").and_then(Value::as_str).unwrap_or_default().to_string();
            let runs = forge.json(cwd, &Op::Runs { branch: Some(head.clone()) })?;
            let failed: Vec<u64> = runs
                .as_array()
                .into_iter()
                .flatten()
                .filter(|r| r.get("headSha").and_then(Value::as_str) == Some(sha.as_str()))
                .filter(|r| matches!(r.get("conclusion").and_then(Value::as_str), Some("failure" | "cancelled" | "timed_out" | "startup_failure")))
                .filter_map(|r| r.get("databaseId").and_then(Value::as_u64))
                .collect();
            if failed.is_empty() {
                return Err(format!("No failed runs on PR #{n}'s head commit ({head} {})", sha.get(..8).unwrap_or(&sha)));
            }
            let mut log = String::new();
            let mut ok = true;
            for id in failed {
                match forge.run(cwd, &Op::RerunFailed(id)) {
                    Ok(o) => log.push_str(&format!("run {id}: rerun requested\n{o}")),
                    Err(e) => {
                        ok = false;
                        log.push_str(&format!("run {id}: {e}\n"));
                    }
                }
            }
            if ok {
                Ok(log)
            } else {
                Err(log)
            }
        }
        Action::OpenPr { shape } => {
            // Re-derived at approval time; a plan that moved since the card refuses.
            let plan = pr_plan(*shape, cwd)?;
            if let Some(Pin::Plan(p0)) = pin {
                if *p0 != plan {
                    return Err("Refused: the branches moved since the card opened (origin/main or origin/staging changed). Deny it and open it again".into());
                }
            }
            let forge = Forge::detect()?;
            let mut log = String::new();
            if let Some(sha) = &plan.push_sha {
                // Never forced: a plain refspec push of the default branch's own tip to a new
                // non-production branch.
                log.push_str(&gitops::git(cwd, &[NO_EXT_PROTOCOL[0], NO_EXT_PROTOCOL[1], "push", "origin", &format!("{sha}:refs/heads/{}", plan.head)])?);
            }
            let out = forge.run(cwd, &Op::PrCreate { base: plan.base.clone(), head: plan.head.clone(), title: plan.title.clone(), body: plan.body.clone() }).map_err(|e| format!("{log}{e}"))?;
            log.push_str(&out);
            Ok(log)
        }
        Action::PushBranch { branch } => {
            let b = branch.as_deref().ok_or("push-branch without a branch")?;
            if !valid_branch(b) {
                return Err(format!("Not a branch name: {b}"));
            }
            gitops::git(cwd, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{b}")]).map_err(|_| format!("No local branch {b}"))?;
            if let Some(why) = branchrule::request_production_reason(b) {
                return Err(format!("Refused: {why}"));
            }
            // Never forced: no --force, no +refspec.
            match gitops::git(cwd, &["config", "--get", &format!("branch.{b}.remote")]).map(|s| s.trim().to_string()) {
                Ok(remote) if !remote.is_empty() && !remote.starts_with('-') => gitops::git(cwd, &[NO_EXT_PROTOCOL[0], NO_EXT_PROTOCOL[1], "push", &remote, b]),
                _ => gitops::git(cwd, &[NO_EXT_PROTOCOL[0], NO_EXT_PROTOCOL[1], "push", "-u", "origin", b]),
            }
        }
    }
}

/// What the card shows next to the request: the PR (title, base <- head, mergeable,
/// checks), the run, or the commits a push would send; and whether a typed yes is needed.
/// The head commit (40-hex) and base of a `gh pr view` answer.
fn merge_pin(pr: &Value) -> Option<(String, String)> {
    let head = pr.get("headRefOid").and_then(Value::as_str).filter(|h| is_hex_sha(h))?;
    let base = pr.get("baseRefName").and_then(Value::as_str).filter(|b| !b.is_empty())?;
    Some((head.to_string(), base.to_string()))
}

fn context(action: &Action, cwd: &Path) -> (Value, Option<Pin>) {
    let gate = production_gate(action, cwd);
    let (production, refused) = match &gate {
        Ok(p) => (p.clone(), None),
        Err(e) => (None, Some(e.clone())),
    };
    let mut out = json!({ "production": production, "refused": refused });
    let forge = Forge::detect();
    let pr_info = |n: u64| -> Value {
        match &forge {
            Ok(f) => json!({ "pr": f.json(cwd, &Op::PrView(n)).unwrap_or_else(|e| json!({ "error": e })), "checks": f.checks_text(cwd, n) }),
            Err(e) => json!({ "error": e }),
        }
    };
    let mut pin = None;
    let extra = match action {
        Action::MergePr { number, .. } => {
            let info = pr_info(*number);
            pin = info.get("pr").and_then(merge_pin).map(|(head, base)| Pin::Merge { head, base });
            info
        }
        Action::RerunChecks { pr: Some(n), .. } => pr_info(*n),
        Action::RerunChecks { run: Some(id), .. } => match &forge {
            Ok(f) => json!({ "run": f.json(cwd, &Op::RunView(*id)).unwrap_or_else(|e| json!({ "error": e })) }),
            Err(e) => json!({ "error": e }),
        },
        Action::RerunChecks { .. } => json!({}),
        Action::OpenPr { shape } => match pr_plan(*shape, cwd) {
            Ok(plan) => {
                pin = Some(Pin::Plan(plan.clone()));
                json!({ "prPlan": plan })
            }
            Err(_) => json!({}),
        },
        Action::PushBranch { branch } => {
            let b = branch.clone().unwrap_or_default();
            let upstream = gitops::git(cwd, &["rev-parse", "--abbrev-ref", &format!("{b}@{{u}}")]).ok().map(|s| s.trim().to_string());
            let range = upstream.as_ref().map(|u| format!("{u}..{b}")).unwrap_or_else(|| b.clone());
            let log = gitops::git(cwd, &["log", "--oneline", "-n", "30", &range, "--"]).unwrap_or_else(|e| e);
            json!({ "branch": b, "upstream": upstream, "log": log })
        }
    };
    if let (Some(o), Some(e)) = (out.as_object_mut(), extra.as_object()) {
        o.extend(e.clone());
    }
    (out, pin)
}

// ---- Tauri commands --------------------------------------------------------------------

pub type Shared = Arc<HostRequests>;

#[tauri::command]
pub fn host_requests_subscribe(hr: State<'_, Shared>, on_event: Channel<HostEvent>) -> Result<(), String> {
    let ev = HostEvent::Requests { items: hr.views(), spool: hr.spool.as_ref().map(|p| p.display().to_string()) };
    on_event.send(ev).map_err(|e| e.to_string())?;
    hr.subs.lock().map_err(|_| "host request lock poisoned")?.push(on_event);
    Ok(())
}

#[tauri::command(async)]
pub fn host_request_context(hr: State<'_, Shared>, id: String) -> Result<Value, String> {
    let p = hr.get(&id)?;
    let (ctx, pin) = context(&p.action, Path::new(&p.req.cwd));
    hr.pin_once(&id, pin);
    Ok(ctx)
}

/// The PR's diff (merge-pr, or rerun-checks of a PR) or the commits a push would send.
#[tauri::command(async)]
pub fn host_request_diff(hr: State<'_, Shared>, id: String) -> Result<String, String> {
    let p = hr.get(&id)?;
    let cwd = PathBuf::from(&p.req.cwd);
    match &p.action {
        Action::MergePr { number, .. } | Action::RerunChecks { pr: Some(number), .. } => Forge::detect()?.run(&cwd, &Op::PrDiff(*number)),
        Action::PushBranch { branch: Some(b) } => {
            let upstream = gitops::git(&cwd, &["rev-parse", "--abbrev-ref", &format!("{b}@{{u}}")]).map(|s| s.trim().to_string()).unwrap_or_else(|_| format!("origin/{b}"));
            gitops::git(&cwd, &["diff", "--no-ext-diff", "--no-textconv", "--stat", "--patch", &format!("{upstream}...{b}"), "--"])
        }
        Action::OpenPr { shape } => {
            let plan = pr_plan(*shape, &cwd)?;
            let head = plan.push_sha.clone().unwrap_or_else(|| format!("refs/remotes/origin/{}", plan.head));
            gitops::git(&cwd, &["diff", "--no-ext-diff", "--no-textconv", "--stat", &format!("refs/remotes/origin/{}...{head}", plan.base), "--"])
        }
        _ => Err("No diff for this request".into()),
    }
}

/// Open the request's PR in the browser through the forge CLI (`gh pr view N --web`).
#[tauri::command(async)]
pub fn host_request_open(hr: State<'_, Shared>, id: String) -> Result<(), String> {
    let p = hr.get(&id)?;
    match &p.action {
        Action::MergePr { number, .. } | Action::RerunChecks { pr: Some(number), .. } => Forge::detect()?.run(Path::new(&p.req.cwd), &Op::PrWeb(*number)).map(|_| ()),
        _ => Err("This request has no pull request to open".into()),
    }
}

/// Only an operator click in the card reaches this.
#[tauri::command(async)]
pub fn host_request_approve(hr: State<'_, Shared>, id: String, typed_confirm: Option<String>) -> Result<Decision, String> {
    hr.approve(&id, typed_confirm.as_deref())
}

#[tauri::command]
pub fn host_request_deny(hr: State<'_, Shared>, id: String, reason: Option<String>) -> Result<(), String> {
    hr.deny(&id, reason)
}

/// The operator's own request from the UI (e.g. Merge in the PR list), in the opened folder.
#[tauri::command]
pub fn host_request_local(hr: State<'_, Shared>, state: State<'_, AppState>, kind: String, args: Value) -> Result<String, String> {
    let root = workspace::workspace_root(&state)?;
    hr.add_local(Action::from_parts(&kind, &args)?, &root)
}

// ---- tests -----------------------------------------------------------------------------

#[cfg(test)]
pub(crate) fn test_dir(tag: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let d = std::env::temp_dir().join(format!("colony-test-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d.canonicalize().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|x| x.to_string()).collect()
    }

    fn parse(xs: &[&str]) -> Result<CliRequest, String> {
        parse_cli(&s(xs))
    }

    #[test]
    fn allowlist_parsing() {
        let r = parse(&["merge-pr", "12", "--reason", "CI green"]).unwrap();
        assert_eq!(r.action, Action::MergePr { number: 12, method: MergeMethod::Squash });
        assert_eq!((r.reason.as_str(), r.timeout), ("CI green", DEFAULT_TIMEOUT));
        assert_eq!(parse(&["merge-pr", "#7", "--method=rebase"]).unwrap().action, Action::MergePr { number: 7, method: MergeMethod::Rebase });
        assert_eq!(parse(&["rerun-checks", "123456"]).unwrap().action, Action::RerunChecks { run: Some(123456), pr: None });
        assert_eq!(parse(&["rerun-checks", "--pr", "9"]).unwrap().action, Action::RerunChecks { run: None, pr: Some(9) });
        assert_eq!(parse(&["push-branch"]).unwrap().action, Action::PushBranch { branch: None });
        assert_eq!(parse(&["push-branch", "feat/x-1", "--timeout", "90s"]).unwrap().timeout, Duration::from_secs(90));
        assert_eq!(parse(&["merge-pr", "1", "--timeout=2h"]).unwrap().timeout, Duration::from_secs(7200));
        assert_eq!(parse(&["open-pr", "promote"]).unwrap().action, Action::OpenPr { shape: PrShape::Promote });
        assert_eq!(parse(&["open-pr", "staging-sync", "--reason", "after v1"]).unwrap().action, Action::OpenPr { shape: PrShape::StagingSync });
    }

    #[test]
    fn allowlist_refusals() {
        for bad in [
            &[][..],
            &["run", "rm -rf /"],
            &["hook", "pre-push"],
            &["merge-pr"],
            &["merge-pr", "0"],
            &["merge-pr", "12x"],
            &["merge-pr", "12", "13"],
            &["merge-pr", "12", "--method", "admin"],
            &["merge-pr", "12", "--admin"],
            &["merge-pr", "12", "--pr", "3"],
            &["rerun-checks"],
            &["rerun-checks", "1", "--pr", "2"],
            &["rerun-checks", "1", "--method", "squash"],
            &["push-branch", "a", "b"],
            &["push-branch", "--force"],
            &["push-branch", "-f"],
            &["push-branch", "+main"],
            &["push-branch", "a..b"],
            &["push-branch", "x;rm"],
            &["merge-pr", "1", "--reason"],
            &["merge-pr", "1", "--timeout", "0"],
            &["merge-pr", "1", "--timeout", "25h"],
            &["open-pr"],
            &["open-pr", "main"],
            &["open-pr", "promote", "staging-sync"],
            &["open-pr", "promote", "--method", "merge"],
            &["open-pr", "promote", "--pr", "3"],
            &["open-pr", "--base", "main", "--head", "feat/x"],
            &["open-pr", "Promote"],
        ] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn request_files_revalidate_the_allowlist() {
        let a = Action::MergePr { number: 4, method: MergeMethod::Merge };
        let (kind, args) = a.to_parts();
        assert_eq!((kind.as_str(), &args), ("merge-pr", &json!({ "number": 4, "method": "merge" })));
        assert_eq!(Action::from_parts(&kind, &args).unwrap(), a);
        assert!(Action::from_parts("shell", &json!({ "cmd": "x" })).is_err());
        assert!(Action::from_parts("merge-pr", &json!({ "number": 4, "admin": true })).is_err());
        assert!(Action::from_parts("push-branch", &json!({ "branch": "--force" })).is_err());
        assert!(Action::from_parts("rerun-checks", &json!({ "run": 1, "pr": 2 })).is_err());
        let o = Action::OpenPr { shape: PrShape::StagingSync };
        assert_eq!(o.to_parts(), ("open-pr".to_string(), json!({ "shape": "staging-sync" })));
        assert_eq!(Action::from_parts("open-pr", &json!({ "shape": "promote" })).unwrap(), Action::OpenPr { shape: PrShape::Promote });
        // Fixed shape only: no free base/head/title from a request file.
        assert!(Action::from_parts("open-pr", &json!({ "shape": "promote", "base": "prod" })).is_err());
        assert!(Action::from_parts("open-pr", &json!({ "shape": "anything" })).is_err());
        assert!(Action::from_parts("open-pr", &json!({ "base": "main", "head": "x" })).is_err());
    }

    /// A repository with one commit; the test sets origin/* remote-tracking refs itself.
    fn flow_repo() -> (PathBuf, impl Fn(&[&str]) -> String) {
        let d = repo();
        let d2 = d.clone();
        let g = move |args: &[&str]| gitops::git(&d2, args).unwrap().trim().to_string();
        mk(&g, "base");
        (d, g)
    }

    fn mk(g: &dyn Fn(&[&str]) -> String, msg: &str) -> String {
        g(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", msg]);
        g(&["rev-parse", "HEAD"])
    }

    #[test]
    fn merge_pin_reads_head_and_base() {
        let oid = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(merge_pin(&json!({ "headRefOid": oid, "baseRefName": "main" })), Some((oid.to_string(), "main".to_string())));
        assert_eq!(merge_pin(&json!({ "headRefOid": "--admin", "baseRefName": "main" })), None);
        assert_eq!(merge_pin(&json!({ "headRefOid": oid })), None);
    }

    #[test]
    fn merge_gate_needs_yes_for_main_and_refuses_forks() {
        let pr = |base: &str, cross: Value| json!({ "baseRefName": base, "headRefName": "staging", "isCrossRepository": cross, "headRepositoryOwner": { "login": "mallory" } });
        assert_eq!(merge_gate(1, &pr("staging", json!(true))).unwrap(), None, "a fork PR into staging is an ordinary card");
        assert!(merge_gate(1, &pr("main", json!(false))).unwrap().unwrap().contains("targets main"));
        let e = merge_gate(1, &pr("main", json!(true))).unwrap_err();
        assert!(e.contains("mallory:staging") && e.starts_with("Refused"), "{e}");
        assert!(merge_gate(1, &pr("release", Value::Null)).is_err(), "unknown origin fails closed");
    }

    #[test]
    fn open_pr_plans_from_local_refs_only() {
        let (cwd, g) = flow_repo();
        let base = g(&["rev-parse", "HEAD"]);
        // No origin/staging: no staging flow, both shapes refused (and so is the card).
        assert!(pr_plan(PrShape::Promote, &cwd).unwrap_err().contains("no origin/staging"));
        g(&["update-ref", "refs/remotes/origin/main", &base]);
        g(&["update-ref", "refs/remotes/origin/staging", &base]);
        assert!(pr_plan(PrShape::Promote, &cwd).unwrap_err().contains("nothing that origin/main lacks"));
        assert!(pr_plan(PrShape::StagingSync, &cwd).unwrap_err().contains("already an ancestor"));
        assert!(production_gate(&Action::OpenPr { shape: PrShape::Promote }, &cwd).is_err());

        // staging two ahead (one subject is hostile text): the promote plan is fixed fields.
        let s1 = mk(&g, "feat: one");
        g(&["update-ref", "refs/remotes/origin/staging", &s1]);
        let s2 = mk(&g, "fix: $(curl x) `two`; --admin");
        g(&["update-ref", "refs/remotes/origin/staging", &s2]);
        let p = pr_plan(PrShape::Promote, &cwd).unwrap();
        assert_eq!((p.base.as_str(), p.head.as_str(), p.title.as_str(), p.push_sha.as_deref()), ("main", "staging", "Promote staging to main", None));
        assert!(p.body.contains("(2 commit(s))") && p.body.contains("merge commit") && p.body.contains("fix: $(curl x) 'two'; --admin") && p.body.contains("```text\n"));
        assert!(!p.body.to_lowercase().contains("co-authored") && !p.body.contains("Generated with"));
        assert_eq!(p.log.lines().count(), 2);
        assert_eq!(production_gate(&Action::OpenPr { shape: PrShape::Promote }, &cwd).unwrap(), None, "opening a PR needs no typed yes");

        // main gets a merge commit staging lacks: the sync plan pushes main's own tip.
        g(&["checkout", "-q", "--detach", &base]);
        let m = mk(&g, "Merge staging (release)");
        g(&["update-ref", "refs/remotes/origin/main", &m]);
        let p = pr_plan(PrShape::StagingSync, &cwd).unwrap();
        assert_eq!((p.base.as_str(), p.push_sha.as_deref()), ("staging", Some(m.as_str())));
        assert_eq!(p.head, format!("chore/sync-staging-main-{}", &m[..7]));
        assert!(valid_branch(&p.head) && branchrule::production_branch(&cwd, &p.head).is_none());
        assert_eq!(p.title, format!("chore: sync staging with main ({})", &m[..7]));

        // The card pinned this plan: once origin/main moves, Approve refuses before any push.
        let m2 = mk(&g, "another main commit");
        g(&["update-ref", "refs/remotes/origin/main", &m2]);
        let e = execute(&Action::OpenPr { shape: PrShape::StagingSync }, &cwd, Some(&Pin::Plan(p))).unwrap_err();
        assert!(e.contains("moved since the card"), "{e}");
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn timestamps_and_ids() {
        assert_eq!(iso(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(iso(UNIX_EPOCH + Duration::from_secs(951_782_400 + 3661)), "2000-02-29T01:01:01Z");
        let id = nonce().unwrap();
        assert!(valid_id(&id), "{id}");
        assert!(!valid_id("../../etc/passwd") && !valid_id(&id.to_uppercase()));
    }

    fn repo() -> PathBuf {
        let d = test_dir("repo");
        gitops::git(&d, &["init", "-q", "-b", "main"]).unwrap();
        d
    }

    fn spool() -> PathBuf {
        let d = test_dir("spool");
        std::fs::write(d.join(HOST_PID_FILE), std::process::id().to_string()).unwrap();
        d
    }

    const FAST: Duration = Duration::from_millis(20);

    /// Run the CLI in a thread and wait until the host side sees its card.
    fn file(hr: &HostRequests, sp: &Path, cwd: &Path, args: &[&str]) -> (std::thread::JoinHandle<i32>, String) {
        let (args, sp2, cwd2) = (s(args), sp.to_path_buf(), cwd.to_path_buf());
        let cli = std::thread::spawn(move || cli_run(&args, Some(sp2), &cwd2, FAST));
        for _ in 0..250 {
            hr.scan();
            if let Some(v) = hr.views().first() {
                return (cli, v.id.clone());
            }
            std::thread::sleep(FAST);
        }
        panic!("no card");
    }

    #[test]
    fn spool_round_trip_deny_succeed_fail() {
        let (sp, cwd) = (spool(), repo());
        let hr = HostRequests::with_spool(sp.clone());

        let (cli, id) = file(&hr, &sp, &cwd, &["merge-pr", "5", "--reason", "ready"]);
        let v = &hr.views()[0];
        assert_eq!((v.kind.as_str(), v.reason.as_str(), v.origin, v.cwd.as_str()), ("merge-pr", "ready", Origin::Agent, cwd.to_str().unwrap()));
        assert!(request_path(&sp, &id).exists());
        hr.deny(&id, Some("not today".into())).unwrap();
        assert_eq!(cli.join().unwrap(), EXIT_DENIED);
        assert!(hr.views().is_empty());
        assert!(std::fs::read_dir(&sp).unwrap().flatten().all(|e| e.file_name() == HOST_PID_FILE), "spool left clean");

        for (outcome, code) in [(Outcome::Succeeded, EXIT_OK), (Outcome::Failed, EXIT_FAILED)] {
            let (cli, id) = file(&hr, &sp, &cwd, &["rerun-checks", "77"]);
            let p = hr.claim(&id).unwrap();
            assert!(!request_path(&sp, &id).exists() && running_path(&sp, &id).exists());
            hr.finish(&p, outcome, None, "gh output".into());
            assert_eq!(cli.join().unwrap(), code);
        }
    }

    #[test]
    fn cli_exit_codes_without_a_host() {
        let cwd = repo();
        assert_eq!(cli_run(&s(&["merge-pr", "1"]), None, &cwd, FAST), EXIT_USAGE);
        assert_eq!(cli_run(&s(&["shell", "ls"]), Some(spool()), &cwd, FAST), EXIT_USAGE);
        let dead = test_dir("dead");
        std::fs::write(dead.join(HOST_PID_FILE), "2147483646").unwrap();
        assert_eq!(cli_run(&s(&["merge-pr", "1"]), Some(dead), &cwd, FAST), EXIT_USAGE);
        assert_eq!(cli_run(&s(&["--help"]), None, &cwd, FAST), EXIT_OK);
    }

    #[test]
    fn cli_times_out_and_withdraws() {
        let (sp, cwd) = (spool(), repo());
        let hr = HostRequests::with_spool(sp.clone());
        let (cli, id) = file(&hr, &sp, &cwd, &["merge-pr", "3", "--timeout", "1"]);
        assert_eq!(cli.join().unwrap(), EXIT_TIMEOUT);
        assert!(!request_path(&sp, &id).exists());
        hr.scan();
        assert!(hr.views().is_empty(), "a withdrawn request leaves the cards");
        assert!(hr.claim(&id).is_err());
    }

    #[test]
    fn push_branch_pins_the_branch_and_refuses_production() {
        let (sp, cwd) = (spool(), repo());
        gitops::git(&cwd, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i"]).unwrap();
        gitops::git(&cwd, &["checkout", "-q", "-b", "feat/y"]).unwrap();
        let hr = HostRequests::with_spool(sp.clone());
        let (cli, id) = file(&hr, &sp, &cwd, &["push-branch"]);
        assert_eq!(hr.views()[0].args, json!({ "branch": "feat/y" }));
        hr.deny(&id, None).unwrap();
        assert_eq!(cli.join().unwrap(), EXIT_DENIED);
        // `release` is always production: refused before anything reaches the spool.
        assert_eq!(cli_run(&s(&["push-branch", "release"]), Some(sp.clone()), &cwd, FAST), EXIT_USAGE);
        assert!(production_gate(&Action::PushBranch { branch: Some("release".into()) }, &cwd).is_err());
    }

    #[test]
    fn forged_or_invalid_files_are_refused() {
        let (sp, cwd) = (spool(), repo());
        let hr = HostRequests::with_spool(sp.clone());
        let id = nonce().unwrap();
        let forged = json!({ "v": 1, "id": id, "kind": "shell", "args": { "cmd": "rm -rf /" }, "cwd": cwd, "pid": std::process::id(), "createdAt": now() });
        std::fs::write(request_path(&sp, &id), forged.to_string()).unwrap();
        let outside = nonce().unwrap();
        let notrepo = test_dir("notrepo");
        let bad_cwd = json!({ "v": 1, "id": outside, "kind": "merge-pr", "args": { "number": 1 }, "cwd": notrepo, "pid": std::process::id(), "createdAt": now() });
        std::fs::write(request_path(&sp, &outside), bad_cwd.to_string()).unwrap();
        hr.scan();
        assert!(hr.views().is_empty());
        for i in [&id, &outside] {
            let r = take_response(&sp, i).expect("refusal response");
            assert_eq!(r.outcome, Outcome::Denied);
            assert!(r.reason.unwrap().starts_with("Colony refused the request"));
        }
        // A forged response file cannot approve: Colony never reads responses.
        let (cli, id) = file(&hr, &sp, &cwd, &["merge-pr", "8"]);
        write_response(&sp, &id, Outcome::Succeeded, None, "forged".into()).unwrap();
        assert_eq!(cli.join().unwrap(), EXIT_OK, "the forged answer only fools the requester");
        hr.scan();
        assert!(hr.views().is_empty(), "and the card leaves without anything being executed");
    }
}
