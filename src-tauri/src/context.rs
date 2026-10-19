//! Context sources: the instruction and memory files an agent CLI loads for a working
//! folder, so an agent tab can show them (a run started in one folder can pull in the
//! memory of another project when the agent keys its memory by the start folder).
//!
//! Read-only: only paths, existence, sizes and line counts leave this module, never file
//! contents. The paths found here (and only those) may then be opened through the normal
//! editor commands even when they lie outside the opened folder (`allowed`, used by
//! `workspace::jail`), the same exemption the settings file has.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

/// Files above this size are reported without a line count.
const MAX_COUNT_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    /// Short human label ("User CLAUDE.md", "Project memory", ...).
    pub label: String,
    /// `user`, `project`, `parent`, `agents`, `handoff`, `memory`, `rules`.
    pub kind: String,
    pub path: String,
    pub exists: bool,
    pub bytes: Option<u64>,
    pub lines: Option<u64>,
    /// Memory and rules folders: how many files sit next to the index.
    pub files: Option<u32>,
    pub note: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ContextReport {
    pub cwd: String,
    pub engine: String,
    /// Which loader the list follows: `claude`, `codex` or `cursor`.
    pub family: String,
    /// Claude Code project folder name for `cwd` (claude family only).
    pub slug: Option<String>,
    pub sources: Vec<Source>,
}

/// Longest project folder name Claude Code writes as is (its `MAX_SANITIZED_LENGTH`).
const MAX_SANITIZED_LENGTH: usize = 200;

/// Claude Code's project folder name for a working folder, as Claude Code 2.1.302 builds it:
/// every UTF-16 code unit that is not an ASCII letter or digit becomes `-` (so `/` and `.`
/// map to `-`, a `-` stays, case is kept, and a character outside the BMP such as an emoji
/// gives two dashes), and a name longer than 200 characters is cut at 200 and gets `-` plus
/// a base36 hash of the folder path (a 32-bit `h * 31 + unit` over its UTF-16 code units).
pub fn project_slug(cwd: &str) -> String {
    let mut slug = String::with_capacity(cwd.len());
    for c in cwd.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else {
            slug.extend(std::iter::repeat_n('-', c.len_utf16()));
        }
    }
    if slug.len() <= MAX_SANITIZED_LENGTH {
        return slug;
    }
    let hash = cwd.encode_utf16().fold(0i32, |h, u| h.wrapping_shl(5).wrapping_sub(h).wrapping_add(i32::from(u)));
    slug.truncate(MAX_SANITIZED_LENGTH);
    format!("{slug}-{}", base36(hash.unsigned_abs()))
}

fn base36(mut n: u32) -> String {
    let mut digits = Vec::new();
    loop {
        digits.push(char::from_digit(n % 36, 36).unwrap_or('0'));
        n /= 36;
        if n == 0 {
            break;
        }
    }
    digits.iter().rev().collect()
}

/// Engine (driver backend or vendor CLI name) to loader family.
pub fn family(engine: &str) -> &'static str {
    match engine {
        "codex" => "codex",
        "cursor-agent" | "cursor-acp" | "cursor" => "cursor",
        _ => "claude",
    }
}

fn stat(label: &str, kind: &str, path: &Path, note: &str) -> Source {
    let meta = std::fs::metadata(path).ok().filter(|m| m.is_file());
    let bytes = meta.as_ref().map(|m| m.len());
    let lines = match bytes {
        Some(b) if b <= MAX_COUNT_BYTES => std::fs::read(path).ok().map(|data| {
            let n = data.iter().filter(|&&c| c == b'\n').count() as u64;
            if data.last().is_some_and(|&c| c != b'\n') { n + 1 } else { n }
        }),
        _ => None,
    };
    Source { label: label.into(), kind: kind.into(), path: path.display().to_string(), exists: meta.is_some(), bytes, lines, files: None, note: note.into() }
}

fn count_files(dir: &Path, keep: impl Fn(&str) -> bool) -> u32 {
    std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(Result::ok).filter(|e| e.file_type().is_ok_and(|t| t.is_file()) && keep(&e.file_name().to_string_lossy())).count() as u32)
        .unwrap_or(0)
}

/// `cwd`'s parents, nearest first, up to and including `stop` (or to `/` when `cwd` is not
/// under `stop`).
fn parents(cwd: &Path, stop: &Path) -> Vec<PathBuf> {
    if cwd == stop {
        return Vec::new();
    }
    let under = cwd.starts_with(stop) && cwd != stop;
    let mut out = Vec::new();
    let mut cur = cwd.parent();
    while let Some(p) = cur {
        out.push(p.to_path_buf());
        if under && p == stop {
            break;
        }
        cur = p.parent();
    }
    out
}

