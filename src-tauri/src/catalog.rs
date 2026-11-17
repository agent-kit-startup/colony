//! Command palette source: the kit's versioned commands catalog (`agent-kit commands --json`,
//! kit docs/contracts/commands-catalog.schema.json, ADR 2026-10-22 colony-commands-catalog-
//! contract). Colony keeps no list of its own: the rows come from the engine that runs
//! agent-kit, read from the opened folder's `.cursor/commands/`.
//!
//! Every row is either "run" or "copy". A row runs only when its name is in vendor.rs
//! `PROMPT_SLASH` (the same check `term_launch` repeats); the catalog can only narrow that
//! (ADR 2026-10-22 amend 2026-11-16, run with context). From catalog 1.1.0 a row also carries
//! `context` (what the launch may append after the slash), `interactiveOnly` (`/git-prod`,
//! `/kit-prod`, also forced by vendor.rs) and `audience`: a `meta` row is hidden and never
//! runs outside the factory workspace (a catalog with factory-layer rows), and a `project`
//! row (a file the workspace added) stays copy. An older catalog without those fields keeps
//! the pre-1.1.0 behavior: vendor.rs `LEGACY_RUN`, factory rows copy. Catalog text is untrusted: names
//! must match the schema pattern (others are dropped), descriptions are plain text with
//! control characters removed and a length cap; the page renders them as text only.
//!
//! An engine without the `commands` subcommand (before the kit release that added it) or
//! with an unsupported `catalogVersion` major gets the "Update the engine" gate, never a
//! fallback list.

use std::path::Path;
use std::process::{Command, Stdio};

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::{tools, vendor, workspace, AppState};

/// The `catalogVersion` major this Colony reads.
const CATALOG_MAJOR: u64 = 1;
const UPDATE_ENGINE: &str = "Update the engine (Settings → Engine…) to list commands";
const MAX_DESCRIPTION: usize = 400;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandRow {
    pub name: String,
    pub description: String,
    /// `kit`, `factory` or `project`.
    pub layer: String,
    /// The kit can dispatch it headless: shown as a hint only.
    pub headless: bool,
    /// Colony may hand `/<name>` to an interactive agent (PROMPT_SLASH); otherwise copy.
    pub run: bool,
    /// What a launch may append after the slash: none, goal, plan, branch, pr or sha.
    pub context: String,
    /// Interactive tab only, with the native confirm first (`/git-prod`, `/kit-prod`).
    pub interactive_only: bool,
    /// `user` or `meta`.
    pub audience: String,
    /// A meta row outside the factory workspace: the page does not show it.
    pub hidden: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub catalog_version: String,
    pub kit_version: String,
    pub commands: Vec<CommandRow>,
    /// Rows dropped for an invalid name or shape.
    pub dropped: usize,
    /// The catalog lists factory-layer rows: this folder is the kit's own repository.
    pub factory: bool,
}

const CONTEXTS: &[&str] = &["none", "goal", "plan", "branch", "pr", "sha"];

fn field<'a>(r: &'a Value, key: &str, allowed: &[&str], default: &'a str) -> &'a str {
    r.get(key).and_then(Value::as_str).filter(|v| allowed.contains(v)).unwrap_or(default)
}

