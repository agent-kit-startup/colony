//! Terminal-tab launches the cockpit offers next to driver runs:
//!
//! - `interactive`: the unmodified vendor agent CLI (`claude` or `codex`) in a PTY tab in
//!   the opened folder, on the user's own login. Colony passes no credentials and reads
//!   none: the child inherits the environment exactly like the shell tab does. An optional
//!   first prompt is one allowlisted kit slash command (e.g. `/run-plan <plan>`), passed as
//!   the CLI's own positional prompt argument. Instead of a prompt it may resume a saved
//!   session of the folder (chats.rs): `claude --resume <session uuid>`, the id checked
//!   as a UUID here before it reaches argv.
//! - `run-plan-all`: `agent-kit run-plan-all` in a PTY tab, the fallback for an engine whose
//!   driver protocol is below 1.2.0 (or unknown): such a kit has no driver mode for the
//!   queue runner, so its numbered-list gates are answered in that terminal. From 1.2.0 the
//!   queue starts as a driver run instead (agent.rs `queue_mode`, `agent_start` with
//!   command `run-plan-all`), and its gates reach the Inbox.
//!
//! `/git-prod`, `/kit-prod` and any other slash command stay out of the allowlist.

use serde::Serialize;

use crate::{agent, chats, tools};

/// Slash commands a cockpit button may hand to an interactive agent as its first prompt.
/// `agent-kit-onboard`, `start-project` and `backlog-add` are the first-run path: they run
/// only as an interactive agent in a terminal tab, so their own Asks (CI/CD config, hooks,
/// remotes, scaffold: onboard Hard Stop 3; the plan and backlog write gates) are answered
/// there by the user. Colony never answers or auto-applies them. `backlog-edit`,
/// `archive-plan`, `backlog-cancel` and `backlog-delete` are the plan CRUD dropdown
/// (src/plancrud.ts; commands-catalog ADR 2026-10-22 point 4, amend 2026-10-26): each asks
/// its own confirmation before it writes and stops on the active plan.
const PROMPT_SLASH: &[&str] = &[
    "run-plan",
    "continue-plan",
    "backlog-edit",
    "archive-plan",
    "backlog-cancel",
    "backlog-delete",
    "plan-review-triage",
    "field-report-resolve",
    "run-plan-all",
    "handoff",
    "summary",
    "agent-kit-onboard",
    "start-project",
    "backlog-add",
];

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TermLaunch {
    pub argv: Vec<String>,
    pub label: String,
    /// The vendor CLI or kit binary that will run (shown in the tab tooltip).
    pub bin: String,
    pub note: String,
}

/// A slash name Colony may hand to an interactive agent (the command palette's "Run").
pub fn runnable(name: &str) -> bool {
    PROMPT_SLASH.contains(&name)
}

/// `/name` or `/name <arg>`, where `name` is allowlisted and `arg` is one plain token.
pub fn valid_prompt(p: &str) -> bool {
    let Some(rest) = p.strip_prefix('/') else { return false };
    let (name, arg) = match rest.split_once(' ') {
        Some((n, a)) => (n, Some(a)),
        None => (rest, None),
    };
    if !PROMPT_SLASH.contains(&name) {
        return false;
    }
    match arg {
        None => true,
        Some(a) => {
            !a.is_empty()
                && a.len() <= 240
                && !a.starts_with('-')
                && !a.split('/').any(|seg| seg == "..")
                && a.chars().all(|c| c.is_ascii_alphanumeric() || "._:/-".contains(c))
        }
    }
}

/// The vendor CLI for an engine choice: `claude` and `codex` map to themselves; any other
/// engine (cursor-*, auto) opens whichever of `claude`, `codex` is on PATH.
fn vendor_for(engine: &str, find: &dyn Fn(&str) -> Option<String>) -> Result<(String, String, String), String> {
    let order: &[&str] = match engine {
        "claude" => &["claude"],
        "codex" => &["codex"],
        _ => &["claude", "codex"],
    };
    for name in order {
        if let Some(bin) = find(name) {
            let note = if order.len() > 1 { format!("{engine} has no interactive vendor CLI here: opened {name}") } else { String::new() };
            return Ok(((*name).to_string(), bin, note));
        }
    }
    Err(format!("{} not found on PATH", order.join(" or ")))
}

