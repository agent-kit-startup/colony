//! Managed engine: which Agent Kit build Colony runs, and with which Node.
//!
//! The kit's ADR `2026-10-19_colony-managed-engine-distribution`: Colony installs,
//! updates and rolls back the kit itself (the engine artifact of each kit release,
//! `agent-kit-engine-<version>.tar.gz` + `SHA256SUMS`), and gates it on the two versioned
//! contracts only (driver events protocol, Mission Control snapshot schema).
//!
//! Resolution, first match wins:
//! 1. `COLONY_ENGINE=<path>`: a kit checkout (repo root or `packages/cli`) or an extracted
//!    engine. Development flow: engine and IDE against the same working tree.
//! 2. The managed engine under `<data dir>/colony/engine/<version>/` (Linux
//!    `~/.local/share/colony/engine/`): the `current` one of `state.json`, else the highest
//!    installed version inside the supported range.
//! 3. Transition fallback: `agent-kit` on PATH, shown in the UI as an unmanaged engine.
//!
//! Per-binary overrides beat all three: `COLONY_AGENT_KIT_BIN` for agent runs and
//! `COLONY_DASHBOARD_SERVE` for Mission Control (the smoke fixtures use them).
//!
//! Node: a system `node` that satisfies the engine's `node` range, else a Node build this
//! module downloaded once into `<data dir>/colony/runtime/node-<version>/`.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::{tools, AppState};

/// Driver events protocol major this Colony build speaks (kit `DRIVER_PROTOCOL_VERSION`).
pub const DRIVER_PROTOCOL_MAJOR: u64 = 1;
/// Driver protocol range the engine updater installs (semver requirement): the protocol this
/// Colony was built and tested against. `Install/Update engine` picks the newest kit release
/// inside it, never a blind `releases/latest`, and refuses an engine outside it. Running an
/// engine that is already there (COLONY_ENGINE, PATH, older managed installs) only needs
/// the major (`check_range`). Raise it with the Colony release that supports a newer protocol.
/// 1.3.0 adds token `usage` to `tick_end` / `run_end` (the driver chat's token budget);
/// 1.2.x engines still install, and their runs show "no usage".
pub const ENGINE_PROTOCOL_RANGE: &str = ">=1.2.0, <1.4.0";
/// How many of the newest kit releases the updater looks at for one inside the range.
const RELEASE_SCAN: usize = 10;
/// Mission Control snapshot schema major the native views read (`dashboardDataVersion`).
pub const DASHBOARD_DATA_MAJOR: u64 = 1;
/// Where kit releases (and their engine artifacts) are published.
pub const DEFAULT_RELEASE_REPO: &str = "agent-kit-startup/agent-kit";
/// Public key for engine signatures: the base64 line of the kit's minisign public key
/// (`RW...`, the second line of `minisign.pub`). None until the operator creates the engine
/// signing key (kit secret ENGINE_SIGNING_KEY, ADR Consequence 4); until then only
/// SHA256SUMS is checked and the install says so. Once set, every install needs
/// `SHA256SUMS.minisig` on the release and a valid signature over SHA256SUMS by this key.
const ENGINE_SIGNING_PUBKEY: Option<&str> = None;

/// Pinned official Node build (nodejs.org, LTS), with the sha256 values of its
/// SHASUMS256.txt. The downloaded SHASUMS256.txt must list the same value.
const NODE_VERSION: &str = "24.22.0";
const NODE_BUILDS: &[(&str, &str, &str, &str)] = &[
    ("linux", "x86_64", "linux-x64", "28ea0a438de9a13bd7891fd758eee6c7819ee8af5442dfd8d45bd65e56d4228c"),
    ("linux", "aarch64", "linux-arm64", "b7e7991d5407815adfa74a2a9cd4db683552c8ce32ff4a295c22e972849c3f5d"),
];

static INSTALL_LOCK: Mutex<()> = Mutex::new(());

fn default_entry() -> String {
    "dist/index.js".into()
}

fn default_serve() -> String {
    "dashboard/serve.mjs".into()
}

/// `engine.json` of the engine artifact, same fields as `agent-kit engine-info --json`.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub node: String,
    pub driver_protocol: String,
    pub dashboard_data_version: Option<String>,
    #[serde(default = "default_entry")]
    pub entry: String,
    #[serde(default = "default_serve")]
    pub dashboard_serve: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Source {
    /// `COLONY_ENGINE`
    Env,
    /// `<data dir>/colony/engine/<version>/`
    Managed,
}

#[derive(Clone, Debug)]
pub struct Engine {
    pub source: Source,
    pub root: PathBuf,
    pub entry: PathBuf,
    pub serve: PathBuf,
    /// None for a checkout whose contract could not be read (dev override only).
    pub manifest: Option<Manifest>,
    pub note: Option<String>,
}

impl Engine {
    pub fn version(&self) -> &str {
        self.manifest.as_ref().map(|m| m.version.as_str()).unwrap_or("?")
    }

    pub fn label(&self) -> String {
        match self.source {
            Source::Env => format!("COLONY_ENGINE {} ({})", self.version(), self.root.display()),
            Source::Managed => format!("managed {}", self.version()),
        }
    }

    fn node_range(&self) -> &str {
        self.manifest.as_ref().map(|m| m.node.as_str()).unwrap_or("")
    }
}

// ---- contract range ------------------------------------------------------------------

fn major(v: &str, what: &str) -> Result<u64, String> {
    Version::parse(v.trim()).map(|v| v.major).map_err(|e| format!("{what} {v:?} is not a version: {e}"))
}

/// The engine's contracts must have the majors this Colony build supports.
pub fn check_range(m: &Manifest) -> Result<(), String> {
    let d = major(&m.driver_protocol, "driverProtocol")?;
    if d != DRIVER_PROTOCOL_MAJOR {
        return Err(format!(
            "engine {} speaks driver protocol {}; this Colony supports {DRIVER_PROTOCOL_MAJOR}.x (update Colony)",
            m.version, m.driver_protocol
        ));
    }
    let Some(data) = &m.dashboard_data_version else {
        return Err(format!("engine {} ships no Mission Control data version", m.version));
    };
    let s = major(data, "dashboardDataVersion")?;
    if s != DASHBOARD_DATA_MAJOR {
        return Err(format!(
            "engine {} serves Mission Control data {data}; this Colony reads {DASHBOARD_DATA_MAJOR}.x (update Colony)",
            m.version
        ));
    }
    Ok(())
}

pub fn supported_text() -> String {
    format!(
        "driver protocol {DRIVER_PROTOCOL_MAJOR}.x, Mission Control data {DASHBOARD_DATA_MAJOR}.x; installs engines with driver protocol {}",
        protocol_range_text()
    )
}

/// The range as people read it: `~1.2` is `1.2.x`, `>=1.2.0, <1.4.0` is `1.2.x-1.3.x`.
pub fn protocol_range_text() -> String {
    if let Some(v) = ENGINE_PROTOCOL_RANGE.strip_prefix('~') {
        return format!("{v}.x");
    }
    match (protocol_floor(), protocol_ceiling()) {
        (Some(lo), Some(hi)) if lo.major == hi.major && hi.patch == 0 && hi.minor > lo.minor => format!("{}.{}.x-{}.{}.x", lo.major, lo.minor, hi.major, hi.minor - 1),
        _ => ENGINE_PROTOCOL_RANGE.to_string(),
    }
}

/// The range's `>=` bound, when it has one.
fn protocol_floor() -> Option<Version> {
    protocol_req().comparators.iter().find(|c| c.op == semver::Op::GreaterEq).map(|c| Version::new(c.major, c.minor.unwrap_or(0), c.patch.unwrap_or(0)))
}

/// The range's `<` bound, when it has one.
fn protocol_ceiling() -> Option<Version> {
    protocol_req().comparators.iter().find(|c| c.op == semver::Op::Less).map(|c| Version::new(c.major, c.minor.unwrap_or(0), c.patch.unwrap_or(0)))
}