/// Schema pattern `^[a-z0-9][a-z0-9-]{0,63}$`.
fn valid_name(n: &str) -> bool {
    let b = n.as_bytes();
    !b.is_empty() && b.len() <= 64 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn clean_text(s: &str) -> String {
    let flat: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    match flat.char_indices().nth(MAX_DESCRIPTION) {
        Some((i, _)) => format!("{}…", &flat[..i]),
        None => flat,
    }
}

/// Parse the kit's stdout. Anything that is not a supported catalog is the engine gate.
pub fn parse(stdout: &str) -> Result<Catalog, String> {
    let v: Value = serde_json::from_str(stdout.trim()).map_err(|_| UPDATE_ENGINE.to_string())?;
    let Some(version) = v.get("catalogVersion").and_then(Value::as_str) else {
        return Err(UPDATE_ENGINE.into());
    };
    let parsed = semver::Version::parse(version).map_err(|_| format!("{UPDATE_ENGINE} (catalog version {version:?} is not a version)"))?;
    let major = parsed.major;
    if major != CATALOG_MAJOR {
        return Err(format!("{UPDATE_ENGINE} (catalog {version}; this Colony reads {CATALOG_MAJOR}.x)"));
    }
    let rows = v.get("commands").and_then(Value::as_array).ok_or_else(|| UPDATE_ENGINE.to_string())?;
    // Catalog 1.1.0 carries context, interactiveOnly and audience; older ones get today's rule.
    let fields = parsed.minor >= 1;
    let factory = rows.iter().any(|r| r.get("layer").and_then(Value::as_str) == Some("factory"));
    let mut commands = Vec::new();
    for r in rows {
        let name = r.get("name").and_then(Value::as_str).unwrap_or("");
        let layer = r.get("layer").and_then(Value::as_str).unwrap_or("");
        if !valid_name(name) || !matches!(layer, "kit" | "factory" | "project") {
            continue;
        }
        let audience = if fields { field(r, "audience", &["user", "meta"], "user") } else { "user" };
        let hidden = audience == "meta" && !factory;
        let run = if fields { layer != "project" && !hidden && vendor::runnable(name) } else { layer != "factory" && vendor::LEGACY_RUN.contains(&name) };
        commands.push(CommandRow {
            name: name.to_string(),
            description: clean_text(r.get("description").and_then(Value::as_str).unwrap_or("")),
            layer: layer.to_string(),
            headless: r.get("headless").and_then(Value::as_bool).unwrap_or(false),
            run,
            context: if fields { field(r, "context", CONTEXTS, "none") } else { "none" }.to_string(),
            interactive_only: vendor::interactive_only(name) || (fields && r.get("interactiveOnly").and_then(Value::as_bool).unwrap_or(false)),
            audience: audience.to_string(),
            hidden,
        });
    }
    Ok(Catalog {
        catalog_version: version.to_string(),
        kit_version: clean_text(v.get("kitVersion").and_then(Value::as_str).unwrap_or("?")),
        dropped: rows.len() - commands.len(),
        commands,
        factory,
    })
}

fn load(root: &Path) -> Result<Catalog, String> {
    let kit = crate::engine::kit_command()?;
    let mut cmd = Command::new(&kit.program);
    tools::die_with_parent(&mut cmd);
    let out = cmd
        .args(&kit.args)
        .args(["commands", "--json", "--cwd"])
        .arg(root)
        .current_dir(root)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("agent-kit commands failed to start: {e}"))?;
    // An engine that predates the subcommand prints its help and exits non-zero.
    if !out.status.success() {
        return Err(UPDATE_ENGINE.into());
    }
    parse(&String::from_utf8_lossy(&out.stdout))
}

/// The opened folder's commands catalog, each row marked run or copy.
#[tauri::command(async)]
pub fn commands_catalog(state: State<'_, AppState>) -> Result<Catalog, String> {
    load(&workspace::workspace_root(&state)?)
}

#[cfg(test)]
mod tests {
    use super::{load, parse, valid_name, UPDATE_ENGINE};

