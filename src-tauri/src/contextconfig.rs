//! Settings → Kit config, second file: the open folder's `.cursor/context/config.json`, the kit's
//! operator settings (kit ADR 2026-10-24, amend 2026-11-19 point 7 as amended 2026-11-27: both
//! files; operator reply `r4-kit-config-file` = Both files). The first file, the scanner's
//! profile `.cursor/agent-kit.config.json`, is `kitconfig.rs`.
//!
//! Validation source: the Mission Control Config allowlist, the one writer the kit ships for
//! this file (kit `dashboard/lib/guards.mjs` `validateConfigWriteBody`, `validateRolesPatch`,
//! `mergeConfigAllowlist` and `mergeRoles`, read at kit staging `b39662c0`). FIELDS mirrors it
//! leaf by leaf: the same keys, types, integer ranges, enums and the two model id patterns
//! (`REVIEW_MODEL_ID` for the plan review models, `ROLE_MODEL_ID` for the roles), and the same
//! merge (a value replaces one leaf; `null` removes a clearable leaf; a role left empty, then an
//! empty `roles`, drops out). Not in the form: `roles.subworker.byWorkerType` (a map; Mission
//! Control edits it). Keys outside the allowlist (`onboarded`, `onboarding`,
//! `updateCheck.lastCheckedAt`, `updateApply`, anything else) are never written here, so this
//! file has no raw JSON editor.
//!
//! Capability matrix (kit `ROLE_CAPABILITIES`): Mission Control refuses a worker or subworker
//! model only when the same write pins a backend that cannot take it. One form row is one
//! write, so here the check reads the other half from the file: a model is refused on a pinned
//! backend that cannot take it, and so is a backend that cannot take a model already set.
//!
//! Writes: read fresh under the write lock (the CLI and hooks stamp this file too), then one
//! targeted text edit (`kitconfig::edit_text`): a changed value replaces only its text, a
//! missing key is added at the end of its object in the file's style, a removed key takes its
//! comma with it; the result is parsed again and compared with the expected document. A
//! missing file is created inside an existing `.cursor` folder (and `.cursor/context`, as
//! Mission Control does) in Mission Control's shape (`JSON.stringify(…, null, 2)` plus a
//! newline). Scope as in `kitconfig.rs`: one fixed path inside the open folder, symlinks
//! refused at `.cursor`, `.cursor/context` and the file.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::kitconfig::{edit_text, parse_object, write_atomic, WRITE};

pub const REL_DIRS: [&str; 2] = [".cursor", "context"];
pub const FILE_NAME: &str = "config.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Bool,
    /// An integer in `min..=max`.
    Int,
    /// One of `options`.
    Choice,
    /// A model id (`max` characters at most; see `model_ok`).
    Model,
}

pub struct Field {
    pub path: &'static [&'static str],
    pub label: &'static str,
    pub group: &'static str,
    pub kind: Kind,
    pub options: &'static [&'static str],
    pub min: i64,
    pub max: i64,
    /// `null` (or an empty model) removes the key (allowlist: `agentPersona.modes.*`, `roles.*`).
    pub clearable: bool,
}

const PERSONAS: &[&str] = &["autopilot", "night-shift", "ghost-runner"];
const REVIEW_MODEL: i64 = 64;
const ROLE_MODEL: i64 = 128;

const fn f(path: &'static [&'static str], label: &'static str, group: &'static str, kind: Kind) -> Field {
    Field { path, label, group, kind, options: &[], min: 0, max: 0, clearable: false }
}
const fn int(path: &'static [&'static str], label: &'static str, group: &'static str, min: i64, max: i64) -> Field {
    Field { path, label, group, kind: Kind::Int, options: &[], min, max, clearable: false }
}
const fn choice(path: &'static [&'static str], label: &'static str, group: &'static str, options: &'static [&'static str]) -> Field {
    Field { path, label, group, kind: Kind::Choice, options, min: 0, max: 0, clearable: false }
}
const fn model(path: &'static [&'static str], label: &'static str, group: &'static str, max: i64) -> Field {
    Field { path, label, group, kind: Kind::Model, options: &[], min: 1, max, clearable: false }
}
const fn clear(mut x: Field) -> Field {
    x.clearable = true;
    x
}