fn protocol_req() -> VersionReq {
    VersionReq::parse(ENGINE_PROTOCOL_RANGE).expect("ENGINE_PROTOCOL_RANGE is a semver requirement")
}

/// Whether the updater may install an engine speaking `protocol`.
pub fn protocol_installable(protocol: &str) -> bool {
    Version::parse(protocol.trim()).map(|v| protocol_req().matches(&v)).unwrap_or(false)
}

/// The updater's gate: the engine's driver protocol must be inside ENGINE_PROTOCOL_RANGE.
pub fn check_install_range(m: &Manifest) -> Result<(), String> {
    if protocol_installable(&m.driver_protocol) {
        return Ok(());
    }
    // Above the range (a newer protocol than this build reads), or below it.
    let newer = Version::parse(m.driver_protocol.trim())
        .map(|v| match protocol_ceiling() {
            Some(hi) => v >= hi,
            None => protocol_req().comparators.iter().all(|c| v.major > c.major || v.minor > c.minor.unwrap_or(0)),
        })
        .unwrap_or(false);
    Err(format!(
        "engine {} speaks driver protocol {}; this Colony installs engines with driver protocol {} ({})",
        m.version,
        m.driver_protocol,
        protocol_range_text(),
        if newer { "update Colony first, or install an older engine version" } else { "install a newer engine version" }
    ))
}

/// Stable kit release versions from a GitHub `releases` list, newest first (drafts,
/// prereleases and tags that are not `v<semver>` without a pre-release suffix are skipped).
pub fn release_versions(json: &str) -> Result<Vec<Version>, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("the releases list is not JSON: {e}"))?;
    let list = v.as_array().ok_or("the releases list is not an array")?;
    let mut out: Vec<Version> = list
        .iter()
        .filter(|r| !r.get("draft").and_then(|d| d.as_bool()).unwrap_or(false) && !r.get("prerelease").and_then(|d| d.as_bool()).unwrap_or(false))
        .filter_map(|r| r.get("tag_name")?.as_str().and_then(|t| Version::parse(t.trim_start_matches('v')).ok()))
        .filter(|v| v.pre.is_empty())
        .collect();
    out.sort_by(|a, b| b.cmp(a));
    out.dedup();
    Ok(out)
}

/// The newest of `versions` (newest first) whose published `engine.json` names a driver
/// protocol inside the range. `protocol_of` returns None when a release has no side
/// `engine.json` (kit releases before it was published): such a release is taken as it is
/// and the manifest inside the tarball decides after the download.
pub fn pick_in_range(versions: &[Version], mut protocol_of: impl FnMut(&Version) -> Option<String>) -> Result<String, String> {
    let mut skipped = Vec::new();
    for v in versions.iter().take(RELEASE_SCAN) {
        match protocol_of(v) {
            None => return Ok(v.to_string()),
            Some(p) if protocol_installable(&p) => return Ok(v.to_string()),
            Some(p) => skipped.push(format!("{v} (driver protocol {p})")),
        }
    }
    if versions.is_empty() {
        return Err("no kit release found".into());
    }
    Err(format!(
        "no kit release among the newest {} speaks driver protocol {} (skipped: {}); update Colony",
        versions.len().min(RELEASE_SCAN),
        protocol_range_text(),
        skipped.join(", ")
    ))
}

// ---- layouts ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub struct Layout {
    pub root: PathBuf,
    pub entry: PathBuf,
    pub serve: PathBuf,
}

/// Find `dist/index.js` and `dashboard/serve.mjs` under `path`: an extracted engine or a
/// built `packages/cli` (both next to each other), `packages/cli` of a checkout whose
/// dashboard copy was not synced (`../../dashboard`), or a checkout's repo root.
pub fn detect_layout(path: &Path) -> Result<Layout, String> {
    let cands = [
        (path.to_path_buf(), path.join("dashboard/serve.mjs")),
        (path.to_path_buf(), path.join("../../dashboard/serve.mjs")),
        (path.join("packages/cli"), path.join("dashboard/serve.mjs")),
    ];
    for (root, serve) in cands {
        let entry = root.join("dist/index.js");
        if entry.is_file() && serve.is_file() {
            let canon = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
            return Ok(Layout { root: canon(&root), entry: canon(&entry), serve: canon(&serve) });
        }
    }
    let unbuilt = path.join("src/index.ts").is_file() || path.join("packages/cli/src/index.ts").is_file();
    Err(if unbuilt {
        format!("{} is a kit checkout without a build: run `pnpm build` there", path.display())
    } else {
        format!("{} holds no dist/index.js with a dashboard/serve.mjs", path.display())
    })
}

fn read_manifest(root: &Path) -> Option<Result<Manifest, String>> {
    let text = std::fs::read_to_string(root.join("engine.json")).ok()?;
    Some(serde_json::from_str(&text).map_err(|e| format!("engine.json: {e}")))
}

/// `node <entry> engine-info --json` (kit 6.4+), for a checkout that has no engine.json.
fn probe(entry: &Path) -> Result<Manifest, String> {
    let node = tools::node_bin().ok_or("node not found on PATH")?;
    let out = Command::new(node)
        .arg(entry)
        .args(["engine-info", "--json"])
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("engine-info exited {}", out.status));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("engine-info output: {e}"))
}

/// `COLONY_ENGINE`: the operator's choice, so a missing contract is a note, not a refusal;
/// a contract outside the range is still refused.
fn env_engine(path: &Path) -> Result<Engine, String> {
    let layout = detect_layout(path).map_err(|e| format!("COLONY_ENGINE: {e}"))?;
    let (manifest, note) = match read_manifest(&layout.root) {
        Some(m) => (Some(m.map_err(|e| format!("COLONY_ENGINE: {e}"))?), None),
        None => match probe(&layout.entry) {
            Ok(m) => (Some(m), None),
            Err(e) => (None, Some(format!("contract not checked: {e} (a kit without `agent-kit engine-info`)"))),
        },
    };
    if let Some(m) = &manifest {
        check_range(m).map_err(|e| format!("COLONY_ENGINE: {e}"))?;
    }
    Ok(Engine { source: Source::Env, root: layout.root, entry: layout.entry, serve: layout.serve, manifest, note })
}

// ---- managed engines -------------------------------------------------------------------

/// `<platform data dir>/colony`: `$XDG_DATA_HOME` or `~/.local/share` on Linux,
/// `~/Library/Application Support` on macOS, `%APPDATA%` on Windows.
pub fn data_dir_with(env: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let set = |k: &str| env(k).filter(|v| !v.trim().is_empty()).map(PathBuf::from);
    let base = if cfg!(target_os = "macos") {
        set("HOME").map(|h| h.join("Library/Application Support"))
    } else if cfg!(windows) {
        set("APPDATA")
    } else {
        set("XDG_DATA_HOME").or_else(|| set("HOME").map(|h| h.join(".local/share")))
    };
    base.map(|b| b.join("colony"))
}

pub fn data_dir() -> Option<PathBuf> {
    data_dir_with(|k| std::env::var(k).ok())
}

#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
pub struct EngineState {
    current: Option<String>,
    previous: Option<String>,
}

fn read_state(dir: &Path) -> EngineState {
    std::fs::read_to_string(dir.join("state.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn write_state(dir: &Path, s: &EngineState) -> Result<(), String> {
    let tmp = dir.join(format!(".state-{}.json", unique()));
    std::fs::write(&tmp, serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join("state.json")).map_err(|e| e.to_string())
}

#[derive(Debug)]
pub struct Installed {
    pub version: Version,
    pub dir: PathBuf,
    pub manifest: Manifest,
    pub fit: Result<(), String>,
}

/// Installed engines (`<dir>/<semver>/engine.json`), highest version first.
pub fn list_installed(dir: &Path) -> Vec<Installed> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<Installed> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let version = Version::parse(&name).ok()?;
            let manifest = read_manifest(&e.path())?.ok()?;
            let fit = if manifest.version != name {
                Err(format!("engine.json says {}, folder says {name}", manifest.version))
            } else {
                check_range(&manifest).and_then(|_| detect_layout(&e.path()).map(|_| ()))
            };
            Some(Installed { version, dir: e.path(), manifest, fit })
        })
        .collect();
    out.sort_by(|a, b| b.version.cmp(&a.version));
    out
}

