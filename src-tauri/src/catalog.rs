//! Command palette source: the kit's versioned commands catalog (`agent-kit commands --json`,
//! kit docs/contracts/commands-catalog.schema.json, ADR 2026-10-22 colony-commands-catalog-
//! contract). Colony keeps no list of its own: the rows come from the engine that runs
//! agent-kit, read from the opened folder's `.cursor/commands/`.
//!
//! Every row is either "run" or "copy". A row runs only when its name is in vendor.rs
//! `PROMPT_SLASH` (the same check `term_launch` repeats); the catalog's `headless` hint and
//! its layer never widen that. Factory rows stay copy. Catalog text is untrusted: names
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
const UPDATE_ENGINE: &str = "Update the engine (More → Engine) to list commands";
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
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub catalog_version: String,
    pub kit_version: String,
    pub commands: Vec<CommandRow>,
    /// Rows dropped for an invalid name or shape.
    pub dropped: usize,
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
    let major = semver::Version::parse(version).map_err(|_| format!("{UPDATE_ENGINE} (catalog version {version:?} is not a version)"))?.major;
    if major != CATALOG_MAJOR {
        return Err(format!("{UPDATE_ENGINE} (catalog {version}; this Colony reads {CATALOG_MAJOR}.x)"));
    }
    let rows = v.get("commands").and_then(Value::as_array).ok_or_else(|| UPDATE_ENGINE.to_string())?;
    let mut commands = Vec::new();
    for r in rows {
        let name = r.get("name").and_then(Value::as_str).unwrap_or("");
        let layer = r.get("layer").and_then(Value::as_str).unwrap_or("");
        if !valid_name(name) || !matches!(layer, "kit" | "factory" | "project") {
            continue;
        }
        commands.push(CommandRow {
            name: name.to_string(),
            description: clean_text(r.get("description").and_then(Value::as_str).unwrap_or("")),
            layer: layer.to_string(),
            headless: r.get("headless").and_then(Value::as_bool).unwrap_or(false),
            run: layer != "factory" && vendor::runnable(name),
        });
    }
    Ok(Catalog {
        catalog_version: version.to_string(),
        kit_version: clean_text(v.get("kitVersion").and_then(Value::as_str).unwrap_or("?")),
        dropped: rows.len() - commands.len(),
        commands,
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

    const FIXTURE: &str = r#"{
      "catalogVersion": "1.2.0",
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
    fn rows_run_or_copy() {
        let c = parse(FIXTURE).unwrap();
        let names: Vec<_> = c.commands.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["run-plan", "git-staging", "git-prod", "kit-prod", "handoff", "my-thing", "future"]);
        assert_eq!(c.dropped, 3);
        let run = |n: &str| c.commands.iter().find(|r| r.name == n).unwrap().run;
        assert!(run("run-plan"));
        // headless in the kit is a hint: git-staging stays copy in Colony.
        assert!(!run("git-staging"));
        assert!(!run("git-prod") && !run("kit-prod"));
        // A factory row stays copy even when its name is allowlisted.
        assert!(!run("handoff"));
        assert!(!run("my-thing") && !run("future"));
        assert_eq!(c.commands[1].description, "Bring changes to staging.");
        // Untrusted text is carried as text; the page never parses it as HTML.
        assert_eq!(c.commands[5].description, "<img src=x onerror=alert(1)>");
        assert_eq!(c.kit_version, "6.7.0");
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
        assert!(row("git-prod").is_some_and(|r| !r.run));
        assert!(row("git-staging").is_some_and(|r| !r.run));
        assert!(c.commands.iter().filter(|r| r.layer == "factory").all(|r| !r.run));
        eprintln!("catalog {} kit {}: {} rows, {} run, {} dropped", c.catalog_version, c.kit_version, c.commands.len(), c.commands.iter().filter(|r| r.run).count(), c.dropped);
    }
}
