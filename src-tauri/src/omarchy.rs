//! Omarchy 4 theme and font, read live (kit ADR 2026-10-23 Omarchy reference platform, o1).
//!
//! Detection, not dependency: only where `/usr/share/omarchy/version` exists. Everything
//! here is read-only: `~/.local/state/omarchy/current/theme/colors.toml` (the canonical
//! palette that `omarchy-theme-set` writes), `~/.local/state/omarchy/current/theme.name`
//! and the monospace font fontconfig resolves (`omarchy-font-current` is
//! `fc-match monospace`; `omarchy-font-set` rewrites `~/.config/fontconfig/fonts.conf`).
//! Colony installs no themed template and no hook: `theme-set` replaces the whole theme
//! directory (rm + mv), so a std thread polls a cheap signature of those files instead of
//! holding a directory watch that would die with the old inode.
//!
//! The palette maps onto the 9 surface tokens of `src/tokens.css` plus the semantic
//! colours, with the same roles as Omarchy's own `t3code.json.tpl` (canvas and terminal on
//! `background`, side panels on `dark_background`, focus on `accent`); card and text steps
//! are mixed from background and foreground, so light themes keep their contrast.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::ipc::Channel;

const OMARCHY_ROOT: &str = "/usr/share/omarchy";
const POLL: Duration = Duration::from_millis(1500);

/// The current Omarchy look, as Colony applies it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    /// `theme.name` (e.g. `tokyo-night`), when present.
    pub name: Option<String>,
    /// `dark` or `light` (colors.toml `mode`, else from the background luminance).
    pub mode: String,
    /// CSS custom properties for the document root (`--bg-primary`, ..., `--mc-selection`).
    pub tokens: BTreeMap<String, String>,
    /// The monospace family fontconfig resolves, first name only.
    pub font: Option<String>,
}

/// Whether this is an Omarchy system.
pub fn detected_at(root: &Path) -> bool {
    root.join("version").is_file()
}

/// Whether this machine runs Omarchy.
pub fn detected() -> bool {
    detected_at(Path::new(OMARCHY_ROOT))
}

fn state_dir(home: &Path) -> PathBuf {
    home.join(".local/state/omarchy/current")
}

/// `key = "value"` lines of colors.toml (comments, tables and other values skipped).
pub fn parse_colors(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('[') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        let k = k.trim();
        let v = v.trim();
        let v = v.split_once(" #").map_or(v, |(a, _)| a).trim();
        let Some(v) = v.strip_prefix('"').and_then(|v| v.strip_suffix('"')) else { continue };
        if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            out.insert(k.to_string(), v.to_string());
        }
    }
    out
}

type Rgb = (f64, f64, f64);

fn hex(v: &str) -> Option<Rgb> {
    let h = v.strip_prefix('#')?;
    if h.len() != 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let p = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok().map(f64::from);
    Some((p(0)?, p(2)?, p(4)?))
}

fn to_hex((r, g, b): Rgb) -> String {
    let c = |x: f64| x.round().clamp(0.0, 255.0) as u8;
    format!("#{:02x}{:02x}{:02x}", c(r), c(g), c(b))
}

/// `a` moved `t` of the way to `b`.
fn mix(a: Rgb, b: Rgb, t: f64) -> Rgb {
    (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t, a.2 + (b.2 - a.2) * t)
}