fn plan(kind: &str, engine: &str, model: Option<&str>, prompt: Option<&str>, resume: Option<&str>, dry_run: bool, find: &dyn Fn(&str) -> Option<String>) -> Result<TermLaunch, String> {
    let model = model.map(str::trim).filter(|m| !m.is_empty());
    if let Some(m) = model {
        if !agent::valid_model(m) {
            return Err(format!("Not a model id: {m}"));
        }
    }
    if resume.is_some() && kind != "interactive" {
        return Err(format!("{kind} cannot resume a session"));
    }
    match kind {
        "interactive" => {
            let prompt = prompt.map(str::trim).filter(|p| !p.is_empty());
            if let Some(p) = prompt {
                if !valid_prompt(p) {
                    return Err(format!("Not an allowlisted kit command: {p}"));
                }
            }
            let resume = resume.map(str::trim).filter(|r| !r.is_empty());
            if let Some(r) = resume {
                if !chats::is_session_id(r) {
                    return Err(format!("Not a session id: {r}"));
                }
                if prompt.is_some() || engine != "claude" {
                    return Err("Resume opens claude with the session alone (no prompt, no other engine)".into());
                }
            }
            let (name, bin, note) = vendor_for(engine, find)?;
            let mut argv = vec![bin.clone()];
            if let Some(r) = resume {
                // The resumed session keeps its own model.
                argv.extend(["--resume".to_string(), r.to_string()]);
                return Ok(TermLaunch { argv, label: format!("{name} --resume {}", &r[..8]), bin, note });
            }
            if let Some(m) = model {
                argv.extend([if name == "codex" { "-m" } else { "--model" }.to_string(), m.to_string()]);
            }
            if let Some(p) = prompt {
                argv.push(p.to_string());
            }
            let label = match prompt {
                Some(p) => format!("{name} {}", p.split(' ').next().unwrap_or(p)),
                None => format!("{name} (interactive)"),
            };
            Ok(TermLaunch { argv, label, bin, note })
        }
        "run-plan-all" => {
            if !agent::BACKENDS.contains(&engine) {
                return Err(format!("Unknown backend: {engine}"));
            }
            let bin = find("agent-kit").ok_or("No Agent Kit engine (Run → Engine…) and no agent-kit on PATH")?;
            // A managed engine runs as `<node> <engine>/dist/index.js` (engine.rs).
            let mut argv = vec![bin.clone()];
            argv.extend(find("agent-kit-entry"));
            argv.extend(["run-plan-all".into(), "--backend".into(), engine.into()]);
            if let Some(m) = model {
                argv.extend(["--model".to_string(), m.to_string()]);
            }
            if dry_run {
                argv.push("--dry-run".into());
            }
            Ok(TermLaunch { argv, label: format!("run-plan-all · {engine}"), bin, note: "Queue runner: answer its numbered-list gates in this terminal (this engine has no run-plan-all driver mode)".into() })
        }
        _ => Err(format!("Unknown launch: {kind}")),
    }
}

fn find_real(name: &str) -> Option<String> {
    let found = match name {
        "agent-kit" => crate::engine::kit_command().ok().map(|k| k.program),
        "agent-kit-entry" => crate::engine::kit_command().ok().and_then(|k| k.args.into_iter().next()),
        "claude" => tools::find_bin("claude", Some("COLONY_CLAUDE_BIN")),
        "codex" => tools::find_bin("codex", Some("COLONY_CODEX_BIN")),
        _ => None,
    };
    found.map(|p| p.display().to_string())
}

/// Resolve the argv for a terminal-tab launch; the page then spawns it with `pty_spawn`
/// (cwd = the opened folder).
#[tauri::command]
pub fn term_launch(kind: String, engine: String, model: Option<String>, prompt: Option<String>, resume: Option<String>, dry_run: Option<bool>) -> Result<TermLaunch, String> {
    if kind == "run-plan-all" {
        agent::check_engine(&engine)?;
    }
    plan(&kind, &engine, model.as_deref(), prompt.as_deref(), resume.as_deref(), dry_run.unwrap_or(false), &find_real)
}

#[cfg(test)]
mod tests {
    use super::{plan, valid_prompt, PROMPT_SLASH};

    fn find(name: &str) -> Option<String> {
        match name {
            "claude" => Some("/bin/claude".into()),
            "agent-kit" => Some("/bin/agent-kit".into()),
            _ => None,
        }
    }