/// The form's fields: every leaf of the allowlist but `roles.subworker.byWorkerType` (see the
/// module comment).
pub const FIELDS: &[Field] = &[
    f(&["autoHandoff"], "Auto handoff", "Session", Kind::Bool),
    int(&["interTickCooldownMs"], "Pause between ticks (ms)", "Session", 0, 3_600_000),
    f(&["fieldReportReviewCadence", "enabled"], "Field report review", "Session", Kind::Bool),
    int(&["fieldReportReviewCadence", "tickThreshold"], "Field report review every (ticks)", "Session", 1, 100),
    f(&["externalPlanReview", "enabled"], "Plan review", "Plan review", Kind::Bool),
    choice(&["externalPlanReview", "backend"], "Backend", "Plan review", &["auto", "claude", "cursor"]),
    model(&["externalPlanReview", "reviewerModel"], "Reviewer model", "Plan review", REVIEW_MODEL),
    model(&["externalPlanReview", "advisorModel"], "Advisor model", "Plan review", REVIEW_MODEL),
    int(&["externalPlanReview", "waitSliceSeconds"], "Wait slice (s)", "Plan review", 1, 3600),
    int(&["externalPlanReview", "waitTimeoutSeconds"], "Wait timeout (s)", "Plan review", 1, 86_400),
    f(&["externalPlanReview", "autoRemediate"], "Auto remediate", "Plan review", Kind::Bool),
    f(&["externalPlanReview", "offerOnExhausted"], "Offer when the plan is exhausted", "Plan review", Kind::Bool),
    choice(&["externalPlanReview", "mode"], "Mode", "Plan review", &["paste", "autonomous"]),
    f(&["externalPlanReview", "midBatchAudits"], "Mid-batch audits", "Plan review", Kind::Bool),
    choice(&["externalPlanReview", "preflight"], "Preflight", "Plan review", &["off", "warn", "block"]),
    choice(&["agentPersona", "default"], "Default persona", "Agent persona", PERSONAS),
    clear(choice(&["agentPersona", "modes", "continue-plan"], "continue-plan", "Agent persona", PERSONAS)),
    clear(choice(&["agentPersona", "modes", "run-plan"], "run-plan", "Agent persona", PERSONAS)),
    clear(choice(&["agentPersona", "modes", "cli-run-plan"], "cli-run-plan", "Agent persona", PERSONAS)),
    f(&["updateCheck", "enabled"], "Update check", "Kit updates", Kind::Bool),
    int(&["updateCheck", "intervalDays"], "Check every (days)", "Kit updates", 1, 365),
    clear(choice(&["roles", "worker", "backend"], "Worker backend", "Roles", &["auto", "claude", "cursor-agent", "codex", "openrouter", "cursor-acp"])),
    clear(model(&["roles", "worker", "model"], "Worker model", "Roles", ROLE_MODEL)),
    clear(model(&["roles", "subworker", "model"], "Subworker model", "Roles", ROLE_MODEL)),
    clear(f(&["roles", "reviewer", "enabled"], "Reviewer", "Roles", Kind::Bool)),
    clear(choice(&["roles", "reviewer", "scope"], "Reviewer scope", "Roles", &["off", "tick", "plan"])),
    clear(choice(&["roles", "reviewer", "backend"], "Reviewer backend", "Roles", &["auto", "claude", "cursor-agent"])),
    clear(model(&["roles", "reviewer", "model"], "Reviewer model", "Roles", ROLE_MODEL)),
    clear(model(&["roles", "reviewer", "advisorModel"], "Reviewer advisor model", "Roles", ROLE_MODEL)),
];

/// Kit `ROLE_CAPABILITIES`: (worker model, subworker model) per worker backend.
fn capabilities(backend: &str) -> Option<(bool, bool)> {
    match backend {
        "claude" => Some((true, true)),
        "cursor-agent" | "codex" | "openrouter" => Some((true, false)),
        "cursor-acp" => Some((false, false)),
        _ => None,
    }
}