fn luminance((r, g, b): Rgb) -> f64 {
    let ch = |x: f64| {
        let x = x / 255.0;
        if x <= 0.04045 {
            x / 12.92
        } else {
            ((x + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}

fn contrast(a: Rgb, b: Rgb) -> f64 {
    let (x, y) = (luminance(a), luminance(b));
    (x.max(y) + 0.05) / (x.min(y) + 0.05)
}

/// The foreground faded up to `max_t` towards the background, but never below `target`
/// contrast on it (WCAG AA for small text is 4.5), so muted text stays readable.
fn faded(fg: Rgb, bg: Rgb, max_t: f64, target: f64) -> Rgb {
    let mut t = max_t;
    while t > 0.0 && contrast(mix(fg, bg, t), bg) < target {
        t -= 0.02;
    }
    mix(fg, bg, t.max(0.0))
}

/// The token map for a colors.toml palette; `None` without a usable background and foreground.
pub fn theme_from(colors: &BTreeMap<String, String>, name: Option<String>) -> Option<Theme> {
    let get = |k: &str| colors.get(k).and_then(|v| hex(v));
    let bg = get("background")?;
    let fg = get("foreground")?;
    let mode = match colors.get("mode").map(String::as_str) {
        Some("light") => "light",
        Some("dark") => "dark",
        _ if luminance(bg) > 0.4 => "light",
        _ => "dark",
    };
    let muted = get("muted").unwrap_or_else(|| mix(bg, fg, 0.3));
    let mut t = BTreeMap::new();
    let mut set = |k: &str, v: Rgb| {
        t.insert(k.to_string(), to_hex(v));
    };
    set("--bg-primary", bg);
    set("--bg-secondary", get("dark_background").unwrap_or(bg));
    set("--bg-card", mix(bg, fg, 0.04));
    set("--bg-card-hover", mix(bg, fg, 0.08));
    set("--border", mix(bg, muted, 0.5));
    set("--border-active", muted);
    set("--text-primary", fg);
    set("--text-secondary", faded(fg, bg, 0.2, 6.0));
    set("--text-muted", faded(fg, bg, 0.4, 4.5));
    set("--mc-selection", get("selection").unwrap_or_else(|| mix(bg, fg, 0.2)));
    // Semantic colours; `--blue` is the focus / primary colour, Omarchy's accent.
    let semantic = [("--green", "green"), ("--yellow", "yellow"), ("--red", "red"), ("--blue", "accent"), ("--purple", "magenta"), ("--cyan", "cyan"), ("--orange", "orange")];
    let mut bgs = Vec::new();
    for (token, key) in semantic {
        let Some(c) = get(key).or_else(|| if key == "accent" { get("blue") } else { None }) else { continue };
        set(token, c);
        bgs.push((format!("{token}-bg"), format!("rgba({}, {}, {}, 0.12)", c.0 as u8, c.1 as u8, c.2 as u8)));
    }
    t.extend(bgs);
    Some(Theme { name, mode: mode.into(), tokens: t, font: None })
}

/// The theme under `home`, or `None` when colors.toml is missing or unusable.
pub fn read_at(home: &Path) -> Option<Theme> {
    let dir = state_dir(home);
    let text = std::fs::read_to_string(dir.join("theme/colors.toml")).ok()?;
    let name = std::fs::read_to_string(dir.join("theme.name")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    theme_from(&parse_colors(&text), name)
}

/// First family of `fc-match monospace` (what `omarchy-font-current` prints).
fn font() -> Option<String> {
    let out = std::process::Command::new("fc-match").args(["monospace", "-f", "%{family}\n"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let first = s.lines().next()?.split(',').next()?.trim();
    (!first.is_empty() && !first.contains(['"', ';', '{', '}'])).then(|| first.to_string())
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from)
}

/// The live theme and font, or `None` off Omarchy.
pub fn current() -> Option<Theme> {
    if !detected() {
        return None;
    }
    let mut t = read_at(&home()?)?;
    t.font = font();
    Some(t)
}

type Stamp = Option<(SystemTime, u64)>;

fn stamp(p: &Path) -> Stamp {
    std::fs::metadata(p).ok().map(|m| (m.modified().unwrap_or(SystemTime::UNIX_EPOCH), m.len()))
}

/// What a theme or font switch changes: colors.toml, theme.name, fonts.conf.
fn signature(home: &Path) -> (Stamp, Option<String>, Stamp) {
    let dir = state_dir(home);
    (stamp(&dir.join("theme/colors.toml")), std::fs::read_to_string(dir.join("theme.name")).ok(), stamp(&home.join(".config/fontconfig/fonts.conf")))
}

/// Subscribers to theme and font changes, and the one poll thread that feeds them.
#[derive(Default)]
pub struct Watch {
    subs: Mutex<Vec<Channel<Option<Theme>>>>,
    started: AtomicBool,
}

impl Watch {
    /// Send the current theme now (`None` off Omarchy), then every readable change.
    pub fn subscribe(&'static self, ch: Channel<Option<Theme>>) -> Result<(), String> {
        let now = current();
        ch.send(now.clone()).map_err(|e| e.to_string())?;
        let Some(home) = now.as_ref().and_then(|_| home()) else { return Ok(()) };
        self.subs.lock().map_err(|_| "omarchy lock poisoned")?.push(ch);
        if !self.started.swap(true, Ordering::SeqCst) {
            std::thread::spawn(move || {
                let mut last = signature(&home);
                loop {
                    std::thread::sleep(POLL);
                    let sig = signature(&home);
                    if sig == last {
                        continue;
                    }
                    last = sig;
                    // Between theme-set's rm and mv there is no colors.toml: skip, the
                    // move changes the signature again.
                    let Some(t) = current() else { continue };
                    if let Ok(mut subs) = self.subs.lock() {
                        subs.retain(|c| c.send(Some(t.clone())).is_ok());
                    }
                }
            });
        }
        Ok(())
    }
}

static WATCH: std::sync::LazyLock<Watch> = std::sync::LazyLock::new(Watch::default);

/// The Omarchy theme and font now and on every change; one `null` off Omarchy.
#[tauri::command]
pub fn omarchy_subscribe(on_event: Channel<Option<Theme>>) -> Result<(), String> {
    WATCH.subscribe(on_event)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKYO: &str = r##"mode = "dark"

accent = "#7aa2f7"
selection = "#292e42"
muted = "#414868"

background = "#1a1b26"
dark_background = "#13141c"
foreground = "#a9b1d6"
red = "#f7768e" # comment
green = "#9ece6a"
magenta = "#ad8ee6"
"##;

    const LATTE: &str = r##"accent = "#1e66f5"
background = "#eff1f5"
dark_background = "#e3e4e8"
foreground = "#4c4f69"
"##;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("colony-omarchy-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn parses_quoted_lines_only() {
        let c = parse_colors("# x\n[table]\nmode = \"dark\"\nred = \"#f7768e\" # c\nn = 3\nbad key = \"#000000\"\n");
        assert_eq!(c.get("mode").map(String::as_str), Some("dark"));
        assert_eq!(c.get("red").map(String::as_str), Some("#f7768e"));
        assert_eq!(c.len(), 2);
    }

    #[test]
    fn maps_a_dark_palette_onto_the_tokens() {
        let t = theme_from(&parse_colors(TOKYO), Some("tokyo-night".into())).unwrap();
        assert_eq!(t.mode, "dark");
        assert_eq!(t.tokens["--bg-primary"], "#1a1b26");
        assert_eq!(t.tokens["--bg-secondary"], "#13141c");
        assert_eq!(t.tokens["--text-primary"], "#a9b1d6");
        assert_eq!(t.tokens["--border-active"], "#414868");
        assert_eq!(t.tokens["--blue"], "#7aa2f7");
        assert_eq!(t.tokens["--blue-bg"], "rgba(122, 162, 247, 0.12)");
        assert_eq!(t.tokens["--purple"], "#ad8ee6");
        assert_eq!(t.tokens["--mc-selection"], "#292e42");
        // Not in the palette: the default skin's value stays (no token).
        assert!(!t.tokens.contains_key("--orange"));
        // Each of the 9 surface tokens is set.
        for k in ["--bg-primary", "--bg-secondary", "--bg-card", "--bg-card-hover", "--border", "--border-active", "--text-primary", "--text-secondary", "--text-muted"] {
            assert!(t.tokens.contains_key(k), "{k}");
        }
    }

    #[test]
    fn light_mode_from_the_background_when_unset() {
        let t = theme_from(&parse_colors(LATTE), None).unwrap();
        assert_eq!(t.mode, "light");
        // Cards step towards the foreground: darker than the canvas on a light theme.
        let card = hex(&t.tokens["--bg-card"]).unwrap();
        assert!(luminance(card) < luminance(hex("#eff1f5").unwrap()));
        assert_eq!(t.tokens["--blue"], "#1e66f5");
    }

    #[test]
    fn muted_text_keeps_aa_contrast_where_the_palette_allows() {
        for palette in [TOKYO, LATTE] {
            let t = theme_from(&parse_colors(palette), None).unwrap();
            let bg = hex(&t.tokens["--bg-primary"]).unwrap();
            for k in ["--text-secondary", "--text-muted"] {
                let c = contrast(hex(&t.tokens[k]).unwrap(), bg);
                assert!(c >= 4.5, "{k} {c}");
            }
            // Still a step below the primary text.
            assert_ne!(t.tokens["--text-muted"], t.tokens["--text-primary"]);
        }
    }

    #[test]
    fn unusable_palette_is_none() {
        assert!(theme_from(&parse_colors("background = \"#000000\""), None).is_none());
        assert!(theme_from(&parse_colors("background = \"black\"\nforeground = \"#ffffff\""), None).is_none());
    }

    #[test]
    fn reads_the_state_dir_and_notices_a_switch() {
        let home = tmp("state");
        assert!(read_at(&home).is_none());
        let dir = home.join(".local/state/omarchy/current");
        std::fs::create_dir_all(dir.join("theme")).unwrap();
        std::fs::write(dir.join("theme/colors.toml"), TOKYO).unwrap();
        std::fs::write(dir.join("theme.name"), "tokyo-night\n").unwrap();
        let t = read_at(&home).unwrap();
        assert_eq!(t.name.as_deref(), Some("tokyo-night"));
        let before = signature(&home);
        // theme-set replaces the directory and rewrites theme.name.
        std::fs::remove_dir_all(dir.join("theme")).unwrap();
        std::fs::create_dir_all(dir.join("theme")).unwrap();
        std::fs::write(dir.join("theme/colors.toml"), LATTE).unwrap();
        std::fs::write(dir.join("theme.name"), "catppuccin-latte\n").unwrap();
        assert_ne!(signature(&home), before);
        assert_eq!(read_at(&home).unwrap().mode, "light");
    }

    #[test]
    fn detection_needs_the_version_file() {
        let root = tmp("root");
        assert!(!detected_at(&root));
        std::fs::write(root.join("version"), "4.0.6\n").unwrap();
        assert!(detected_at(&root));
    }

    /// Read-only look at this machine's Omarchy theme: `cargo test omarchy -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn prints_the_live_theme() {
        println!("{:#?}", current());
        // Every theme Omarchy ships: mode and muted-text contrast.
        for e in std::fs::read_dir(Path::new(OMARCHY_ROOT).join("themes")).into_iter().flatten().flatten() {
            let Ok(text) = std::fs::read_to_string(e.path().join("colors.toml")) else { continue };
            let t = theme_from(&parse_colors(&text), None);
            let c = t.as_ref().map(|t| contrast(hex(&t.tokens["--text-muted"]).unwrap(), hex(&t.tokens["--bg-primary"]).unwrap()));
            println!("{:?} {:?} muted contrast {:?}", e.file_name(), t.map(|t| t.mode), c);
        }
    }
}