/// `state.current` when it is installed and fits, else the highest one that fits.
pub fn pick<'a>(installed: &'a [Installed], state: &EngineState) -> Option<&'a Installed> {
    let fits = |i: &&Installed| i.fit.is_ok();
    state
        .current
        .as_deref()
        .and_then(|c| installed.iter().filter(fits).find(|i| i.manifest.version == c))
        .or_else(|| installed.iter().find(fits))
}

fn managed_engine(dir: &Path) -> Option<Engine> {
    let installed = list_installed(dir);
    let chosen = pick(&installed, &read_state(dir))?;
    let layout = detect_layout(&chosen.dir).ok()?;
    Some(Engine { source: Source::Managed, root: layout.root, entry: layout.entry, serve: layout.serve, manifest: Some(chosen.manifest.clone()), note: None })
}

/// The engine to run, or None when only the unmanaged PATH fallback is left.
pub fn resolve_with(env: impl Fn(&str) -> Option<String>, data: Option<&Path>) -> Result<Option<Engine>, String> {
    if let Some(p) = env("COLONY_ENGINE").filter(|v| !v.trim().is_empty()) {
        return env_engine(Path::new(p.trim())).map(Some);
    }
    Ok(data.and_then(|d| managed_engine(&d.join("engine"))))
}

pub fn resolve() -> Result<Option<Engine>, String> {
    resolve_with(|k| std::env::var(k).ok(), data_dir().as_deref())
}

// ---- Node ------------------------------------------------------------------------------

pub fn parse_node_version(out: &str) -> Option<Version> {
    Version::parse(out.trim().trim_start_matches('v')).ok()
}

/// npm-style `engines.node`: `||` alternatives of semver requirements; empty means any.
pub fn node_satisfies(v: &Version, range: &str) -> bool {
    if range.trim().is_empty() {
        return true;
    }
    range.split("||").any(|alt| VersionReq::parse(alt.trim()).map(|r| r.matches(v)).unwrap_or(false))
}

fn node_version(bin: &Path) -> Option<Version> {
    let out = Command::new(bin).arg("--version").stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    out.status.success().then(|| parse_node_version(&String::from_utf8_lossy(&out.stdout))).flatten()
}

/// Node builds this module installed, newest first.
fn managed_nodes(runtime: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(runtime) else { return vec![] };
    let mut found: Vec<(Version, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let v = Version::parse(name.strip_prefix("node-")?).ok()?;
            let bin = e.path().join(if cfg!(windows) { "node.exe" } else { "bin/node" });
            bin.is_file().then_some((v, bin))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, p)| p).collect()
}

#[derive(Clone, Debug)]
pub struct NodeChoice {
    pub bin: PathBuf,
    pub version: Version,
    /// `system` (COLONY_NODE_BIN or PATH) or `managed` (Colony's runtime folder).
    pub source: &'static str,
}

pub fn resolve_node(range: &str) -> Result<NodeChoice, String> {
    let mut seen = Vec::new();
    if let Some(bin) = tools::node_bin() {
        match node_version(&bin) {
            Some(v) if node_satisfies(&v, range) => return Ok(NodeChoice { bin, version: v, source: "system" }),
            Some(v) => seen.push(format!("{} is {v}", bin.display())),
            None => seen.push(format!("{} did not report a version", bin.display())),
        }
    }
    if let Some(data) = data_dir() {
        for bin in managed_nodes(&data.join("runtime")) {
            if let Some(v) = node_version(&bin).filter(|v| node_satisfies(v, range)) {
                return Ok(NodeChoice { bin, version: v, source: "managed" });
            }
        }
    }
    let found = if seen.is_empty() { "no node on PATH".to_string() } else { seen.join("; ") };
    Err(format!("the engine needs Node {range} ({found}): install the Node runtime from Run → Engine…"))
}

// ---- what Colony spawns ----------------------------------------------------------------

/// How to run `agent-kit`: `program args... <subcommand>`.
#[derive(Clone, Debug)]
pub struct KitCommand {
    pub program: PathBuf,
    pub args: Vec<PathBuf>,
    /// `override`, `env`, `managed` or `unmanaged`.
    pub source: &'static str,
}

impl KitCommand {
    pub fn display(&self) -> String {
        std::iter::once(&self.program).chain(&self.args).map(|p| p.display().to_string()).collect::<Vec<_>>().join(" ")
    }
}

fn source_name(s: Source) -> &'static str {
    match s {
        Source::Env => "env",
        Source::Managed => "managed",
    }
}

/// `COLONY_AGENT_KIT_BIN`, else `<node> <engine>/dist/index.js`, else `agent-kit` on PATH.
pub fn kit_command() -> Result<KitCommand, String> {
    if let Some(p) = std::env::var_os("COLONY_AGENT_KIT_BIN").map(PathBuf::from).filter(|p| p.is_file()) {
        return Ok(KitCommand { program: p, args: vec![], source: "override" });
    }
    if let Some(engine) = resolve()? {
        let node = resolve_node(engine.node_range())?;
        return Ok(KitCommand { program: node.bin, args: vec![engine.entry.clone()], source: source_name(engine.source) });
    }
    let bin = tools::agent_kit_bin().ok_or("No Agent Kit engine: install one from Run → Engine… (or set COLONY_ENGINE)")?;
    Ok(KitCommand { program: bin, args: vec![], source: "unmanaged" })
}

/// The version of the kit `kit_command` runs, when it is known: None for the
/// `COLONY_AGENT_KIT_BIN` override, the PATH fallback and an unreadable checkout.
pub fn kit_version() -> Option<String> {
    if std::env::var_os("COLONY_AGENT_KIT_BIN").map(PathBuf::from).is_some_and(|p| p.is_file()) {
        return None;
    }
    resolve().ok().flatten().and_then(|e| e.manifest).map(|m| m.version)
}

/// The driver protocol of the kit `kit_command` runs: the manifest of a managed or
/// `COLONY_ENGINE` engine, else `<kit> engine-info --json` (kit 6.4+) for the
/// `COLONY_AGENT_KIT_BIN` override, the PATH fallback and a checkout without a readable
/// contract. None when neither answers (callers treat that as "too old").
pub fn kit_driver_protocol() -> Option<String> {
    let overridden = std::env::var_os("COLONY_AGENT_KIT_BIN").map(PathBuf::from).is_some_and(|p| p.is_file());
    if !overridden {
        if let Some(m) = resolve().ok().flatten().and_then(|e| e.manifest) {
            return Some(m.driver_protocol);
        }
    }
    let kit = kit_command().ok()?;
    engine_info_protocol(&kit.program, &kit.args)
}

/// `driverProtocol` from `<program> <args> engine-info --json`; None when it fails or omits it.
fn engine_info_protocol(program: &Path, args: &[PathBuf]) -> Option<String> {
    let out = Command::new(program)
        .args(args)
        .args(["engine-info", "--json"])
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let info: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    info.get("driverProtocol")?.as_str().map(String::from)
}

/// Mission Control server from the resolved engine, or None for the unmanaged fallback.
pub struct ServeChoice {
    pub node: PathBuf,
    pub serve: PathBuf,
    pub label: String,
}

pub fn engine_serve() -> Result<Option<ServeChoice>, String> {
    let Some(engine) = resolve()? else { return Ok(None) };
    let node = resolve_node(engine.node_range())?;
    Ok(Some(ServeChoice { node: node.bin, serve: engine.serve.clone(), label: engine.label() }))
}