    #[test]
    fn prompts() {
        for ok in ["/run-plan", "/run-plan demo.plan.md", "/backlog-edit x-2026.plan.md", "/plan-review-triage .cursor/memory/plan-monitor-x.md", "/field-report-resolve attention:report:x"] {
            assert!(valid_prompt(ok), "{ok}");
        }
        for bad in ["run-plan", "/git-prod", "/kit-prod", "/run-plan a b", "/run-plan ../x", "/run-plan --flag", "/run-plan x;rm", "/run-plan $(id)", "/run-plan "] {
            assert!(!valid_prompt(bad), "{bad}");
        }
    }

    #[test]
    fn never_prod() {
        for name in ["git-prod", "kit-prod"] {
            assert!(!PROMPT_SLASH.contains(&name), "{name}");
            assert!(!super::runnable(name), "{name}");
        }
    }

    /// The names after `/^\/` in the regex literal `const <name> = /^\/...` of a page source:
    /// one name, or an alternation `(a|b|c)`.
    const FIRST_RUN: [&str; 3] = ["agent-kit-onboard", "start-project", "backlog-add"];

    fn regex_names(src: &str, constant: &str) -> Vec<String> {
        let start = format!("const {constant} = /^\\/");
        let at = src.find(&start).unwrap_or_else(|| panic!("{constant} not found")) + start.len();
        let rest = &src[at..];
        let body = match rest.strip_prefix('(') {
            Some(r) => &r[..r.find(')').expect("closing paren")],
            None => &rest[..rest.find(|c: char| !(c.is_ascii_lowercase() || c == '-')).unwrap_or(rest.len())],
        };
        body.split('|').map(str::to_string).collect()
    }

    /// The page's own allowlists (Inbox "Ask agent", Mission Control run-plan) may only name
    /// commands this Rust check lets through; it stays the single gate.
    #[test]
    fn page_allowlists_within_prompt_slash() {
        let inbox = regex_names(include_str!("../../src/inbox.ts"), "ASKABLE");
        let mc = regex_names(include_str!("../../src/mcactions.ts"), "RUN_PLAN");
        assert!(inbox.len() >= 5, "{inbox:?}");
        assert_eq!(mc, ["run-plan"]);
        for name in inbox.iter().chain(&mc) {
            assert!(PROMPT_SLASH.contains(&name.as_str()), "{name} is not in PROMPT_SLASH");
        }
        for name in FIRST_RUN {
            assert!(inbox.iter().any(|n| n == name), "{name} is not in ASKABLE");
        }
    }

    /// The plan CRUD dropdown (src/plancrud.ts; ADR 2026-10-24 amend 2026-10-26, Ask B =
    /// Edit, Archive, Cancel, Delete) hands `/<command> <plan file>` to the interactive agent:
    /// each of its commands is allowlisted, takes the plan file, and the Inbox may ask it too.
    #[test]
    fn plan_crud_commands_runnable() {
        let src = include_str!("../../src/plancrud.ts");
        let names: Vec<&str> = src.split("prompt: `/").skip(1).map(|r| r.split(' ').next().unwrap()).collect();
        assert_eq!(names, ["backlog-edit", "archive-plan", "backlog-cancel", "backlog-delete"]);
        let inbox = regex_names(include_str!("../../src/inbox.ts"), "ASKABLE");
        for name in names {
            assert!(super::runnable(name), "{name}");
            assert!(valid_prompt(&format!("/{name} old-idea-2026-10-01.plan.md")), "{name}");
            assert!(!valid_prompt(&format!("/{name} ../HANDOFF.md")) && !valid_prompt(&format!("/{name} a.plan.md --yes")), "{name}");
            assert!(inbox.iter().any(|n| n == name), "{name} is not in ASKABLE");
            let t = plan("interactive", "claude", None, Some(&format!("/{name} x.plan.md")), None, false, &find).unwrap();
            assert_eq!(t.argv, ["/bin/claude", &format!("/{name} x.plan.md")]);
        }
    }

    /// The first-run commands (onboarding, a first plan, the backlog) run from the IDE as an
    /// interactive agent, bare or with one plain argument, like the other allowlisted names.
    #[test]
    fn first_run_commands_runnable() {
        for name in FIRST_RUN {
            assert!(super::runnable(name), "{name}");
            assert!(valid_prompt(&format!("/{name}")), "{name}");
            assert!(!valid_prompt(&format!("/{name} --yes")), "{name}");
            assert!(!valid_prompt(&format!("/{name} a b")), "{name}");
            let t = plan("interactive", "claude", None, Some(&format!("/{name}")), None, false, &find).unwrap();
            assert_eq!(t.argv, ["/bin/claude", &format!("/{name}")]);
        }
    }