fn git_root(cwd: &Path) -> Option<PathBuf> {
    cwd.ancestors().find(|p| p.join(".git").exists()).map(Path::to_path_buf)
}

/// What the agent of `engine` loads when it starts in `cwd` (pure over the filesystem, so
/// it is unit-tested against a scratch folder).
pub fn discover(home: &Path, cwd: &Path, engine: &str) -> ContextReport {
    let fam = family(engine);
    let mut s: Vec<Source> = Vec::new();
    let mut slug = None;
    let handoff = || stat("HANDOFF", "handoff", &cwd.join(".cursor/HANDOFF.md"), "Agent Kit state the kit commands read first");
    match fam {
        "codex" => {
            s.push(stat("User AGENTS.md", "user", &home.join(".codex/AGENTS.md"), "~/.codex, every project"));
            let over = home.join(".codex/AGENTS.override.md");
            if over.is_file() {
                s.push(stat("User AGENTS.override.md", "user", &over, "replaces ~/.codex/AGENTS.md"));
            }
            s.push(stat("AGENTS.md", "agents", &cwd.join("AGENTS.md"), "this folder"));
            // Codex also reads AGENTS.md from the repository root down to the folder.
            if let Some(top) = git_root(cwd) {
                for p in parents(cwd, &top).into_iter().filter(|p| p.starts_with(&top)) {
                    let f = p.join("AGENTS.md");
                    if f.is_file() {
                        s.push(stat("Parent AGENTS.md", "parent", &f, "repository root down to the folder"));
                    }
                }
            }
            s.push(handoff());
            let mem = home.join(".codex/memories_1.sqlite");
            if mem.is_file() {
                s.push(stat("Codex memories", "memory", &mem, "global Codex memory store (all projects)"));
            }
        }
        "cursor" => {
            s.push(stat("AGENTS.md", "agents", &cwd.join("AGENTS.md"), "this folder"));
            s.push(stat("CLAUDE.md", "project", &cwd.join("CLAUDE.md"), "this folder"));
            let rules = cwd.join(".cursor/rules");
            let mut r = stat("Cursor rules", "rules", &rules, ".cursor/rules");
            r.exists = rules.is_dir();
            r.files = r.exists.then(|| count_files(&rules, |n| n.ends_with(".mdc") || n.ends_with(".md")));
            s.push(r);
            s.push(handoff());
        }
        _ => {
            s.push(stat("User CLAUDE.md", "user", &home.join(".claude/CLAUDE.md"), "~/.claude, every project"));
            s.push(stat("CLAUDE.md", "project", &cwd.join("CLAUDE.md"), "this folder"));
            for (name, note) in [(".claude/CLAUDE.md", "this folder"), ("CLAUDE.local.md", "this folder, personal")] {
                let f = cwd.join(name);
                if f.is_file() {
                    s.push(stat(name, "project", &f, note));
                }
            }
            for p in parents(cwd, home) {
                for name in ["CLAUDE.md", "CLAUDE.local.md"] {
                    let f = p.join(name);
                    if f.is_file() {
                        s.push(stat(&format!("Parent {name}"), "parent", &f, &format!("loaded from {}", p.display())));
                    }
                }
            }
            s.push(stat("AGENTS.md", "agents", &cwd.join("AGENTS.md"), "this folder (read when CLAUDE.md points to it)"));
            s.push(handoff());
            let sl = project_slug(&cwd.display().to_string());
            let dir = home.join(".claude/projects").join(&sl).join("memory");
            let mut m = stat("Project memory", "memory", &dir.join("MEMORY.md"), "Claude Code auto-memory, keyed by the start folder");
            m.files = dir.is_dir().then(|| count_files(&dir, |n| n.ends_with(".md") && n != "MEMORY.md"));
            s.push(m);
            slug = Some(sl);
        }
    }
    ContextReport { cwd: cwd.display().to_string(), engine: engine.into(), family: fam.into(), slug, sources: s }
}

fn allow_list() -> &'static Mutex<HashSet<PathBuf>> {
    static ALLOWED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    ALLOWED.get_or_init(Default::default)
}

/// True for a context file `context_sources` reported (canonical path).
pub fn allowed(resolved: &Path) -> bool {
    allow_list().lock().map(|s| s.contains(resolved)).unwrap_or(false)
}

