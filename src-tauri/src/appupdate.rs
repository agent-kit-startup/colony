//! Colony app updates and the build-time distribution channel.
//!
//! `direct` (Cargo feature `channel-direct`, on by default): the official
//! `tauri-plugin-updater` is compiled in. It reads `latest.json` from the latest GitHub
//! Release (`plugins.updater.endpoints` in tauri.conf.json), checks the minisign signature
//! of the download with `plugins.updater.pubkey` (the release key 9A9BB4349C2248C6) and
//! installs it in place (`requireSignedVersion`: the signed trusted comment must name the
//! announced version, so a crafted latest.json cannot downgrade to an older signed file). On Linux the plugin installs an AppImage (rewrites the file in
//! place, per user) or a .deb/.rpm (as root through `pkexec dpkg -i` / `rpm -U`); it has no
//! installer for the per-user tarball of `packaging/install.sh` (an unmarked binary falls
//! through to the AppImage routine, which would overwrite it with AppImage bytes). So Colony
//! installs in place only when it runs from the AppImage; the .deb and the tarball are told
//! how to update themselves, and the check still says whether a newer release exists.
//!
//! `package` (`--no-default-features`): the updater crate is not compiled in at all. Distro
//! packages (AUR `colony-bin`, omarchy-pkgs) are updated by the package manager, and the
//! About panel says so.

use serde::Serialize;
use tauri::{AppHandle, Runtime};

/// The distribution channel this binary was built for.
pub const CHANNEL: &str = if cfg!(feature = "channel-direct") { "direct" } else { "package" };

/// Update target of the AppImage in `latest.json` (`{os}-{arch}-{bundle}`).
#[cfg(feature = "channel-direct")]
const APPIMAGE_TARGET: &str = "linux-x86_64-appimage";

/// How this build was installed, as far as the updater is concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Install {
    AppImage,
    Deb,
    Rpm,
    /// The per-user tarball of `packaging/install.sh`, a raw build, or anything else.
    Other,
}

impl Install {
    pub fn name(self) -> &'static str {
        match self {
            Install::AppImage => "AppImage",
            Install::Deb => "deb",
            Install::Rpm => "rpm",
            Install::Other => "tarball or local build",
        }
    }
}

/// Bundle marker written by the Tauri bundler, plus `APPIMAGE` (set by the AppImage
/// runtime) and the executable path: a marked binary copied out of its bundle (for example
/// into the install.sh tarball) is not that bundle.
pub fn detect_install(bundle: Option<tauri::utils::config::BundleType>, appimage_env: Option<String>, exe: Option<&std::path::Path>) -> Install {
    use tauri::utils::config::BundleType;
    let system = exe.is_some_and(|p| p.starts_with("/usr/"));
    match bundle {
        Some(BundleType::AppImage) if appimage_env.is_some_and(|p| !p.trim().is_empty()) => Install::AppImage,
        Some(BundleType::Deb) if system => Install::Deb,
        Some(BundleType::Rpm) if system => Install::Rpm,
        _ => Install::Other,
    }
}

fn current_install() -> Install {
    let exe = std::env::current_exe().ok();
    detect_install(tauri::utils::platform::bundle_type(), std::env::var("APPIMAGE").ok(), exe.as_deref())
}

/// What the About panel says about updates for a channel and install kind.
pub fn update_note(channel: &str, install: Install) -> String {
    if channel != "direct" {
        return "Package build: updates come from your package manager (pacman -Syu on Arch and Omarchy). Colony does not update itself.".into();
    }
    match install {
        Install::AppImage => "Signed updates from the latest GitHub Release (latest.json, key 9A9BB4349C2248C6), installed in place.".into(),
        Install::Deb => "Installed from the .deb: install the newer Colony_<version>_amd64.deb from the release (sudo apt install ./Colony_...deb).".into(),
        Install::Rpm => "No .rpm is published: update by installing a newer release.".into(),
        Install::Other => "Installed with install.sh (or a local build): run the install line again to update; it keeps the previous version.".into(),
    }
}

/// Only these installs are updated in place by the plugin.
pub fn can_install_in_place(channel: &str, install: Install) -> bool {
    channel == "direct" && install == Install::AppImage
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateStatus {
    pub version: String,
    pub channel: &'static str,
    pub install: &'static str,
    pub can_check: bool,
    pub can_install: bool,
    pub note: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub current: String,
    /// The newer version, or None when this build is up to date.
    pub available: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
}

pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    #[cfg(feature = "channel-direct")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
}

#[tauri::command]
pub fn app_update_status() -> AppUpdateStatus {
    let install = current_install();
    AppUpdateStatus {
        version: env!("CARGO_PKG_VERSION").into(),
        channel: CHANNEL,
        install: install.name(),
        can_check: CHANNEL == "direct",
        can_install: can_install_in_place(CHANNEL, install),
        note: update_note(CHANNEL, install),
    }
}