    /// The palette's Claude Code section (src/claude-builtins.ts) is a cited, dated, copy-only
    /// list: valid unique names, none a "Run" name, the source URL and check date present.
    #[test]
    fn claude_builtins_copy_only() {
        let src = include_str!("../../src/claude-builtins.ts");
        assert!(src.contains("export const SOURCE_URL = \"https://code.claude.com/docs/en/commands\";"));
        let date = src.split("export const VERIFIED_AT = \"").nth(1).and_then(|r| r.split('"').next()).expect("VERIFIED_AT");
        assert!(date.len() == 10 && date.as_bytes()[4] == b'-' && date.as_bytes()[7] == b'-' && date.replace('-', "").bytes().all(|c| c.is_ascii_digit()), "{date}");
        let names: Vec<&str> = src.split("{ name: \"").skip(1).map(|r| r.split('"').next().unwrap()).collect();
        assert!(names.len() >= 30, "{}", names.len());
        let mut seen = std::collections::HashSet::new();
        for name in &names {
            let b = name.as_bytes();
            assert!(!b.is_empty() && b.len() <= 64 && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-'), "{name}");
            assert!(seen.insert(*name), "duplicate {name}");
            assert!(!PROMPT_SLASH.contains(name) && !super::runnable(name), "{name} would run");
        }
        for core in ["model", "context", "compact", "memory", "agents", "mcp", "review"] {
            assert!(names.contains(&core), "{core} missing");
        }
    }

    #[test]
    fn interactive_argv() {
        let l = plan("interactive", "claude", None, Some("/run-plan demo.plan.md"), None, false, &find).unwrap();
        assert_eq!(l.argv, vec!["/bin/claude", "/run-plan demo.plan.md"]);
        assert_eq!(l.label, "claude /run-plan");
        // cursor-* falls back to the vendor CLI that is on PATH.
        let l = plan("interactive", "cursor-agent", Some("sonnet"), None, None, false, &find).unwrap();
        assert_eq!(l.argv, vec!["/bin/claude", "--model", "sonnet"]);
        assert!(!l.note.is_empty());
        assert!(plan("interactive", "codex", None, None, None, false, &find).is_err());
        assert!(plan("interactive", "claude", None, Some("/git-prod"), None, false, &find).is_err());
    }

    #[test]
    fn resume_argv() {
        let id = "0b5c3a52-1f6e-4c1a-9d1e-6a2f3b4c5d6e";
        let l = plan("interactive", "claude", Some("sonnet"), None, Some(id), false, &find).unwrap();
        assert_eq!(l.argv, vec!["/bin/claude", "--resume", id]);
        assert_eq!(l.label, "claude --resume 0b5c3a52");
        for bad in ["--help", "0b5c3a52", "0b5c3a52-1f6e-4c1a-9d1e-6a2f3b4c5d6e --dangerously-skip-permissions", "$(id)", "../0b5c3a52-1f6e-4c1a-9d1e-6a2f3b4c5"] {
            assert!(plan("interactive", "claude", None, None, Some(bad), false, &find).is_err(), "{bad}");
        }
        // Only claude, and never together with a prompt.
        assert!(plan("interactive", "cursor-agent", None, None, Some(id), false, &find).is_err());
        assert!(plan("interactive", "codex", None, None, Some(id), false, &find).is_err());
        assert!(plan("interactive", "claude", None, Some("/run-plan"), Some(id), false, &find).is_err());
        assert!(plan("run-plan-all", "claude", None, None, Some(id), false, &find).is_err());
    }

    #[test]
    fn run_plan_all_argv() {
        let l = plan("run-plan-all", "codex", None, None, None, true, &find).unwrap();
        assert_eq!(l.argv, vec!["/bin/agent-kit", "run-plan-all", "--backend", "codex", "--dry-run"]);
        assert!(plan("run-plan-all", "nope", None, None, None, false, &find).is_err());
        assert!(plan("run-plan-all", "claude", Some("--x"), None, None, false, &find).is_err());
        // Managed engine: node plus the engine entry.
        let managed = |name: &str| match name {
            "agent-kit" => Some("/data/runtime/node".to_string()),
            "agent-kit-entry" => Some("/data/engine/6.3.0/dist/index.js".to_string()),
            _ => None,
        };
        let l = plan("run-plan-all", "claude", None, None, None, false, &managed).unwrap();
        assert_eq!(l.argv, vec!["/data/runtime/node", "/data/engine/6.3.0/dist/index.js", "run-plan-all", "--backend", "claude"]);
    }
}