/// The context sources of the agent `engine` (a driver backend or `claude` / `codex`) in
/// `cwd`. Paths, existence, sizes and line counts only.
#[tauri::command]
pub fn context_sources(cwd: String, engine: String) -> Result<ContextReport, String> {
    let dir = PathBuf::from(&cwd).canonicalize().map_err(|e| format!("{cwd}: {e}"))?;
    if !dir.is_dir() {
        return Err(format!("Not a folder: {cwd}"));
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("HOME is not set")?;
    let report = discover(&home, &dir, &engine);
    remember(&report);
    Ok(report)
}

/// Let the editor commands open the files of `report` (existing files only).
fn remember(report: &ContextReport) {
    if let Ok(mut set) = allow_list().lock() {
        for src in report.sources.iter().filter(|s| s.exists && s.kind != "rules") {
            if let Ok(p) = Path::new(&src.path).canonicalize() {
                set.insert(p);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_matches_claude_project_folders() {
        assert_eq!(project_slug("/home/severina/agent-kit-dev"), "-home-severina-agent-kit-dev");
        assert_eq!(project_slug("/home/severina/agent-kit-dev/.cursor/memory/decisions"), "-home-severina-agent-kit-dev--cursor-memory-decisions");
        assert_eq!(project_slug("/home/severina/.local/share/max-plan/sevelabs-idle"), "-home-severina--local-share-max-plan-sevelabs-idle");
        assert_eq!(project_slug("/tmp/claude-1000/-home-x/scratchpad"), "-tmp-claude-1000--home-x-scratchpad");
        assert_eq!(project_slug("/home/severina/Work"), "-home-severina-Work");
        assert_eq!(project_slug("/home/u/my_repo v2"), "-home-u-my-repo-v2");
        // One dash per UTF-16 code unit: an emoji is two.
        assert_eq!(project_slug("/home/u/proj \u{1F41D}"), "-home-u-proj---");
        assert_eq!(project_slug("/home/u/caf\u{e9}"), "-home-u-caf-");
        // Over 200 characters: cut at 200, then the path's hash (values from Claude Code).
        let at_cap = format!("/b/{}", "z".repeat(197));
        assert_eq!(project_slug(&at_cap), format!("-b-{}", "z".repeat(197)));
        let long = project_slug(&format!("/a/{}", "x".repeat(250)));
        assert_eq!(long, format!("-a-{}-oej0v1", "x".repeat(197)));
        let long = project_slug(&format!("/home/u/proj \u{1F41D}/{}", "y".repeat(200)));
        assert_eq!(long, format!("-home-u-proj----{}-um3jaf", "y".repeat(184)));
        assert_eq!(base36(i32::MIN.unsigned_abs()), "zik0zk");
    }

    #[test]
    fn families() {
        assert_eq!(family("claude"), "claude");
        assert_eq!(family("auto"), "claude");
        assert_eq!(family("codex"), "codex");
        assert_eq!(family("cursor-acp"), "cursor");
        assert_eq!(family("cursor-agent"), "cursor");
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("colony-ctx-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    fn write(p: &Path, body: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    fn find<'a>(r: &'a ContextReport, path: &Path) -> Option<&'a Source> {
        r.sources.iter().find(|s| s.path == path.display().to_string())
    }

    #[test]
    fn claude_sources_walk_up_to_home_and_find_the_project_memory() {
        let root = scratch("claude");
        let home = root.join("home");
        let cwd = home.join("code/repo");
        write(&root.join("CLAUDE.md"), "above home: never loaded\n");
        write(&home.join(".claude/CLAUDE.md"), "user\nrules\n");
        write(&home.join("CLAUDE.md"), "home level");
        write(&cwd.join("CLAUDE.md"), "project\n");
        write(&cwd.join("AGENTS.md"), "agents\n");
        let slug = project_slug(&cwd.display().to_string());
        let mem = home.join(".claude/projects").join(&slug).join("memory");
        write(&mem.join("MEMORY.md"), "- [a](a.md)\n- [b](b.md)\n- [c](c.md)\n");
        write(&mem.join("a.md"), "a");
        write(&mem.join("b.md"), "b");
        write(&mem.join("notes.txt"), "not a memory file");

        let r = discover(&home, &cwd, "claude");
        assert_eq!(r.family, "claude");
        assert_eq!(r.slug.as_deref(), Some(slug.as_str()));
        let user = find(&r, &home.join(".claude/CLAUDE.md")).unwrap();
        assert_eq!((user.exists, user.bytes, user.lines), (true, Some(11), Some(2)));
        let parent = find(&r, &home.join("CLAUDE.md")).expect("CLAUDE.md in $HOME is a parent source");
        assert_eq!((parent.kind.as_str(), parent.lines), ("parent", Some(1)));
        assert!(find(&r, &root.join("CLAUDE.md")).is_none(), "no CLAUDE.md above $HOME");
        assert!(find(&r, &home.join("code/CLAUDE.md")).is_none(), "missing parents are not listed");
        assert!(find(&r, &cwd.join("CLAUDE.md")).unwrap().exists);
        assert!(find(&r, &cwd.join("AGENTS.md")).unwrap().exists);
        let handoff = find(&r, &cwd.join(".cursor/HANDOFF.md")).unwrap();
        assert!(!handoff.exists && handoff.bytes.is_none());
        let m = find(&r, &mem.join("MEMORY.md")).unwrap();
        assert_eq!((m.exists, m.lines, m.files), (true, Some(3), Some(2)));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_memory_folder_reports_no_files() {
        let root = scratch("nomem");
        let home = root.join("home");
        let cwd = home.join("repo");
        std::fs::create_dir_all(&cwd).unwrap();
        let r = discover(&home, &cwd, "auto");
        let m = r.sources.iter().find(|s| s.kind == "memory").unwrap();
        assert_eq!((m.exists, m.files), (false, None));
        assert!(m.path.ends_with(&format!("{}/memory/MEMORY.md", project_slug(&cwd.display().to_string()))));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn codex_sources_use_agents_md_from_the_repo_root_down() {
        let root = scratch("codex");
        let home = root.join("home");
        let repo = home.join("repo");
        let cwd = repo.join("pkg");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        write(&home.join("AGENTS.md"), "above the repo: not read by codex");
        write(&repo.join("AGENTS.md"), "repo\n");
        write(&cwd.join("AGENTS.md"), "pkg\n");
        let r = discover(&home, &cwd, "codex");
        assert_eq!((r.family.as_str(), r.slug.as_deref()), ("codex", None));
        assert!(!find(&r, &home.join(".codex/AGENTS.md")).unwrap().exists);
        assert!(find(&r, &cwd.join("AGENTS.md")).unwrap().exists);
        assert_eq!(find(&r, &repo.join("AGENTS.md")).unwrap().kind, "parent");
        assert!(find(&r, &home.join("AGENTS.md")).is_none());
        assert!(r.sources.iter().all(|s| !s.path.contains("/.claude/")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cursor_sources_count_rules() {
        let root = scratch("cursor");
        let cwd = root.join("repo");
        write(&cwd.join(".cursor/rules/a.mdc"), "a");
        write(&cwd.join(".cursor/rules/b.md"), "b");
        write(&cwd.join(".cursor/rules/c.txt"), "c");
        let r = discover(&root, &cwd, "cursor-agent");
        let rules = r.sources.iter().find(|s| s.kind == "rules").unwrap();
        assert_eq!((rules.exists, rules.files), (true, Some(2)));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn jail_admits_only_reported_context_files() {
        let root = scratch("jail");
        let home = root.join("home");
        let ws = home.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let user = home.join(".claude/CLAUDE.md");
        write(&user, "user\n");
        write(&home.join(".claude/settings.json"), "{}");
        let state = crate::AppState::default();
        *state.workspace.lock().unwrap() = Some(ws.clone());
        let jail = |p: &Path| crate::workspace::jail(&state, &p.display().to_string());
        assert!(jail(&user).is_err(), "outside the folder until reported");
        remember(&discover(&home, &ws, "claude"));
        assert_eq!(jail(&user).unwrap(), user);
        assert!(jail(&home.join(".claude/settings.json")).is_err(), "only the reported files");
        assert!(jail(&home.join(".claude/projects/x/memory/MEMORY.md")).is_err(), "missing files are not admitted");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn parents_stop_at_home_or_root() {
        let p = parents(Path::new("/h/u/a/b"), Path::new("/h/u"));
        assert_eq!(p, vec![PathBuf::from("/h/u/a"), PathBuf::from("/h/u")]);
        let p = parents(Path::new("/srv/x"), Path::new("/h/u"));
        assert_eq!(p, vec![PathBuf::from("/srv"), PathBuf::from("/")]);
        assert!(parents(Path::new("/h/u"), Path::new("/h/u")).is_empty());
    }
}