#[cfg(feature = "channel-direct")]
async fn check<R: Runtime>(app: &AppHandle<R>) -> Result<Option<tauri_plugin_updater::Update>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let mut b = app.updater_builder();
    // Only the AppImage has an entry in latest.json: other installs ask for it only to learn
    // whether a newer version exists (it is never installed over them).
    if current_install() != Install::AppImage {
        b = b.target(APPIMAGE_TARGET);
    }
    b.build().map_err(|e| e.to_string())?.check().await.map_err(|e| format!("update check failed: {e}"))
}

/// Ask the latest GitHub Release whether a newer Colony exists (user-started only).
#[tauri::command]
pub async fn app_update_check<R: Runtime>(app: AppHandle<R>) -> Result<AppUpdateInfo, String> {
    #[cfg(feature = "channel-direct")]
    {
        let u = check(&app).await?;
        Ok(AppUpdateInfo {
            current: env!("CARGO_PKG_VERSION").into(),
            available: u.as_ref().map(|u| u.version.clone()),
            notes: u.as_ref().and_then(|u| u.body.clone()),
            date: u.as_ref().and_then(|u| u.date.map(|d| d.to_string())),
        })
    }
    #[cfg(not(feature = "channel-direct"))]
    {
        let _ = app;
        Err(update_note(CHANNEL, current_install()))
    }
}

/// Download, verify (minisign, release key) and install the newer version, then restart.
#[tauri::command]
pub async fn app_update_install<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let install = current_install();
    if !can_install_in_place(CHANNEL, install) {
        return Err(update_note(CHANNEL, install));
    }
    #[cfg(feature = "channel-direct")]
    {
        let Some(u) = check(&app).await? else {
            return Ok(format!("Colony {} is up to date.", env!("CARGO_PKG_VERSION")));
        };
        u.download_and_install(|_, _| {}, || {}).await.map_err(|e| format!("update {} failed: {e}", u.version))?;
        app.restart();
    }
    #[cfg(not(feature = "channel-direct"))]
    {
        let _ = app;
        unreachable!("can_install_in_place is false for package builds")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::utils::config::BundleType;

    /// The updater config the plugin reads at startup: it must deserialize (a missing or
    /// malformed `pubkey` stops the app), point at the GitHub latest.json, and carry the
    /// release key that install.sh pins.
    #[cfg(feature = "channel-direct")]
    #[test]
    fn updater_config_is_the_release_key() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = conf["plugins"]["updater"].clone();
        let c: tauri_plugin_updater::Config = serde_json::from_value(updater).unwrap();
        assert_eq!(c.endpoints.len(), 1);
        // Every Colony release is signed by a Tauri CLI that records the version in the
        // trusted comment, so a crafted latest.json cannot pair a new version with an old file.
        assert!(c.require_signed_version);
        assert_eq!(c.endpoints[0].as_str(), "https://github.com/agent-kit-startup/colony/releases/latest/download/latest.json");
        let text = String::from_utf8(b64decode(&c.pubkey)).unwrap();
        let install_sh = include_str!("../../packaging/install.sh");
        let pinned = install_sh.lines().find_map(|l| l.strip_prefix("PUBKEY=\"")).unwrap().trim_end_matches('"');
        assert!(text.contains("9A9BB4349C2248C6"), "{text}");
        assert_eq!(text.lines().nth(1), Some(pinned));
    }

    #[cfg(feature = "channel-direct")]
    fn b64decode(s: &str) -> Vec<u8> {
        const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let (mut out, mut acc, mut bits) = (Vec::new(), 0u32, 0);
        for c in s.bytes().filter(|&c| c != b'=') {
            acc = (acc << 6) | A.iter().position(|&a| a == c).expect("base64") as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((acc >> bits) as u8);
            }
        }
        out
    }

    #[test]
    fn install_kind() {
        use std::path::Path;
        let usr = Some(Path::new("/usr/bin/colony"));
        let home = Some(Path::new("/home/u/.local/share/colony/app/0.1.0/colony"));
        assert_eq!(detect_install(Some(BundleType::AppImage), Some("/home/u/Colony.AppImage".into()), home), Install::AppImage);
        // The AppImage marker without the runtime's APPIMAGE (binary copied out): not in place.
        assert_eq!(detect_install(Some(BundleType::AppImage), None, home), Install::Other);
        assert_eq!(detect_install(Some(BundleType::Deb), None, usr), Install::Deb);
        // A deb-marked binary in the install.sh layout is the tarball, not the .deb.
        assert_eq!(detect_install(Some(BundleType::Deb), None, home), Install::Other);
        assert_eq!(detect_install(None, None, usr), Install::Other);
    }

    #[test]
    fn in_place_only_for_the_direct_appimage() {
        assert!(can_install_in_place("direct", Install::AppImage));
        assert!(!can_install_in_place("direct", Install::Deb));
        assert!(!can_install_in_place("direct", Install::Other));
        assert!(!can_install_in_place("direct", Install::Rpm));
        assert!(!can_install_in_place("package", Install::AppImage));
        assert!(update_note("package", Install::Other).contains("package manager"));
        assert!(update_note("direct", Install::Other).contains("install line"));
    }
}