// ---- downloads and checks --------------------------------------------------------------

fn unique() -> String {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{}-{n}", std::process::id())
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}

/// The hash `SHA256SUMS` / `SHASUMS256.txt` lists for `name` (`<hex>  <name>` or `<hex> *<name>`).
pub fn sum_for(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|l| {
        let (hash, file) = l.trim().split_once(char::is_whitespace)?;
        let file = file.trim_start().trim_start_matches('*');
        (file == name && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())).then(|| hash.to_ascii_lowercase())
    })
}

pub fn verify_sha256(path: &Path, sums: &str, name: &str) -> Result<String, String> {
    let want = sum_for(sums, name).ok_or_else(|| format!("{name} is not listed in the checksum file"))?;
    let got = sha256_file(path)?;
    if got != want {
        return Err(format!("{name}: sha256 {got} does not match the published {want}"));
    }
    Ok(got)
}

/// Check `sig` (a minisign signature file, prehashed Ed25519, as `minisign -S` writes it)
/// over the exact bytes of SHA256SUMS against `pubkey` (the `RW...` base64 line). The
/// global signature over the trusted comment is checked too. Returns the trusted comment.
pub fn verify_sums_signature(sums: &[u8], sig: &str, pubkey: &str) -> Result<String, String> {
    let pk = minisign_verify::PublicKey::from_base64(pubkey.trim()).map_err(|e| format!("engine signing public key is invalid: {e}"))?;
    let sig = minisign_verify::Signature::decode(sig).map_err(|e| format!("SHA256SUMS.minisig is not a minisign signature: {e}"))?;
    pk.verify(sums, &sig, false).map_err(|e| format!("signature check of SHA256SUMS failed: {e}"))?;
    Ok(sig.trusted_comment().to_string())
}

/// The signature step of an install. With no key configured it checks nothing and says so;
/// with a key it downloads `<rel>/SHA256SUMS.minisig` and fails closed when that file is
/// missing or does not verify. Runs before the tarball's sha256 is trusted.
fn verify_signature(pubkey: Option<&str>, rel: &str, sums: &[u8], tmp: &Path, name: &str) -> Result<String, String> {
    match pubkey {
        None => {
            let note = format!("signature not verified for {name}: no engine signing key is configured yet (SHA256SUMS checked)");
            eprintln!("colony engine: {note}");
            Ok(note)
        }
        Some(pk) => {
            let sig_path = tmp.join("SHA256SUMS.minisig");
            curl(&format!("{rel}/SHA256SUMS.minisig"), &sig_path).map_err(|e| format!("this release has no engine signature (SHA256SUMS.minisig), refusing to install: {e}"))?;
            let sig = std::fs::read_to_string(&sig_path).map_err(|e| e.to_string())?;
            let comment = verify_sums_signature(sums, &sig, pk)?;
            Ok(format!("signature ok ({comment})"))
        }
    }
}

fn curl(url: &str, out: &Path) -> Result<(), String> {
    let st = Command::new("curl")
        .args(["-fsSL", "--retry", "2", "--proto", "=https,file", "-o"])
        .arg(out)
        .arg(url)
        .stdin(Stdio::null())
        .status()
        .map_err(|e| format!("curl failed to start: {e}"))?;
    if !st.success() {
        return Err(format!("download failed ({st}): {url}"));
    }
    Ok(())
}

fn untar(archive: &Path, into: &Path) -> Result<(), String> {
    std::fs::create_dir_all(into).map_err(|e| e.to_string())?;
    let st = Command::new("tar").arg("-xzf").arg(archive).arg("-C").arg(into).stdin(Stdio::null()).status().map_err(|e| format!("tar failed to start: {e}"))?;
    if !st.success() {
        return Err(format!("tar could not extract {}", archive.display()));
    }
    Ok(())
}

fn release_repo() -> String {
    std::env::var("COLONY_ENGINE_REPO").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| DEFAULT_RELEASE_REPO.into())
}

/// `<base>/v<version>/<file>`; base defaults to the repo's GitHub release downloads.
fn download_base() -> String {
    std::env::var("COLONY_ENGINE_DOWNLOAD_BASE")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| format!("https://github.com/{}/releases/download", release_repo()))
        .trim_end_matches('/')
        .to_string()
}

/// The newest kit release inside ENGINE_PROTOCOL_RANGE: one GET of the release list, then
/// the small `engine.json` of each candidate, newest first, until one fits.
fn latest_version(tmp: &Path, base: &str) -> Result<String, String> {
    let out = tmp.join("releases.json");
    curl(&format!("https://api.github.com/repos/{}/releases?per_page=30", release_repo()), &out)?;
    let versions = release_versions(&std::fs::read_to_string(&out).map_err(|e| e.to_string())?)?;
    pick_in_range(&versions, |v| {
        let f = tmp.join(format!("engine-{v}.json"));
        curl(&format!("{base}/v{v}/engine.json"), &f).ok()?;
        let m: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&f).ok()?).ok()?;
        m.get("driverProtocol")?.as_str().map(String::from)
    })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub version: String,
    pub path: String,
    pub sha256: String,
    pub signature: String,
    pub previous: Option<String>,
}

/// Download, verify, unpack and switch to engine `version` under `engines`
/// (`<data dir>/colony/engine`). The previous current engine stays for `rollback`;
/// older ones are removed.
pub fn install_engine(engines: &Path, base: &str, version: &str) -> Result<InstallReport, String> {
    install_engine_with(engines, base, version, ENGINE_SIGNING_PUBKEY)
}