/// `REVIEW_MODEL_ID` = `[A-Za-z0-9._:+-]{1,64}`; `ROLE_MODEL_ID` = `[A-Za-z0-9._:/+=,[\]-]{1,128}`.
pub fn model_ok(s: &str, max: i64) -> bool {
    let n = s.chars().count() as i64;
    let extra: &[char] = if max == ROLE_MODEL { &['/', '=', ',', '[', ']'] } else { &[] };
    (1..=max).contains(&n) && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '+' | '-') || extra.contains(&c))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FieldInfo {
    path: String,
    label: &'static str,
    group: &'static str,
    kind: Kind,
    options: &'static [&'static str],
    min: i64,
    max: i64,
    clearable: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ContextConfigInfo {
    path: String,
    exists: bool,
    /// The folder has a `.cursor` folder, so a form edit may create the file.
    can_create: bool,
    text: Option<String>,
    fields: Vec<FieldInfo>,
}

fn field_infos() -> Vec<FieldInfo> {
    FIELDS
        .iter()
        .map(|f| FieldInfo { path: f.path.join("."), label: f.label, group: f.group, kind: f.kind, options: f.options, min: f.min, max: f.max, clearable: f.clearable })
        .collect()
}

/// Whether `p` is a real folder (`Ok(false)`: missing); a symlink or a file there is refused.
fn real_dir(p: &Path, root: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("{}: {e}", p.display())),
        Ok(m) if m.file_type().is_symlink() || !m.is_dir() => Err(format!("{} is not a folder inside {}", p.display(), root.display())),
        Ok(_) => Ok(true),
    }
}

/// `<root>/.cursor/context/config.json` and whether `.cursor` and `.cursor/context` exist;
/// refused when either folder or the file is a symlink or not what it should be.
pub fn resolve(root: &Path) -> Result<(PathBuf, bool, bool), String> {
    let root = root.canonicalize().map_err(|e| format!("{}: {e}", root.display()))?;
    let cursor = root.join(REL_DIRS[0]);
    let context = cursor.join(REL_DIRS[1]);
    let file = context.join(FILE_NAME);
    if !real_dir(&cursor, &root)? {
        return Ok((file, false, false));
    }
    if !real_dir(&context, &root)? {
        return Ok((file, true, false));
    }
    match std::fs::symlink_metadata(&file) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((file, true, true)),
        Err(e) => Err(format!("{}: {e}", file.display())),
        Ok(m) if m.file_type().is_symlink() || !m.is_file() => Err(format!("{} is not a regular file inside {}", file.display(), root.display())),
        Ok(_) => {
            let real = file.canonicalize().map_err(|e| format!("{}: {e}", file.display()))?;
            if real != file {
                return Err(format!("{} resolves outside {}", file.display(), root.display()));
            }
            Ok((file, true, true))
        }
    }
}

fn read_text(file: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(file) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", file.display())),
    }
}

pub fn info_at(root: &Path) -> Result<ContextConfigInfo, String> {
    let (file, cursor, _) = resolve(root)?;
    let text = read_text(&file)?;
    Ok(ContextConfigInfo { path: file.display().to_string(), exists: text.is_some(), can_create: cursor, text, fields: field_infos() })
}

/// Check a form value against its field: the value to write, `None` to remove the key.
pub fn check_value(path: &str, value: &Value) -> Result<(&'static Field, Option<Value>), String> {
    let f = FIELDS.iter().find(|f| f.path.join(".") == path).ok_or_else(|| format!("{path} is not a setting Colony edits"))?;
    if f.clearable && (value.is_null() || value.as_str().is_some_and(|s| s.trim().is_empty())) {
        return Ok((f, None));
    }
    let v = match (f.kind, value) {
        (Kind::Bool, Value::Bool(_)) => value.clone(),
        (Kind::Bool, _) => return Err(format!("{path} must be true or false")),
        (Kind::Int, Value::Number(n)) if n.as_i64().is_some_and(|i| (f.min..=f.max).contains(&i)) => value.clone(),
        (Kind::Int, _) => return Err(format!("{path} must be an integer {}..{}", f.min, f.max)),
        (Kind::Choice, Value::String(s)) if f.options.contains(&s.as_str()) => value.clone(),
        (Kind::Choice, _) => return Err(format!("{path} must be one of: {}", f.options.join(", "))),
        (Kind::Model, Value::String(s)) if model_ok(s.trim(), f.max) => Value::String(s.trim().to_string()),
        (Kind::Model, _) => return Err(format!("{path} must be a model id")),
    };
    Ok((f, Some(v)))
}