    /// A 1.0.0 catalog (no context, interactiveOnly or audience): the pre-1.1.0 run rule.
    const FIXTURE: &str = r#"{
      "catalogVersion": "1.0.0",
      "kitVersion": "6.7.0",
      "commands": [
        { "name": "run-plan", "description": "Run the active plan.", "layer": "kit", "headless": true },
        { "name": "git-staging", "description": "Bring changes\nto staging.\u0007", "layer": "kit", "headless": true },
        { "name": "git-prod", "description": "Promote to production.", "layer": "kit", "headless": false },
        { "name": "kit-prod", "description": "Ship the kit.", "layer": "factory", "headless": false },
        { "name": "handoff", "description": "Write HANDOFF.", "layer": "factory", "headless": false },
        { "name": "my-thing", "description": "<img src=x onerror=alert(1)>", "layer": "project", "headless": false },
        { "name": "../evil", "description": "x", "layer": "kit", "headless": true },
        { "name": "Run-Plan", "description": "x", "layer": "kit", "headless": true },
        { "name": "odd", "description": "x", "layer": "root", "headless": true },
        { "name": "future", "description": "x", "layer": "kit", "headless": false, "newField": 1 }
      ]
    }"#;

    #[test]
    fn older_catalog_keeps_todays_rule() {
        let c = parse(FIXTURE).unwrap();
        let names: Vec<_> = c.commands.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["run-plan", "git-staging", "git-prod", "kit-prod", "handoff", "my-thing", "future"]);
        assert_eq!(c.dropped, 3);
        let run = |n: &str| c.commands.iter().find(|r| r.name == n).unwrap().run;
        assert!(run("run-plan"));
        // Without the 1.1.0 fields Colony cannot tell meta rows apart: the old set holds.
        assert!(!run("git-staging"));
        assert!(!run("git-prod") && !run("kit-prod"));
        assert!(!run("handoff"));
        assert!(!run("my-thing") && !run("future"));
        assert!(c.commands.iter().all(|r| r.context == "none" && r.audience == "user" && !r.hidden));
        // The production floor holds whatever the catalog says.
        assert!(c.commands.iter().filter(|r| r.interactive_only).map(|r| r.name.as_str()).eq(["git-prod", "kit-prod"]));
        assert_eq!(c.commands[1].description, "Bring changes to staging.");
        // Untrusted text is carried as text; the page never parses it as HTML.
        assert_eq!(c.commands[5].description, "<img src=x onerror=alert(1)>");
        assert_eq!(c.kit_version, "6.7.0");
    }

    /// A consumer workspace on catalog 1.1.0: no factory rows, so meta rows are hidden.
    const CONSUMER: &str = r#"{
      "catalogVersion": "1.1.0",
      "kitVersion": "6.19.0",
      "commands": [
        { "name": "backlog-add", "description": "Enqueue.", "layer": "kit", "headless": true, "context": "goal", "interactiveOnly": false, "audience": "user" },
        { "name": "git-prod", "description": "Promote.", "layer": "kit", "headless": false, "context": "sha", "interactiveOnly": true, "audience": "user" },
        { "name": "git-staging", "description": "Stage.", "layer": "kit", "headless": true, "context": "branch", "interactiveOnly": false, "audience": "user" },
        { "name": "hotfix", "description": "Fix.", "layer": "kit", "headless": false, "context": "goal", "interactiveOnly": false, "audience": "user" },
        { "name": "review-pack", "description": "Review.", "layer": "kit", "headless": true, "context": "none", "interactiveOnly": false, "audience": "meta" },
        { "name": "deploy-site", "description": "Ship.", "layer": "project", "headless": false, "context": "goal", "interactiveOnly": false, "audience": "user" },
        { "name": "summary", "description": "Sum.", "layer": "kit", "headless": false, "context": "everything", "interactiveOnly": "yes", "audience": "admins" },
        { "name": "run-plan", "description": "Run.", "layer": "kit", "headless": true, "context": "none", "interactiveOnly": true, "audience": "user" }
      ]
    }"#;

    #[test]
    fn consumer_catalog_runs_user_rows_and_hides_meta() {
        let c = parse(CONSUMER).unwrap();
        assert!(!c.factory);
        let row = |n: &str| c.commands.iter().find(|r| r.name == n).unwrap();
        for n in ["backlog-add", "git-prod", "git-staging", "hotfix", "summary", "run-plan"] {
            assert!(row(n).run && !row(n).hidden, "{n}");
        }
        assert_eq!(row("backlog-add").context, "goal");
        assert_eq!(row("git-staging").context, "branch");
        assert_eq!(row("git-prod").context, "sha");
        assert!(row("git-prod").interactive_only);
        // Meta: hidden and never run outside the factory workspace.
        assert!(row("review-pack").hidden && !row("review-pack").run);
        // A project row never runs: repo text cannot grant execution.
        assert!(!row("deploy-site").run && !row("deploy-site").hidden);
        // Unknown values fall back; a non-boolean interactiveOnly is false.
        assert_eq!((row("summary").context.as_str(), row("summary").audience.as_str(), row("summary").interactive_only), ("none", "user", false));
        // The catalog may add interactive-only rows, never remove the prod floor.
        assert!(row("run-plan").interactive_only);
    }

    #[test]
    fn factory_catalog_runs_meta_rows() {
        let c = parse(r#"{"catalogVersion":"1.1.0","kitVersion":"6.19.0","commands":[
          {"name":"kit-prod","description":"Ship the kit.","layer":"factory","headless":false,"context":"sha","interactiveOnly":false,"audience":"meta"},
          {"name":"kit-staging","description":"Stage the kit.","layer":"factory","headless":false,"context":"branch","interactiveOnly":false,"audience":"meta"},
          {"name":"review-pack","description":"Review.","layer":"kit","headless":true,"context":"none","interactiveOnly":false,"audience":"meta"},
          {"name":"not-in-colony","description":"x","layer":"kit","headless":false,"context":"none","interactiveOnly":false,"audience":"user"}
        ]}"#).unwrap();
        assert!(c.factory);
        let row = |n: &str| c.commands.iter().find(|r| r.name == n).unwrap();
        for n in ["kit-prod", "kit-staging", "review-pack"] {
            assert!(row(n).run && !row(n).hidden, "{n}");
        }
        // kit-prod stays interactive only even when the catalog says false.
        assert!(row("kit-prod").interactive_only);
        // A kit name Colony was not built with stays copy: the catalog cannot widen the set.
        assert!(!row("not-in-colony").run);
    }

    #[test]
    fn engine_gate() {
        // An engine without the subcommand prints its help (and exits non-zero).
        for bad in ["HITL framework for AI-assisted IDEs (agent-kit v6.6.0)\n\nUSAGE", "", "{}", r#"{"commands":[]}"#, r#"{"catalogVersion":"1.0.0"}"#] {
            assert_eq!(parse(bad).unwrap_err(), UPDATE_ENGINE, "{bad}");
        }
        let e = parse(r#"{"catalogVersion":"2.0.0","kitVersion":"9.0.0","commands":[]}"#).unwrap_err();
        assert!(e.starts_with(UPDATE_ENGINE) && e.contains("2.0.0"), "{e}");
        assert!(parse(r#"{"catalogVersion":"one","commands":[]}"#).unwrap_err().starts_with(UPDATE_ENGINE));
    }

    #[test]
    fn long_description_capped() {
        let long = "a".repeat(1000);
        let c = parse(&format!(r#"{{"catalogVersion":"1.0.0","kitVersion":"x","commands":[{{"name":"x","description":"{long}","layer":"kit","headless":false}}]}}"#)).unwrap();
        assert_eq!(c.commands[0].description.chars().count(), 401);
    }

    #[test]
    fn names() {
        for ok in ["run-plan", "a", "0x", &"a".repeat(64)] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in ["", "-x", "A", "a_b", "a/b", "a b", &"a".repeat(65)] {
            assert!(!valid_name(bad), "{bad}");
        }
    }

    /// The real spawn path: `COLONY_AGENT_KIT_BIN=<agent-kit with the commands subcommand>
    /// COLONY_TEST_CATALOG_CWD=<a folder with .cursor/commands/> cargo test -- --ignored live_catalog`.
    #[test]
    #[ignore]
    fn live_catalog() {
        let cwd = std::env::var("COLONY_TEST_CATALOG_CWD").expect("set COLONY_TEST_CATALOG_CWD");
        let c = load(std::path::Path::new(&cwd)).unwrap();
        assert!(!c.commands.is_empty());
        let row = |n: &str| c.commands.iter().find(|r| r.name == n);
        assert!(row("run-plan").is_some_and(|r| r.run));
        assert!(row("git-prod").is_some_and(|r| r.interactive_only));
        assert!(c.commands.iter().filter(|r| r.hidden).all(|r| !r.run));
        eprintln!("catalog {} kit {}: {} rows, {} run, {} dropped", c.catalog_version, c.kit_version, c.commands.len(), c.commands.iter().filter(|r| r.run).count(), c.dropped);
    }
}