fn install_engine_with(engines: &Path, base: &str, version: &str, pubkey: Option<&str>) -> Result<InstallReport, String> {
    let version = version.trim().trim_start_matches('v');
    Version::parse(version).map_err(|e| format!("not a version: {version} ({e})"))?;
    std::fs::create_dir_all(engines).map_err(|e| e.to_string())?;
    let tmp = engines.join(format!(".tmp-{}", unique()));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let result = (|| {
        let name = format!("agent-kit-engine-{version}.tar.gz");
        let tarball = tmp.join(&name);
        let sums_path = tmp.join("SHA256SUMS");
        curl(&format!("{base}/v{version}/{name}"), &tarball)?;
        curl(&format!("{base}/v{version}/SHA256SUMS"), &sums_path)?;
        let sums_bytes = std::fs::read(&sums_path).map_err(|e| e.to_string())?;
        let signature = verify_signature(pubkey, &format!("{base}/v{version}"), &sums_bytes, &tmp, &name)?;
        let sums = String::from_utf8(sums_bytes).map_err(|_| "SHA256SUMS is not UTF-8".to_string())?;
        let sha = verify_sha256(&tarball, &sums, &name)?;
        let unpacked = tmp.join("engine");
        untar(&tarball, &unpacked)?;
        let manifest = read_manifest(&unpacked).ok_or("the engine artifact has no engine.json")??;
        if manifest.version != version {
            return Err(format!("engine.json says {}, expected {version}", manifest.version));
        }
        check_range(&manifest)?;
        check_install_range(&manifest)?;
        detect_layout(&unpacked)?;
        let target = engines.join(version);
        if target.exists() {
            let old = engines.join(format!(".old-{version}-{}", unique()));
            std::fs::rename(&target, &old).map_err(|e| e.to_string())?;
            std::fs::rename(&unpacked, &target).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_dir_all(&old);
        } else {
            std::fs::rename(&unpacked, &target).map_err(|e| e.to_string())?;
        }
        let mut state = read_state(engines);
        let installed = list_installed(engines);
        let was = pick(&installed, &state).map(|i| i.manifest.version.clone()).filter(|v| v != version);
        if was.is_some() {
            state.previous = was.clone();
        }
        state.current = Some(version.to_string());
        write_state(engines, &state)?;
        prune(engines, &state);
        Ok(InstallReport { version: version.to_string(), path: target.display().to_string(), sha256: sha, signature, previous: state.previous.clone() })
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

/// Keep the current and previous engines; remove other versions and leftovers.
fn prune(engines: &Path, state: &EngineState) {
    let keep = [state.current.as_deref(), state.previous.as_deref()];
    let Ok(entries) = std::fs::read_dir(engines) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let stale = name.starts_with(".old-") || (Version::parse(&name).is_ok() && !keep.contains(&Some(name.as_str())));
        if stale && e.path().is_dir() {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// Swap the current and previous engines.
pub fn rollback(engines: &Path) -> Result<String, String> {
    let mut state = read_state(engines);
    let installed = list_installed(engines);
    let current = pick(&installed, &state).map(|i| i.manifest.version.clone());
    let prev = state.previous.clone().ok_or("No previous engine to roll back to")?;
    if !installed.iter().any(|i| i.manifest.version == prev && i.fit.is_ok()) {
        return Err(format!("The previous engine {prev} is not installed or not supported"));
    }
    state.previous = current;
    state.current = Some(prev.clone());
    write_state(engines, &state)?;
    Ok(prev)
}

fn node_build() -> Result<(&'static str, &'static str), String> {
    NODE_BUILDS
        .iter()
        .find(|(os, arch, _, _)| *os == std::env::consts::OS && *arch == std::env::consts::ARCH)
        .map(|(_, _, platform, sha)| (*platform, *sha))
        .ok_or_else(|| format!("Installing the Node runtime is not available on {}-{} yet: install Node {NODE_VERSION} (or any version the engine accepts) yourself", std::env::consts::OS, std::env::consts::ARCH))
}

/// Download the pinned Node build into `<runtime>/node-<version>/`.
pub fn install_node(runtime: &Path, base: &str) -> Result<String, String> {
    let (platform, pinned) = node_build()?;
    let target = runtime.join(format!("node-{NODE_VERSION}"));
    if target.join("bin/node").is_file() {
        return Ok(format!("Node {NODE_VERSION} is already installed in {}", target.display()));
    }
    std::fs::create_dir_all(runtime).map_err(|e| e.to_string())?;
    let tmp = runtime.join(format!(".tmp-{}", unique()));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let result = (|| {
        let name = format!("node-v{NODE_VERSION}-{platform}.tar.gz");
        let archive = tmp.join(&name);
        let sums_path = tmp.join("SHASUMS256.txt");
        curl(&format!("{base}/v{NODE_VERSION}/SHASUMS256.txt"), &sums_path)?;
        let sums = std::fs::read_to_string(&sums_path).map_err(|e| e.to_string())?;
        if sum_for(&sums, &name).as_deref() != Some(pinned) {
            return Err(format!("SHASUMS256.txt does not list the pinned sha256 for {name}"));
        }
        curl(&format!("{base}/v{NODE_VERSION}/{name}"), &archive)?;
        verify_sha256(&archive, &sums, &name)?;
        let unpacked = tmp.join("x");
        untar(&archive, &unpacked)?;
        let inner = unpacked.join(format!("node-v{NODE_VERSION}-{platform}"));
        if !inner.join("bin/node").is_file() {
            return Err(format!("{name} has no bin/node"));
        }
        std::fs::rename(&inner, &target).map_err(|e| e.to_string())?;
        Ok(format!("Node {NODE_VERSION} installed in {}", target.display()))
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

// ---- Tauri commands ------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledInfo {
    version: String,
    current: bool,
    supported: bool,
    reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    /// `env`, `managed`, `unmanaged` or `none`.
    source: String,
    label: String,
    root: Option<String>,
    manifest: Option<Manifest>,
    error: Option<String>,
    note: Option<String>,
    node: Option<String>,
    node_version: Option<String>,
    node_source: Option<String>,
    node_error: Option<String>,
    node_pin: String,
    installed: Vec<InstalledInfo>,
    previous: Option<String>,
    data_dir: Option<String>,
    supported: String,
    release_repo: String,
    /// Engine of the Mission Control server running now, if any.
    dashboard: Option<String>,
    agent_kit_override: Option<String>,
    dashboard_override: Option<String>,
}

/// Off the main thread: a `COLONY_ENGINE` checkout without engine.json spawns the CLI probe.
#[tauri::command(async)]
pub fn engine_status(state: State<'_, AppState>) -> EngineStatus {
    let data = data_dir();
    let engines = data.as_ref().map(|d| d.join("engine"));
    let installed = engines.as_deref().map(list_installed).unwrap_or_default();
    let st = engines.as_deref().map(read_state).unwrap_or_default();
    let current = pick(&installed, &st).map(|i| i.manifest.version.clone());
    let (source, label, root, manifest, error, note, range) = match resolve() {
        Ok(Some(e)) => (source_name(e.source).to_string(), e.label(), Some(e.root.display().to_string()), e.manifest.clone(), None, e.note.clone(), e.node_range().to_string()),
        Ok(None) => match tools::agent_kit_bin() {
            Some(b) => ("unmanaged".into(), format!("unmanaged engine: {} on PATH", b.display()), None, None, None, None, String::new()),
            None => ("none".into(), "no engine".into(), None, None, Some("No Agent Kit engine installed".to_string()), None, String::new()),
        },
        Err(e) => ("none".into(), "engine error".into(), None, None, Some(e), None, String::new()),
    };
    let (node, node_version, node_source, node_error) = match resolve_node(&range) {
        Ok(n) => (Some(n.bin.display().to_string()), Some(n.version.to_string()), Some(n.source.to_string()), None),
        Err(e) => (None, None, None, Some(e)),
    };
    EngineStatus {
        source,
        label,
        root,
        manifest,
        error,
        note,
        node,
        node_version,
        node_source,
        node_error,
        node_pin: NODE_VERSION.into(),
        installed: installed
            .iter()
            .map(|i| InstalledInfo {
                version: i.manifest.version.clone(),
                current: current.as_deref() == Some(i.manifest.version.as_str()),
                supported: i.fit.is_ok(),
                reason: i.fit.clone().err(),
            })
            .collect(),
        previous: st.previous.clone(),
        data_dir: data.map(|d| d.display().to_string()),
        supported: supported_text(),
        release_repo: release_repo(),
        dashboard: state.dashboard.lock().ok().and_then(|d| d.as_ref().map(|s| s.engine().to_string())),
        agent_kit_override: std::env::var("COLONY_AGENT_KIT_BIN").ok().filter(|v| !v.is_empty()),
        dashboard_override: std::env::var("COLONY_DASHBOARD_SERVE").ok().filter(|v| !v.is_empty()),
    }
}

fn engines_dir() -> Result<PathBuf, String> {
    data_dir().map(|d| d.join("engine")).ok_or_else(|| "No data folder (HOME is not set)".into())
}

/// Install `version` (or the latest release) of the engine. Mission Control keeps the
/// engine it started with until the folder is reopened; new agent runs use the new one.
#[tauri::command]
pub async fn engine_install(version: Option<String>) -> Result<InstallReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = INSTALL_LOCK.lock().map_err(|_| "install lock poisoned")?;
        let engines = engines_dir()?;
        let version = match version.filter(|v| !v.trim().is_empty()) {
            Some(v) => v,
            None => {
                std::fs::create_dir_all(&engines).map_err(|e| e.to_string())?;
                let tmp = engines.join(format!(".tmp-{}", unique()));
                std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
                let v = latest_version(&tmp, &download_base());
                let _ = std::fs::remove_dir_all(&tmp);
                v?
            }
        };
        install_engine(&engines, &download_base(), &version)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn engine_rollback() -> Result<String, String> {
    let _guard = INSTALL_LOCK.lock().map_err(|_| "install lock poisoned")?;
    rollback(&engines_dir()?)
}

#[tauri::command]
pub async fn engine_install_node() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let _guard = INSTALL_LOCK.lock().map_err(|_| "install lock poisoned")?;
        let runtime = data_dir().map(|d| d.join("runtime")).ok_or("No data folder (HOME is not set)")?;
        let base = std::env::var("COLONY_NODE_DIST_BASE").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| "https://nodejs.org/dist".into());
        install_node(&runtime, base.trim_end_matches('/'))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("colony-engine-test-{tag}-{}", unique()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[cfg(unix)]
    #[test]
    fn engine_info_driver_protocol() {
        use std::os::unix::fs::PermissionsExt;
        let d = scratch("engine-info");
        let script = |name: &str, body: &str| {
            let p = d.join(name);
            fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
            p
        };
        let ok = script("kit-ok", r#"[ "$1 $2" = "engine-info --json" ] && echo '{"version":"6.8.0","driverProtocol":"1.2.0"}'"#);
        assert_eq!(engine_info_protocol(&ok, &[]).as_deref(), Some("1.2.0"));
        // A kit before engine-info (exit 1), garbage output, or no driverProtocol field: unknown.
        assert_eq!(engine_info_protocol(&script("kit-old", "exit 1"), &[]), None);
        assert_eq!(engine_info_protocol(&script("kit-junk", "echo not json"), &[]), None);
        assert_eq!(engine_info_protocol(&script("kit-nofield", r#"echo '{"version":"6.3.0"}'"#), &[]), None);
        assert_eq!(engine_info_protocol(&d.join("missing"), &[]), None);
        // The COLONY_SMOKE kit fixture announces 1.3.0 (token usage): the queue driver runs on
        // it and the updater would install it.
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../packaging/smoke/fake-agent-kit.sh");
        let p = engine_info_protocol(Path::new("/bin/sh"), &[fixture]);
        assert_eq!(p.as_deref(), Some("1.3.0"));
        assert!(crate::agent::queue_driver(p.as_deref()));
        assert!(protocol_installable(p.as_deref().unwrap()));
    }

    fn manifest(version: &str, driver: &str, data: Option<&str>) -> Manifest {
        Manifest {
            name: "@dadado/agent-kit-cli".into(),
            version: version.into(),
            node: ">=22.12".into(),
            driver_protocol: driver.into(),
            dashboard_data_version: data.map(String::from),
            entry: default_entry(),
            dashboard_serve: default_serve(),
        }
    }

    /// An extracted engine: engine.json, dist/index.js, dashboard/serve.mjs.
    fn engine_dir(at: &Path, m: &Manifest) {
        fs::create_dir_all(at.join("dist")).unwrap();
        fs::create_dir_all(at.join("dashboard")).unwrap();
        fs::write(at.join("dist/index.js"), "console.log('x')\n").unwrap();
        fs::write(at.join("dashboard/serve.mjs"), "export {}\n").unwrap();
        fs::write(at.join("engine.json"), serde_json::to_string(m).unwrap()).unwrap();
    }

    #[test]
    fn range_is_keyed_on_both_majors() {
        assert!(check_range(&manifest("6.3.0", "1.1.0", Some("1.6.0"))).is_ok());
        assert!(check_range(&manifest("7.0.0", "1.9.3", Some("1.0.0"))).is_ok());
        let e = check_range(&manifest("7.0.0", "2.0.0", Some("1.6.0"))).unwrap_err();
        assert!(e.contains("driver protocol 2.0.0"), "{e}");
        let e = check_range(&manifest("7.0.0", "1.1.0", Some("2.0.0"))).unwrap_err();
        assert!(e.contains("Mission Control data 2.0.0"), "{e}");
        assert!(check_range(&manifest("7.0.0", "1.1.0", None)).is_err());
        assert!(check_range(&manifest("7.0.0", "one", Some("1.6.0"))).is_err());
    }

    #[test]
    fn manifest_parses_the_kit_engine_json() {
        let text = r#"{"manifestVersion":1,"name":"@dadado/agent-kit-cli","version":"6.3.0","node":">=22.12","driverProtocol":"1.1.0","dashboardDataVersion":"1.6.0","entry":"dist/index.js","dashboardServe":"dashboard/serve.mjs"}"#;
        let m: Manifest = serde_json::from_str(text).unwrap();
        assert_eq!(m, manifest("6.3.0", "1.1.0", Some("1.6.0")));
    }

    #[test]
    fn layouts_extracted_package_and_checkout() {
        let root = scratch("layout");
        // Extracted engine / built packages/cli with its dashboard copy.
        let ext = root.join("ext");
        engine_dir(&ext, &manifest("6.3.0", "1.1.0", Some("1.6.0")));
        let l = detect_layout(&ext).unwrap();
        assert_eq!(l.root, ext.canonicalize().unwrap());
        assert!(l.serve.ends_with("ext/dashboard/serve.mjs"));
        // Checkout: dashboard/ at the repo root, packages/cli without the synced copy.
        let repo = root.join("kit");
        fs::create_dir_all(repo.join("packages/cli/dist")).unwrap();
        fs::create_dir_all(repo.join("dashboard")).unwrap();
        fs::write(repo.join("packages/cli/dist/index.js"), "").unwrap();
        fs::write(repo.join("dashboard/serve.mjs"), "").unwrap();
        let from_cli = detect_layout(&repo.join("packages/cli")).unwrap();
        assert_eq!(from_cli.serve, repo.join("dashboard/serve.mjs").canonicalize().unwrap());
        let from_root = detect_layout(&repo).unwrap();
        assert_eq!(from_root.entry, repo.join("packages/cli/dist/index.js").canonicalize().unwrap());
        assert_eq!(from_root.root, repo.join("packages/cli").canonicalize().unwrap());
        // Unbuilt checkout: a precise hint.
        let raw = root.join("raw");
        fs::create_dir_all(raw.join("packages/cli/src")).unwrap();
        fs::write(raw.join("packages/cli/src/index.ts"), "").unwrap();
        assert!(detect_layout(&raw).unwrap_err().contains("pnpm build"));
        assert!(detect_layout(&root.join("nothing")).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resolution_order_env_then_managed_then_none() {
        let root = scratch("resolve");
        let data = root.join("data");
        let env_dir = root.join("checkout");
        engine_dir(&env_dir, &manifest("9.0.0", "1.1.0", Some("1.6.0")));
        engine_dir(&data.join("engine/6.3.0"), &manifest("6.3.0", "1.1.0", Some("1.6.0")));
        let env_path = env_dir.display().to_string();
        let with_env = |k: &str| (k == "COLONY_ENGINE").then(|| env_path.clone());
        let e = resolve_with(with_env, Some(&data)).unwrap().unwrap();
        assert_eq!((e.source, e.version()), (Source::Env, "9.0.0"));
        let e = resolve_with(|_| None, Some(&data)).unwrap().unwrap();
        assert_eq!((e.source, e.version()), (Source::Managed, "6.3.0"));
        assert!(resolve_with(|_| None, Some(&root.join("empty"))).unwrap().is_none());
        assert!(resolve_with(|_| None, None).unwrap().is_none());
        // A broken COLONY_ENGINE is an error, never a silent fall-through.
        let bad = |k: &str| (k == "COLONY_ENGINE").then(|| "/nonexistent/kit".to_string());
        assert!(resolve_with(bad, Some(&data)).unwrap_err().starts_with("COLONY_ENGINE"));
        // An out-of-range COLONY_ENGINE is refused.
        let newer = root.join("newer");
        engine_dir(&newer, &manifest("10.0.0", "2.0.0", Some("1.6.0")));
        let newer_path = newer.display().to_string();
        assert!(resolve_with(|k: &str| (k == "COLONY_ENGINE").then(|| newer_path.clone()), Some(&data)).unwrap_err().contains("update Colony"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_pick_prefers_current_then_highest_in_range() {
        let root = scratch("pick");
        engine_dir(&root.join("6.3.0"), &manifest("6.3.0", "1.1.0", Some("1.6.0")));
        engine_dir(&root.join("6.4.0"), &manifest("6.4.0", "1.2.0", Some("1.7.0")));
        engine_dir(&root.join("7.0.0"), &manifest("7.0.0", "2.0.0", Some("2.0.0")));
        engine_dir(&root.join("6.5.0"), &manifest("6.4.9", "1.1.0", Some("1.6.0"))); // mislabeled
        let installed = list_installed(&root);
        assert_eq!(installed.iter().map(|i| i.version.to_string()).collect::<Vec<_>>(), ["7.0.0", "6.5.0", "6.4.0", "6.3.0"]);
        let none = EngineState::default();
        assert_eq!(pick(&installed, &none).unwrap().manifest.version, "6.4.0");
        let cur = EngineState { current: Some("6.3.0".into()), previous: None };
        assert_eq!(pick(&installed, &cur).unwrap().manifest.version, "6.3.0");
        let out = EngineState { current: Some("7.0.0".into()), previous: None };
        assert_eq!(pick(&installed, &out).unwrap().manifest.version, "6.4.0");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn node_versions_and_ranges() {
        let v = parse_node_version("v22.12.0\n").unwrap();
        assert!(node_satisfies(&v, ">=22.12"));
        assert!(!node_satisfies(&parse_node_version("v22.11.9").unwrap(), ">=22.12"));
        assert!(node_satisfies(&parse_node_version("v20.19.1").unwrap(), "^20.19 || >=22.12"));
        assert!(node_satisfies(&parse_node_version("v18.0.0").unwrap(), ""));
        assert!(parse_node_version("not node").is_none());
    }

    #[test]
    fn sha256_sums_and_verify() {
        let root = scratch("sha");
        let f = root.join("a.tar.gz");
        fs::write(&f, b"abc").unwrap();
        let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert_eq!(sha256_file(&f).unwrap(), abc);
        let sums = format!("{}  other.tar.gz\n{abc}  a.tar.gz\n", "0".repeat(64));
        assert_eq!(sum_for(&sums, "a.tar.gz").as_deref(), Some(abc));
        assert_eq!(sum_for(&format!("{abc} *a.tar.gz"), "a.tar.gz").as_deref(), Some(abc));
        assert!(sum_for(&sums, "b.tar.gz").is_none());
        assert!(verify_sha256(&f, &sums, "a.tar.gz").is_ok());
        let wrong = format!("{}  a.tar.gz\n", "1".repeat(64));
        assert!(verify_sha256(&f, &wrong, "a.tar.gz").unwrap_err().contains("does not match"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn data_dir_follows_xdg() {
        if cfg!(target_os = "linux") {
            let d = data_dir_with(|k| match k {
                "XDG_DATA_HOME" => Some("/x/share".into()),
                "HOME" => Some("/home/u".into()),
                _ => None,
            });
            assert_eq!(d, Some(PathBuf::from("/x/share/colony")));
            let d = data_dir_with(|k| (k == "HOME").then(|| "/home/u".to_string()));
            assert_eq!(d, Some(PathBuf::from("/home/u/.local/share/colony")));
        }
    }

    /// Package an engine the way the kit does (flat tar.gz + SHA256SUMS) under
    /// `<base>/v<version>/`, served over file://.
    fn publish(base: &Path, m: &Manifest) {
        let src = base.join(format!("src-{}", m.version));
        engine_dir(&src, m);
        let rel = base.join(format!("v{}", m.version));
        fs::create_dir_all(&rel).unwrap();
        let name = format!("agent-kit-engine-{}.tar.gz", m.version);
        let st = Command::new("tar").arg("-czf").arg(rel.join(&name)).arg("-C").arg(&src).arg(".").status().unwrap();
        assert!(st.success());
        let sha = sha256_file(&rel.join(&name)).unwrap();
        fs::write(rel.join("SHA256SUMS"), format!("{sha}  {name}\n")).unwrap();
    }

    #[test]
    fn install_verify_switch_and_roll_back() {
        let root = scratch("install");
        let base = root.join("releases");
        publish(&base, &manifest("6.3.0", "1.2.0", Some("1.6.0")));
        publish(&base, &manifest("6.4.0", "1.2.1", Some("1.6.0")));
        publish(&base, &manifest("6.5.0", "1.4.0", Some("1.6.0")));
        publish(&base, &manifest("6.1.0", "1.1.0", Some("1.6.0")));
        publish(&base, &manifest("7.0.0", "2.0.0", Some("1.6.0")));
        let url = format!("file://{}", base.display());
        let engines = root.join("data/engine");

        let r = install_engine(&engines, &url, "6.3.0").unwrap();
        assert_eq!((r.version.as_str(), r.previous.as_deref()), ("6.3.0", None));
        assert!(r.signature.contains("not verified"));
        let r = install_engine(&engines, &url, "v6.4.0").unwrap();
        assert_eq!(r.previous.as_deref(), Some("6.3.0"));
        assert_eq!(resolve_with(|_| None, Some(&root.join("data"))).unwrap().unwrap().version(), "6.4.0");

        // Out of range: refused before anything moves.
        assert!(install_engine(&engines, &url, "7.0.0").unwrap_err().contains("update Colony"));
        assert!(!engines.join("7.0.0").exists());
        // Same major, outside the updater range: refused with what to do instead.
        let e = install_engine(&engines, &url, "6.5.0").unwrap_err();
        assert!(e.contains("driver protocol 1.4.0") && e.contains("1.2.x-1.3.x") && e.contains("update Colony first"), "{e}");
        let e = install_engine(&engines, &url, "6.1.0").unwrap_err();
        assert!(e.contains("install a newer engine version"), "{e}");
        assert!(!engines.join("6.5.0").exists() && !engines.join("6.1.0").exists());
        // Tampered artifact: refused on the checksum.
        let tampered = base.join("v6.4.0/SHA256SUMS");
        fs::write(&tampered, format!("{}  agent-kit-engine-6.4.0.tar.gz\n", "0".repeat(64))).unwrap();
        assert!(install_engine(&engines, &url, "6.4.0").unwrap_err().contains("does not match"));
        assert!(engines.join("6.4.0/engine.json").is_file(), "a failed reinstall keeps the installed engine");
        // Missing release: a download error.
        assert!(install_engine(&engines, &url, "6.9.9").is_err());

        assert_eq!(rollback(&engines).unwrap(), "6.3.0");
        assert_eq!(resolve_with(|_| None, Some(&root.join("data"))).unwrap().unwrap().version(), "6.3.0");
        assert_eq!(rollback(&engines).unwrap(), "6.4.0");
        // No leftovers besides the two engines and the state file.
        let mut names: Vec<String> = fs::read_dir(&engines).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        names.sort();
        assert_eq!(names, ["6.3.0", "6.4.0", "state.json"]);
        fs::remove_dir_all(root).unwrap();
    }

    /// The real kit artifact (kit `scripts/build-engine-artifact.mjs`), served from a folder
    /// laid out like a release: `COLONY_TEST_ENGINE_RELEASES=<dir>` holding
    /// `v<ver>/agent-kit-engine-<ver>.tar.gz` and `v<ver>/SHA256SUMS`,
    /// `COLONY_TEST_ENGINE_VERSION=<ver>`, `COLONY_TEST_DATA=<data dir to install into>`.
    /// Run: `cargo test -- --ignored installs_a_real_kit_artifact`.
    #[test]
    #[ignore]
    fn installs_a_real_kit_artifact() {
        let get = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("set {k}"));
        let (releases, version, data) = (get("COLONY_TEST_ENGINE_RELEASES"), get("COLONY_TEST_ENGINE_VERSION"), PathBuf::from(get("COLONY_TEST_DATA")));
        let r = install_engine(&data.join("engine"), &format!("file://{releases}"), &version).unwrap();
        assert_eq!(r.version, version);
        let e = resolve_with(|_| None, Some(&data)).unwrap().unwrap();
        assert_eq!((e.source, e.version()), (Source::Managed, version.as_str()));
        check_range(e.manifest.as_ref().unwrap()).unwrap();
        let node = resolve_node(&e.manifest.as_ref().unwrap().node).unwrap();
        let out = Command::new(&node.bin).arg(&e.entry).arg("--version").output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), version);
        let probed = probe(&e.entry).unwrap();
        assert_eq!(&probed, e.manifest.as_ref().unwrap());
    }

    /// Network: download the pinned Node build from nodejs.org into a scratch folder.
    /// Run: `cargo test -- --ignored installs_the_pinned_node`.
    #[test]
    #[ignore]
    fn installs_the_pinned_node() {
        let root = scratch("node");
        let msg = install_node(&root, "https://nodejs.org/dist").unwrap();
        assert!(msg.contains(NODE_VERSION), "{msg}");
        let bin = root.join(format!("node-{NODE_VERSION}/bin/node"));
        assert_eq!(node_version(&bin).unwrap().to_string(), NODE_VERSION);
        assert_eq!(managed_nodes(&root), vec![bin]);
        assert!(install_node(&root, "https://nodejs.org/dist").unwrap().contains("already installed"));
        fs::remove_dir_all(root).unwrap();
    }

    /// A minisign signature over a SHA256SUMS line, made with a throwaway key
    /// (`tauri signer`, the same minisign format `minisign -S` writes).
    const FIX_PUB: &str = "RWQgIS4uZPcTTSdNhXPrN661GKyz5VZXqqHGG34o7F4lNTENh6g9kxRL";
    const FIX_OTHER_PUB: &str = "RWSZ9YpILrjjXAp6NpED7dwKXw5xjxzz9C3ATKsXtagiPrNgcAwgvAjN";
    const FIX_SUMS: &str = "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881  agent-kit-engine-6.3.0.tar.gz\n";
    const FIX_SIG: &str = "untrusted comment: signature from tauri secret key\nRUQgIS4uZPcTTT5Xa+XlEz7lWVJ34KNoIR8MJCcwxKzvyNrBf3DfE4hkFS75yZXKRPnu5876xUkgw8Ay8lUyW9ihslEbqhMpvA8=\ntrusted comment: timestamp:1792819882\tfile:SHA256SUMS\nlUpHX2U9fEVdVddpKSQ1OjXLrK4MD23tJzNIwEIPdUrlToc0Q5oveOXjidt6bEmxmFRNqUg88P7jOsr2lMK7Bw==\n";

    #[test]
    fn engine_signature_over_sha256sums() {
        assert!(verify_sums_signature(FIX_SUMS.as_bytes(), FIX_SIG, FIX_PUB).unwrap().contains("file:SHA256SUMS"));
        // A changed SHA256SUMS, another key, a changed trusted comment, garbage: refused.
        let tampered = FIX_SUMS.replace("6.3.0", "6.3.1");
        assert!(verify_sums_signature(tampered.as_bytes(), FIX_SIG, FIX_PUB).unwrap_err().contains("failed"));
        assert!(verify_sums_signature(FIX_SUMS.as_bytes(), FIX_SIG, FIX_OTHER_PUB).is_err());
        let comment = FIX_SIG.replace("timestamp:1792819882", "timestamp:1792819883");
        assert!(verify_sums_signature(FIX_SUMS.as_bytes(), &comment, FIX_PUB).is_err());
        assert!(verify_sums_signature(FIX_SUMS.as_bytes(), "not a signature", FIX_PUB).is_err());
        assert!(verify_sums_signature(FIX_SUMS.as_bytes(), FIX_SIG, "RWnotakey").is_err());
    }

    #[test]
    fn a_configured_key_needs_a_valid_signature_on_the_release() {
        let root = scratch("signed");
        let base = root.join("releases");
        publish(&base, &manifest("6.3.0", "1.2.0", Some("1.6.0")));
        let url = format!("file://{}", base.display());
        let engines = root.join("engine");
        // No SHA256SUMS.minisig on the release: refused before anything is unpacked.
        let e = install_engine_with(&engines, &url, "6.3.0", Some(FIX_PUB)).unwrap_err();
        assert!(e.contains("no engine signature"), "{e}");
        // A signature that does not match this SHA256SUMS: refused.
        fs::write(base.join("v6.3.0/SHA256SUMS.minisig"), FIX_SIG).unwrap();
        let e = install_engine_with(&engines, &url, "6.3.0", Some(FIX_PUB)).unwrap_err();
        assert!(e.contains("signature check of SHA256SUMS failed"), "{e}");
        assert!(!engines.join("6.3.0").exists());
        // No key configured: installs on the checksum and says the signature was not checked.
        let r = install_engine_with(&engines, &url, "6.3.0", None).unwrap();
        assert!(r.signature.contains("not verified"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn updater_range_and_release_pick() {
        // 1.3.0 (token usage on tick_end / run_end) is the newest protocol this build reads;
        // 1.2.x engines still install (their runs show "no usage").
        assert_eq!(protocol_range_text(), "1.2.x-1.3.x");
        assert!(protocol_installable("1.2.0") && protocol_installable("1.2.7") && protocol_installable("1.3.0") && protocol_installable("1.3.4"));
        assert!(!protocol_installable("1.1.0") && !protocol_installable("1.4.0") && !protocol_installable("2.2.0") && !protocol_installable("x"));
        assert!(!protocol_installable("1.3.0-rc.1") && !protocol_installable("1.2.0-rc.1"), "pre-releases never install");

        let json = r#"[
            {"tag_name":"v6.11.0-rc.1","draft":false,"prerelease":true},
            {"tag_name":"v6.10.0","draft":false,"prerelease":false},
            {"tag_name":"v6.12.0","draft":true,"prerelease":false},
            {"tag_name":"v6.9.0","draft":false,"prerelease":false},
            {"tag_name":"landing-2026","draft":false,"prerelease":false},
            {"tag_name":"v6.8.0","draft":false,"prerelease":false}
        ]"#;
        let vs = release_versions(json).unwrap();
        assert_eq!(vs.iter().map(|v| v.to_string()).collect::<Vec<_>>(), ["6.10.0", "6.9.0", "6.8.0"]);

        // Newest inside the range wins; a newer release on 1.4 is skipped.
        let proto = |v: &Version| Some(if v.minor >= 10 { "1.4.0" } else { "1.2.0" }.to_string());
        assert_eq!(pick_in_range(&vs, proto).unwrap(), "6.9.0");
        let proto13 = |v: &Version| Some(if v.minor >= 10 { "1.3.0" } else { "1.2.0" }.to_string());
        assert_eq!(pick_in_range(&vs, proto13).unwrap(), "6.10.0");
        // No side engine.json (older kit releases): taken, the tarball manifest decides.
        assert_eq!(pick_in_range(&vs, |_| None).unwrap(), "6.10.0");
        // Nothing fits: a clear message naming what was skipped.
        let e = pick_in_range(&vs, |_| Some("2.0.0".into())).unwrap_err();
        assert!(e.contains("1.2.x") && e.contains("6.10.0 (driver protocol 2.0.0)") && e.contains("update Colony"), "{e}");
        assert!(pick_in_range(&[], |_| None).is_err());
    }

    #[test]
    fn prune_keeps_current_and_previous() {
        let root = scratch("prune");
        let base = root.join("releases");
        for v in ["6.3.0", "6.4.0", "6.5.0"] {
            publish(&base, &manifest(v, "1.2.0", Some("1.6.0")));
        }
        let url = format!("file://{}", base.display());
        let engines = root.join("engine");
        for v in ["6.3.0", "6.4.0", "6.5.0"] {
            install_engine(&engines, &url, v).unwrap();
        }
        assert!(!engines.join("6.3.0").exists());
        assert!(engines.join("6.4.0").is_dir() && engines.join("6.5.0").is_dir());
        fs::remove_dir_all(root).unwrap();
    }
}