/// The capability matrix against what the file already pins (see the module comment).
fn check_capabilities(doc: &Value, path: &str, new: Option<&Value>) -> Result<(), String> {
    let Some(new) = new.and_then(Value::as_str) else { return Ok(()) };
    let at = |p: &str| doc.pointer(p).and_then(Value::as_str).filter(|s| !s.is_empty());
    match path {
        "roles.worker.model" => {
            if let Some(b) = at("/roles/worker/backend") {
                if capabilities(b).is_some_and(|c| !c.0) {
                    return Err(format!("roles.worker.model is not supported on {b} (capability matrix)"));
                }
            }
        }
        "roles.subworker.model" if new != "auto" => {
            if let Some(b) = at("/roles/worker/backend") {
                if capabilities(b).is_some_and(|c| !c.1) {
                    return Err(format!("roles.subworker model is not supported on {b} (capability matrix)"));
                }
            }
        }
        "roles.worker.backend" => {
            if let Some((worker, sub)) = capabilities(new) {
                if !worker && at("/roles/worker/model").is_some() {
                    return Err(format!("{new} takes no worker model (capability matrix); clear Worker model first"));
                }
                let sub_set = at("/roles/subworker/model").is_some_and(|m| m != "auto")
                    || doc.pointer("/roles/subworker/byWorkerType").and_then(Value::as_object).is_some_and(|m| m.values().any(|v| v.as_str().is_some_and(|s| !s.is_empty())));
                if !sub && sub_set {
                    return Err(format!("{new} takes no subworker model (capability matrix); clear the subworker models first"));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// Kit `mergeRoles`: a role left empty drops out, then an empty `roles`.
fn prune_roles(text: String, path: &[&str]) -> Result<String, String> {
    if path.len() < 2 || path[0] != "roles" {
        return Ok(text);
    }
    let mut out = text;
    for depth in [2, 1] {
        let doc = parse_object(&out)?;
        let p = format!("/{}", path[..depth].join("/"));
        if doc.pointer(&p).and_then(Value::as_object).is_some_and(|m| m.is_empty()) {
            out = edit_text(&out, &path[..depth], None)?;
        }
    }
    Ok(out)
}

/// A form edit: read the file fresh, change the one value, write.
pub fn set_at(root: &Path, path: &str, value: &Value) -> Result<ContextConfigInfo, String> {
    let (field, new) = check_value(path, value)?;
    let _one = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let (file, cursor, context) = resolve(root)?;
    if !cursor {
        return Err(format!("{} has no .cursor folder (not an Agent Kit folder); nothing was written", root.display()));
    }
    let on_disk = read_text(&file)?;
    let text = on_disk.clone().unwrap_or_else(|| "{}\n".to_string());
    let doc = parse_object(&text).map_err(|e| format!("{}: {e}", file.display()))?;
    check_capabilities(&doc, path, new.as_ref())?;
    let out = edit_text(&text, field.path, new.as_ref())?;
    let out = if new.is_none() { prune_roles(out, field.path)? } else { out };
    if on_disk.as_deref() != Some(out.as_str()) && (on_disk.is_some() || out != text) {
        if !context {
            let dir = file.parent().ok_or("no parent folder")?;
            std::fs::create_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            resolve(root)?;
        }
        write_atomic(&file, &out)?;
    }
    info_at(root)
}

#[tauri::command]
pub fn context_config_read(state: State<'_, crate::AppState>) -> Result<ContextConfigInfo, String> {
    info_at(&crate::workspace::workspace_root(&state)?)
}

/// A form edit of one FIELDS value (`path` is the field's dotted path; `null` clears a
/// clearable one).
#[tauri::command]
pub fn context_config_set(state: State<'_, crate::AppState>, path: String, value: Value) -> Result<ContextConfigInfo, String> {
    set_at(&crate::workspace::workspace_root(&state)?, &path, &value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn folder(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("colony-contextconfig-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(".cursor").join("context")).unwrap();
        d
    }

    fn file(root: &Path) -> PathBuf {
        root.join(".cursor").join("context").join(FILE_NAME)
    }

    /// The shape Mission Control writes, with keys it never edits.
    const MC: &str = "{\n  \"onboarded\": true,\n  \"autoHandoff\": false,\n  \"externalPlanReview\": {\n    \"enabled\": true,\n    \"backend\": \"auto\"\n  },\n  \"updateCheck\": {\n    \"enabled\": true,\n    \"lastCheckedAt\": \"2026-11-20T10:00:00Z\"\n  },\n  \"updateApply\": {\n    \"auto\": false\n  }\n}\n";

    #[test]
    fn the_fields_mirror_the_allowlist() {
        // Top-level keys: validateConfigWriteBody allowedTop, every one of them.
        let mut tops: Vec<&str> = FIELDS.iter().map(|f| f.path[0]).collect();
        tops.dedup();
        assert_eq!(tops, ["autoHandoff", "interTickCooldownMs", "fieldReportReviewCadence", "externalPlanReview", "agentPersona", "updateCheck", "roles"]);
        for bad in ["onboarded", "onboarding", "updateApply.auto", "updateCheck.lastCheckedAt", "roles.subworker.byWorkerType", "secretToken"] {
            assert!(check_value(bad, &json!(true)).is_err(), "{bad}");
        }
        assert!(check_value("autoHandoff", &json!("yes")).is_err());
        assert!(check_value("interTickCooldownMs", &json!(3_600_001)).is_err());
        assert!(check_value("interTickCooldownMs", &json!(1.5)).is_err());
        assert!(check_value("fieldReportReviewCadence.tickThreshold", &json!(0)).is_err());
        assert!(check_value("updateCheck.intervalDays", &json!(366)).is_err());
        assert!(check_value("externalPlanReview.waitTimeoutSeconds", &json!(86_400)).is_ok());
        assert!(check_value("externalPlanReview.backend", &json!("cursor-agent")).is_err(), "plan review says cursor");
        assert!(check_value("roles.reviewer.backend", &json!("cursor")).is_err(), "roles say cursor-agent");
        assert!(check_value("agentPersona.default", &json!("nope")).is_err());
        assert!(check_value("agentPersona.default", &json!(null)).is_err(), "only modes and roles clear");
        assert_eq!(check_value("agentPersona.modes.run-plan", &json!(null)).unwrap().1, None);
        assert_eq!(check_value("roles.worker.model", &json!("  ")).unwrap().1, None);
        // The two model id patterns.
        assert_eq!(check_value("roles.worker.model", &json!(" openai/gpt-5[reasoning=high] ")).unwrap().1, Some(json!("openai/gpt-5[reasoning=high]")));
        assert!(check_value("externalPlanReview.reviewerModel", &json!("openai/gpt-5")).is_err(), "no / in a review model");
        assert!(check_value("externalPlanReview.reviewerModel", &json!("x".repeat(65))).is_err());
        assert!(check_value("roles.reviewer.model", &json!("x".repeat(128))).is_ok());
        assert!(check_value("roles.reviewer.model", &json!("a b")).is_err());
    }

    #[test]
    fn a_value_change_keeps_every_other_byte() {
        let root = folder("change");
        std::fs::write(file(&root), MC).unwrap();
        set_at(&root, "autoHandoff", &json!(true)).unwrap();
        assert_eq!(std::fs::read_to_string(file(&root)).unwrap(), MC.replace("\"autoHandoff\": false", "\"autoHandoff\": true"));
        set_at(&root, "autoHandoff", &json!(false)).unwrap();
        assert_eq!(std::fs::read_to_string(file(&root)).unwrap(), MC);
        // The same value: no write.
        let before = std::fs::metadata(file(&root)).unwrap().modified().unwrap();
        set_at(&root, "externalPlanReview.backend", &json!("auto")).unwrap();
        assert_eq!(std::fs::metadata(file(&root)).unwrap().modified().unwrap(), before);
    }

    #[test]
    fn a_missing_key_is_added_in_the_file_style() {
        let root = folder("add");
        std::fs::write(file(&root), MC).unwrap();
        set_at(&root, "externalPlanReview.mode", &json!("autonomous")).unwrap();
        let t = std::fs::read_to_string(file(&root)).unwrap();
        assert_eq!(t, MC.replace("\"backend\": \"auto\"\n", "\"backend\": \"auto\",\n    \"mode\": \"autonomous\"\n"));
        // Missing parents: nested objects at the end of the root.
        set_at(&root, "agentPersona.modes.run-plan", &json!("night-shift")).unwrap();
        let t2 = std::fs::read_to_string(file(&root)).unwrap();
        assert_eq!(t2, t.replace("    \"auto\": false\n  }\n}\n", "    \"auto\": false\n  },\n  \"agentPersona\": {\n    \"modes\": {\n      \"run-plan\": \"night-shift\"\n    }\n  }\n}\n"));
        // An empty object opens on new lines; a one-line object stays on one line.
        assert_eq!(edit_text("{\"a\": {}}", &["a", "b"], Some(&json!(1))).unwrap(), "{\"a\": {\n  \"b\": 1\n}}");
        assert_eq!(edit_text("{\"a\": {\"x\": 1}}", &["a", "b"], Some(&json!(2))).unwrap(), "{\"a\": {\"x\": 1, \"b\": 2}}");
        assert_eq!(edit_text("{\"a\":{\"x\":1,\"y\":2}}", &["a", "b"], Some(&json!(3))).unwrap(), "{\"a\":{\"x\":1,\"y\":2,\"b\":3}}");
        // Tabs and CRLF.
        assert_eq!(edit_text("{\r\n\t\"a\": 1\r\n}\r\n", &["b", "c"], Some(&json!(true))).unwrap(), "{\r\n\t\"a\": 1,\r\n\t\"b\": {\r\n\t\t\"c\": true\r\n\t}\r\n}\r\n");
        // A parent that is not an object is refused.
        assert!(edit_text("{\"agentPersona\": 3}", &["agentPersona", "default"], Some(&json!("autopilot"))).is_err());
    }

    #[test]
    fn a_missing_file_is_created_in_mission_controls_shape() {
        let root = folder("create");
        std::fs::remove_dir(root.join(".cursor").join("context")).unwrap();
        let info = info_at(&root).unwrap();
        assert!(!info.exists && info.can_create);
        set_at(&root, "updateCheck.intervalDays", &json!(7)).unwrap();
        assert_eq!(std::fs::read_to_string(file(&root)).unwrap(), "{\n  \"updateCheck\": {\n    \"intervalDays\": 7\n  }\n}\n");
        // Clearing a key that is not there writes nothing.
        let root = folder("create-none");
        set_at(&root, "roles.worker.model", &json!(null)).unwrap();
        assert!(!file(&root).exists());
        // No .cursor: nothing is created.
        let bare = std::env::temp_dir().join(format!("colony-contextconfig-bare-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&bare);
        std::fs::create_dir_all(&bare).unwrap();
        assert!(!info_at(&bare).unwrap().can_create);
        assert!(set_at(&bare, "autoHandoff", &json!(true)).unwrap_err().contains("no .cursor folder"));
        assert!(!bare.join(".cursor").exists());
    }

    #[test]
    fn null_removes_and_empty_roles_drop_out() {
        let root = folder("roles");
        std::fs::write(file(&root), MC).unwrap();
        set_at(&root, "roles.reviewer.scope", &json!("plan")).unwrap();
        set_at(&root, "roles.worker.backend", &json!("claude")).unwrap();
        set_at(&root, "roles.reviewer.scope", &json!(null)).unwrap();
        let t = std::fs::read_to_string(file(&root)).unwrap();
        assert!(!t.contains("reviewer") && t.contains("\"backend\": \"claude\""), "{t}");
        set_at(&root, "roles.worker.backend", &json!(null)).unwrap();
        assert_eq!(std::fs::read_to_string(file(&root)).unwrap(), MC, "the whole roles block drops out");
        // A persona mode cleared leaves its modes object (mergeConfigAllowlist).
        set_at(&root, "agentPersona.modes.run-plan", &json!("autopilot")).unwrap();
        set_at(&root, "agentPersona.modes.run-plan", &json!(null)).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(file(&root)).unwrap()).unwrap();
        assert_eq!(v["agentPersona"], json!({ "modes": {} }));
        // Removal of the first, a middle and the last member.
        let t = "{\n  \"a\": 1,\n  \"b\": 2,\n  \"c\": 3\n}\n";
        assert_eq!(edit_text(t, &["a"], None).unwrap(), "{\n  \"b\": 2,\n  \"c\": 3\n}\n");
        assert_eq!(edit_text(t, &["b"], None).unwrap(), "{\n  \"a\": 1,\n  \"c\": 3\n}\n");
        assert_eq!(edit_text(t, &["c"], None).unwrap(), "{\n  \"a\": 1,\n  \"b\": 2\n}\n");
        assert_eq!(edit_text("{ \"a\": 1 }", &["a"], None).unwrap(), "{}");
    }

    #[test]
    fn the_capability_matrix_reads_the_other_half_from_the_file() {
        let root = folder("caps");
        std::fs::write(file(&root), "{\n  \"roles\": {\n    \"worker\": {\n      \"backend\": \"cursor-acp\"\n    }\n  }\n}\n").unwrap();
        assert!(set_at(&root, "roles.worker.model", &json!("sonnet")).unwrap_err().contains("capability matrix"));
        set_at(&root, "roles.worker.backend", &json!("codex")).unwrap();
        set_at(&root, "roles.worker.model", &json!("gpt-5")).unwrap();
        assert!(set_at(&root, "roles.subworker.model", &json!("haiku")).unwrap_err().contains("capability matrix"));
        set_at(&root, "roles.subworker.model", &json!("auto")).unwrap();
        assert!(set_at(&root, "roles.worker.backend", &json!("cursor-acp")).unwrap_err().contains("clear Worker model"));
        set_at(&root, "roles.worker.backend", &json!("claude")).unwrap();
        set_at(&root, "roles.subworker.model", &json!("haiku")).unwrap();
        assert!(set_at(&root, "roles.worker.backend", &json!("codex")).unwrap_err().contains("subworker"));
        set_at(&root, "roles.worker.backend", &json!("auto")).unwrap();
    }

    #[test]
    fn a_broken_file_or_a_duplicate_is_never_written() {
        let root = folder("broken");
        std::fs::write(file(&root), "{ broken").unwrap();
        assert!(set_at(&root, "autoHandoff", &json!(true)).is_err());
        assert_eq!(std::fs::read_to_string(file(&root)).unwrap(), "{ broken");
        std::fs::write(file(&root), "[]").unwrap();
        assert!(set_at(&root, "autoHandoff", &json!(true)).is_err());
        let dup = "{\"autoHandoff\": false, \"autoHandoff\": true}";
        std::fs::write(file(&root), dup).unwrap();
        assert!(set_at(&root, "autoHandoff", &json!(false)).is_err());
        assert_eq!(std::fs::read_to_string(file(&root)).unwrap(), dup);
    }

    #[test]
    fn the_path_is_scoped_to_the_open_folder() {
        use std::os::unix::fs::symlink;
        let outside = folder("outside");
        std::fs::write(file(&outside), MC).unwrap();
        // A symlinked .cursor/context folder.
        let root = std::env::temp_dir().join(format!("colony-contextconfig-link-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".cursor")).unwrap();
        symlink(outside.join(".cursor").join("context"), root.join(".cursor").join("context")).unwrap();
        assert!(info_at(&root).is_err());
        assert!(set_at(&root, "autoHandoff", &json!(true)).is_err());
        // A symlinked file.
        let root = folder("link-file");
        symlink(file(&outside), file(&root)).unwrap();
        assert!(info_at(&root).is_err());
        assert!(set_at(&root, "autoHandoff", &json!(true)).is_err());
        assert_eq!(std::fs::read_to_string(file(&outside)).unwrap(), MC, "the file outside is untouched");
        let root = folder("plain");
        let (p, cursor, context) = resolve(&root).unwrap();
        assert!(cursor && context && p == root.canonicalize().unwrap().join(".cursor").join("context").join("config.json"));
    }
}
