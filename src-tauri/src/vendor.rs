//! Terminal-tab launches the cockpit offers next to driver runs:
//!
//! - `interactive`: the unmodified vendor agent CLI (`claude` or `codex`) in a PTY tab in
//!   the opened folder, on the user's own login. Colony passes no credentials and reads
//!   none: the child inherits the environment exactly like the shell tab does. An optional
//!   first prompt is one allowlisted kit slash command (e.g. `/run-plan <plan>`), passed as
//!   the CLI's own positional prompt argument.
//! - `run-plan-all`: `agent-kit run-plan-all` in a PTY tab. The kit has no driver mode for
//!   the queue runner (driver protocol scope: `run-plan` only), so its numbered-list gates
//!   are answered in that terminal, which is how the CLI expects them.
//!
//! `/git-prod`, `/kit-prod` and any other slash command stay out of the allowlist.

use serde::Serialize;

use crate::{agent, tools};

/// Slash commands a cockpit button may hand to an interactive agent as its first prompt.
const PROMPT_SLASH: &[&str] = &["run-plan", "continue-plan", "backlog-edit", "archive-plan", "plan-review-triage", "field-report-resolve", "run-plan-all", "handoff", "summary"];

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TermLaunch {
    pub argv: Vec<String>,
    pub label: String,
    /// The vendor CLI or kit binary that will run (shown in the tab tooltip).
    pub bin: String,
    pub note: String,
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

fn plan(kind: &str, engine: &str, model: Option<&str>, prompt: Option<&str>, dry_run: bool, find: &dyn Fn(&str) -> Option<String>) -> Result<TermLaunch, String> {
    let model = model.map(str::trim).filter(|m| !m.is_empty());
    if let Some(m) = model {
        if !agent::valid_model(m) {
            return Err(format!("Not a model id: {m}"));
        }
    }
    match kind {
        "interactive" => {
            let prompt = prompt.map(str::trim).filter(|p| !p.is_empty());
            if let Some(p) = prompt {
                if !valid_prompt(p) {
                    return Err(format!("Not an allowlisted kit command: {p}"));
                }
            }
            let (name, bin, note) = vendor_for(engine, find)?;
            let mut argv = vec![bin.clone()];
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
            let bin = find("agent-kit").ok_or("agent-kit CLI not found on PATH")?;
            let mut argv = vec![bin.clone(), "run-plan-all".into(), "--backend".into(), engine.into()];
            if let Some(m) = model {
                argv.extend(["--model".to_string(), m.to_string()]);
            }
            if dry_run {
                argv.push("--dry-run".into());
            }
            Ok(TermLaunch { argv, label: format!("run-plan-all · {engine}"), bin, note: "Queue runner: answer its numbered-list gates in this terminal (no driver mode for run-plan-all in the kit)".into() })
        }
        _ => Err(format!("Unknown launch: {kind}")),
    }
}

fn find_real(name: &str) -> Option<String> {
    let found = match name {
        "agent-kit" => tools::agent_kit_bin(),
        "claude" => tools::find_bin("claude", Some("COLONY_CLAUDE_BIN")),
        "codex" => tools::find_bin("codex", Some("COLONY_CODEX_BIN")),
        _ => None,
    };
    found.map(|p| p.display().to_string())
}

/// Resolve the argv for a terminal-tab launch; the page then spawns it with `pty_spawn`
/// (cwd = the opened folder).
#[tauri::command]
pub fn term_launch(kind: String, engine: String, model: Option<String>, prompt: Option<String>, dry_run: Option<bool>) -> Result<TermLaunch, String> {
    plan(&kind, &engine, model.as_deref(), prompt.as_deref(), dry_run.unwrap_or(false), &find_real)
}

#[cfg(test)]
mod tests {
    use super::{plan, valid_prompt};

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
    fn interactive_argv() {
        let l = plan("interactive", "claude", None, Some("/run-plan demo.plan.md"), false, &find).unwrap();
        assert_eq!(l.argv, vec!["/bin/claude", "/run-plan demo.plan.md"]);
        assert_eq!(l.label, "claude /run-plan");
        // cursor-* falls back to the vendor CLI that is on PATH.
        let l = plan("interactive", "cursor-agent", Some("sonnet"), None, false, &find).unwrap();
        assert_eq!(l.argv, vec!["/bin/claude", "--model", "sonnet"]);
        assert!(!l.note.is_empty());
        assert!(plan("interactive", "codex", None, None, false, &find).is_err());
        assert!(plan("interactive", "claude", None, Some("/git-prod"), false, &find).is_err());
    }

    #[test]
    fn run_plan_all_argv() {
        let l = plan("run-plan-all", "codex", None, None, true, &find).unwrap();
        assert_eq!(l.argv, vec!["/bin/agent-kit", "run-plan-all", "--backend", "codex", "--dry-run"]);
        assert!(plan("run-plan-all", "nope", None, None, false, &find).is_err());
        assert!(plan("run-plan-all", "claude", Some("--x"), None, false, &find).is_err());
    }
}
