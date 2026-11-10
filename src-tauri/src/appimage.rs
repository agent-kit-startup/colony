//! Colony as an AppImage: the `colony://` link registration, and the environment host programs
//! get from it.
//!
//! The AppImage points the process at its bundled libraries and data. linuxdeploy's `AppRun`
//! sources the GTK hook (`GTK_*`, `GDK_PIXBUF_MODULE_FILE`, `GIO_MODULE_DIR`, `GI_TYPELIB_PATH`,
//! `GSETTINGS_SCHEMA_DIR`, `XDG_DATA_DIRS`), then AppImageKit's `AppRun.wrapped` prepends its
//! directories to `PATH`, `LD_LIBRARY_PATH`, `XDG_DATA_DIRS`, `GSETTINGS_SCHEMA_DIR`,
//! `PYTHONPATH`, `PERLLIB`, `QT_PLUGIN_PATH` and `GST_PLUGIN_SYSTEM_PATH*`, and sets
//! `PYTHONHOME`; the type 2 runtime sets `APPIMAGE`, `APPDIR`, `ARGV0` and `OWD`. Colony and
//! WebKitGTK's web and network processes need all of that, so the process keeps it. A host
//! program started with it loads the bundled glib (2.72) instead of its own: Arch's
//! `update-desktop-database` (glib 2.76 or later) then exits 127 with `undefined symbol:
//! g_string_free_and_steal`.
//!
//! Neither the runtime nor `AppRun` saves the original values, but `AppRun` only prepends, so
//! the original is what is left once the entries inside the AppImage are removed. Two values
//! cannot be told apart from a user's own and are left as they are: `GTK_THEME` (the hook's
//! `Adwaita:<variant>`) and `PYTHONDONTWRITEBYTECODE=1`; neither changes what a host program
//! loads.

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::process::Command;

/// The scheme in `tauri.conf.json` (`plugins.deep-link.desktop.schemes`).
pub const SCHEME: &str = "colony";

/// What the AppImage runtime sets about itself (AppImage/type2-runtime).
const RUNTIME_VARS: [&str; 4] = ["APPIMAGE", "APPDIR", "ARGV0", "OWD"];

/// One environment change for a child: `Some(value)` sets, `None` removes.
pub type EnvChange = (OsString, Option<OsString>);

/// The AppImage's mount directory as `APPDIR` names it and as resolved: `AppRun.wrapped` builds
/// its paths from `realpath(/proc/self/exe)`. No `APPDIR`: not an AppImage, no roots.
pub fn appdir_roots(appdir: Option<&OsStr>) -> Vec<PathBuf> {
    let Some(appdir) = appdir.filter(|a| !a.is_empty()) else { return Vec::new() };
    let mut roots = vec![PathBuf::from(appdir)];
    if let Ok(resolved) = std::fs::canonicalize(appdir) {
        if !roots.contains(&resolved) {
            roots.push(resolved);
        }
    }
    roots
}

/// The changes that give a host program the environment it would have outside the AppImage:
/// the runtime's own variables are removed, and every variable with an entry inside the
/// AppImage loses those entries (removed when nothing is left). Without roots nothing changes.
pub fn host_env_changes<I>(vars: I, roots: &[PathBuf]) -> Vec<EnvChange>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    let roots: Vec<&[u8]> = roots
        .iter()
        .map(|r| trim_slashes(r.as_os_str().as_bytes()))
        .filter(|r| !r.is_empty() && *r != b"/")
        .collect();
    if roots.is_empty() {
        return Vec::new();
    }
    let mut changes = Vec::new();
    for (name, value) in vars {
        if RUNTIME_VARS.iter().any(|v| name == *v) {
            changes.push((name, None));
            continue;
        }
        let entries: Vec<&[u8]> = value.as_bytes().split(|b| *b == b':').collect();
        if !entries.iter().any(|e| inside(e, &roots)) {
            continue;
        }
        // An empty entry is the current directory to the loader and to PATH lookup: drop it too.
        let kept: Vec<&[u8]> = entries.into_iter().filter(|e| !e.is_empty() && !inside(e, &roots)).collect();
        let value = (!kept.is_empty()).then(|| OsString::from_vec(kept.join(&b':')));
        changes.push((name, value));
    }
    changes.sort();
    changes
}

fn trim_slashes(path: &[u8]) -> &[u8] {
    let mut path = path;
    while path.len() > 1 && path.ends_with(b"/") {
        path = &path[..path.len() - 1];
    }
    path
}

fn inside(entry: &[u8], roots: &[&[u8]]) -> bool {
    roots
        .iter()
        .any(|root| entry.starts_with(root) && (entry.len() == root.len() || entry[root.len()] == b'/'))
}

/// A command for a host program, with `changes` applied over the inherited environment. The
/// program is looked up in the changed `PATH`.
pub fn host_command(program: impl AsRef<OsStr>, changes: &[EnvChange]) -> Command {
    let mut cmd = Command::new(program);
    for (name, value) in changes {
        match value {
            Some(value) => cmd.env(name, value),
            None => cmd.env_remove(name),
        };
    }
    cmd
}

/// The `colony://` handler entry this AppImage writes.
pub struct Handler {
    /// `<data dir>/applications`.
    pub dir: PathBuf,
    /// `<binary name>-handler.desktop` (`colony-handler.desktop`), the plugin's name for it.
    pub file_name: String,
    /// The `Name` of a new entry (the product name).
    pub name: String,
    /// The AppImage file (`APPIMAGE`): the entry runs it, not the binary inside the mount.
    pub appimage: OsString,
}

/// Register this AppImage for `colony://` the way tauri-plugin-deep-link 2.6.3 `register()` does
/// on Linux: write the handler entry, refresh the MIME cache (`update-desktop-database`), make
/// the entry the default (`xdg-mime default`). Three differences: both programs run with
/// [`host_env_changes`] applied; a failed cache refresh is reported and does not stop the
/// default, because the cache is an optimisation and `xdg-mime default` is the registration;
/// and `Exec` quotes the path only when it has to ([`exec_value`]).
pub fn register(handler: &Handler, config_dir: &Path, changes: &[EnvChange]) -> Result<(), String> {
    let mime = format!("x-scheme-handler/{SCHEME}");
    let exec = exec_value(&handler.appimage)?;
    std::fs::create_dir_all(&handler.dir).map_err(|e| format!("{}: {e}", handler.dir.display()))?;
    let path = handler.dir.join(&handler.file_name);
    let current = std::fs::read_to_string(&path).ok();
    if let Some(text) = merged_entry(current.as_deref(), &handler.name, &exec, &mime) {
        std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))?;
    }

    match host_command("update-desktop-database", changes).arg(&handler.dir).status() {
        Ok(status) if status.success() => {}
        // Not every distro has it; the plugin skips it too.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Ok(status) => eprintln!("colony: update-desktop-database failed ({status}); setting the colony:// default anyway"),
        Err(e) => eprintln!("colony: update-desktop-database did not start ({e}); setting the colony:// default anyway"),
    }

    // xdg-mime's generic mode writes `<config dir>/mimeapps.list` and fails without the folder.
    let _ = std::fs::create_dir_all(config_dir);
    let status = host_command("xdg-mime", changes)
        .args(["default", handler.file_name.as_str(), mime.as_str()])
        .status()
        .map_err(|e| format!("xdg-mime did not start: {e}"))?;
    if !status.success() {
        return Err(format!("`xdg-mime default {} {mime}` failed: {status}", handler.file_name));
    }
    Ok(())
}

/// The `Exec` value that hands `path` the URL. The plugin always writes `"<path>" %u`, and
/// xdg-utils' generic `xdg-open` (no GNOME or KDE: Hyprland, Sway, a bare X session) takes the
/// first word with its quotes as the command, finds no such file and falls through to the
/// browsers (exit 3). So the path is quoted only when the Desktop Entry spec requires it (a
/// reserved character), with the spec's escapes: `"`, `` ` ``, `$` and `\` inside the quotes,
/// then `\` again for the string, and `%` doubled. A path a desktop entry cannot hold (not
/// UTF-8, a control character) is refused.
fn exec_value(path: &OsStr) -> Result<String, String> {
    const RESERVED: &[char] = &[' ', '"', '\'', '\\', '>', '<', '~', '|', '&', ';', '$', '*', '?', '#', '(', ')', '`'];
    let path = path.to_str().ok_or_else(|| format!("{} is not UTF-8", path.to_string_lossy()))?;
    if path.chars().any(char::is_control) {
        return Err(format!("{path:?} has a control character"));
    }
    let path = path.replace('%', "%%");
    if !path.contains(RESERVED) {
        return Ok(format!("{path} %u"));
    }
    let mut quoted = String::from("\"");
    for c in path.chars() {
        if matches!(c, '"' | '`' | '$' | '\\') {
            quoted.push('\\');
        }
        quoted.push(c);
    }
    quoted.push('"');
    Ok(format!("{} %u", quoted.replace('\\', "\\\\")))
}

/// The plugin's new entry (its `template.desktop`).
fn new_entry(name: &str, exec: &str, mime: &str) -> String {
    format!("[Desktop Entry]\nType=Application\nName={name}\nExec={exec}\nTerminal=false\nMimeType={mime}\nNoDisplay=true\n")
}

/// The entry to write, or `None` when `current` already has it. Like the plugin, an existing
/// entry keeps its other keys (an `install.sh` entry keeps its icon and marker), gets `mime`
/// added to `MimeType` and `Exec` pointed at this AppImage. A missing file or one without a
/// `[Desktop Entry]` section gets a new entry (the plugin left the latter as it was).
fn merged_entry(current: Option<&str>, name: &str, exec: &str, mime: &str) -> Option<String> {
    let Some(current) = current else { return Some(new_entry(name, exec, mime)) };
    let lines: Vec<&str> = current.lines().collect();
    let Some(start) = lines.iter().position(|l| l.trim() == "[Desktop Entry]") else {
        return Some(new_entry(name, exec, mime));
    };
    let end = lines[start + 1..]
        .iter()
        .position(|l| l.trim_start().starts_with('['))
        .map_or(lines.len(), |i| start + 1 + i);
    let (mut has_exec, mut has_mime, mut changed) = (false, false, false);
    let mut section = Vec::new();
    for line in &lines[start + 1..end] {
        match line.split_once('=').map(|(k, v)| (k.trim(), v.trim())) {
            Some(("Exec", value)) => {
                has_exec = true;
                if value != exec {
                    section.push(format!("Exec={exec}"));
                    changed = true;
                    continue;
                }
            }
            Some(("MimeType", value)) => {
                has_mime = true;
                if !value.split(';').any(|e| e == mime) {
                    let rest = value.split(';').filter(|e| !e.is_empty());
                    section.push(format!("MimeType={};", std::iter::once(mime).chain(rest).collect::<Vec<_>>().join(";")));
                    changed = true;
                    continue;
                }
            }
            _ => {}
        }
        section.push(line.to_string());
    }
    if !has_exec {
        section.push(format!("Exec={exec}"));
        changed = true;
    }
    if !has_mime {
        section.push(format!("MimeType={mime};"));
        changed = true;
    }
    if !changed {
        return None;
    }
    let mut out: Vec<String> = lines[..=start].iter().map(|l| l.to_string()).collect();
    out.extend(section);
    out.extend(lines[end..].iter().map(|l| l.to_string()));
    Some(out.join("\n") + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    const MOUNT: &str = "/tmp/.mount_ColonyAbC123";

    fn os(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()
    }

    /// The environment as the 0.5.0 AppImage's `AppRun` leaves it (values from its hook and
    /// `AppRun.wrapped`), over a host session that had `PATH` and `LD_LIBRARY_PATH` set.
    fn appimage_env(m: &str) -> Vec<(OsString, OsString)> {
        os(&[
            ("APPIMAGE", "/home/me/Apps/Colony_0.5.0_amd64.AppImage"),
            ("APPDIR", m),
            ("ARGV0", "./Colony_0.5.0_amd64.AppImage"),
            ("OWD", "/home/me"),
            ("PATH", &format!("{m}/usr/bin/:{m}/usr/sbin/:{m}/usr/games/:{m}/bin/:{m}/sbin/:/usr/local/bin:/usr/bin")),
            ("LD_LIBRARY_PATH", &format!("{m}/usr/lib/:{m}/usr/lib/i386-linux-gnu/:{m}/usr/lib/x86_64-linux-gnu/:{m}/usr/lib32/:{m}/usr/lib64/:{m}/lib/:{m}/lib/i386-linux-gnu/:{m}/lib/x86_64-linux-gnu/:{m}/lib32/:{m}/lib64/:/opt/host/lib")),
            ("XDG_DATA_DIRS", &format!("{m}/usr/share/:{m}/usr/share:/usr/share:/usr/local/share:/usr/share")),
            ("GSETTINGS_SCHEMA_DIR", &format!("{m}/usr/share/glib-2.0/schemas/:{m}//usr/share/glib-2.0/schemas")),
            ("PYTHONHOME", &format!("{m}/usr/")),
            ("PYTHONPATH", &format!("{m}/usr/share/pyshared/:")),
            ("PERLLIB", &format!("{m}/usr/share/perl5/:{m}/usr/lib/perl5/:")),
            ("QT_PLUGIN_PATH", &format!("{m}/usr/lib/qt4/plugins/:{m}/usr/lib/qt5/plugins/:")),
            ("GST_PLUGIN_SYSTEM_PATH", &format!("{m}/usr/lib/gstreamer:")),
            ("GST_PLUGIN_SYSTEM_PATH_1_0", &format!("{m}/usr/lib/gstreamer-1.0:")),
            ("GTK_DATA_PREFIX", m),
            ("GTK_EXE_PREFIX", &format!("{m}//usr")),
            ("GTK_PATH", &format!("{m}//usr/lib/gtk-3.0")),
            ("GTK_IM_MODULE_FILE", &format!("{m}//usr/lib/gtk-3.0/3.0.0/immodules.cache")),
            ("GDK_PIXBUF_MODULE_FILE", &format!("{m}//usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache")),
            ("GIO_MODULE_DIR", &format!("{m}//usr/lib/gio/modules")),
            ("GI_TYPELIB_PATH", &format!("{m}//usr/lib/girepository-1.0")),
            ("GTK_THEME", "Adwaita:dark"),
            ("PYTHONDONTWRITEBYTECODE", "1"),
            ("HOME", "/home/me"),
            ("DISPLAY", ":0"),
            ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
            ("XDG_DATA_HOME", "/home/me/.local/share"),
        ])
    }

    /// The child's environment: the parent's with `changes` applied.
    fn child_env(parent: &[(OsString, OsString)], changes: &[EnvChange]) -> BTreeMap<String, String> {
        let mut env: BTreeMap<String, String> =
            parent.iter().map(|(k, v)| (k.to_string_lossy().into(), v.to_string_lossy().into())).collect();
        for (k, v) in changes {
            match v {
                Some(v) => env.insert(k.to_string_lossy().into(), v.to_string_lossy().into()),
                None => env.remove(&*k.to_string_lossy()),
            };
        }
        env
    }

    #[test]
    fn no_appimage_variable_reaches_a_host_program() {
        let parent = appimage_env(MOUNT);
        let changes = host_env_changes(parent.clone(), &[PathBuf::from(MOUNT)]);
        let child = child_env(&parent, &changes);
        for (k, v) in &child {
            assert!(!v.contains(MOUNT), "{k}={v} still points into the AppImage");
        }
        for name in RUNTIME_VARS {
            assert!(!child.contains_key(name), "{name} reached the child");
        }
        for name in [
            "PYTHONHOME", "PYTHONPATH", "PERLLIB", "QT_PLUGIN_PATH", "GST_PLUGIN_SYSTEM_PATH",
            "GST_PLUGIN_SYSTEM_PATH_1_0", "GTK_DATA_PREFIX", "GTK_EXE_PREFIX", "GTK_PATH",
            "GTK_IM_MODULE_FILE", "GDK_PIXBUF_MODULE_FILE", "GIO_MODULE_DIR", "GI_TYPELIB_PATH",
            "GSETTINGS_SCHEMA_DIR",
        ] {
            assert!(!child.contains_key(name), "{name} reached the child");
        }
    }

    #[test]
    fn the_host_values_are_what_appimage_prepended_to() {
        let parent = appimage_env(MOUNT);
        let child = child_env(&parent, &host_env_changes(parent.clone(), &[PathBuf::from(MOUNT)]));
        assert_eq!(child["PATH"], "/usr/local/bin:/usr/bin");
        assert_eq!(child["LD_LIBRARY_PATH"], "/opt/host/lib");
        assert_eq!(child["XDG_DATA_DIRS"], "/usr/share:/usr/local/share:/usr/share");
        // Untouched: no entry inside the AppImage, or not a path.
        for (k, v) in [
            ("HOME", "/home/me"),
            ("DISPLAY", ":0"),
            ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
            ("XDG_DATA_HOME", "/home/me/.local/share"),
            ("GTK_THEME", "Adwaita:dark"),
            ("PYTHONDONTWRITEBYTECODE", "1"),
        ] {
            assert_eq!(child[k], v, "{k}");
        }
    }

    /// Without a host value `AppRun` leaves a trailing `:`, an empty entry the loader reads as
    /// the current directory: the variable goes, it does not become empty.
    #[test]
    fn a_variable_appimage_created_is_removed() {
        let parent = os(&[("APPDIR", MOUNT), ("LD_LIBRARY_PATH", &format!("{MOUNT}/usr/lib/:{MOUNT}/lib64/:"))]);
        let changes = host_env_changes(parent, &[PathBuf::from(MOUNT)]);
        assert_eq!(changes, vec![("APPDIR".into(), None), ("LD_LIBRARY_PATH".into(), None)]);
    }

    #[test]
    fn outside_an_appimage_nothing_changes() {
        assert!(appdir_roots(None).is_empty());
        assert!(appdir_roots(Some(OsStr::new(""))).is_empty());
        let parent = os(&[("PATH", "/usr/bin"), ("LD_LIBRARY_PATH", "/opt/lib"), ("APPIMAGE", "/x")]);
        assert!(host_env_changes(parent, &[]).is_empty());
        assert_eq!(host_command("xdg-mime", &[]).get_envs().count(), 0);
    }

    /// Only whole path components count, and a root of `/` would match everything.
    #[test]
    fn only_entries_inside_the_mount_go() {
        let parent = os(&[("PATH", &format!("{MOUNT}x/bin:{MOUNT}/usr/bin:/usr/bin"))]);
        let child = child_env(&parent, &host_env_changes(parent.clone(), &[PathBuf::from(format!("{MOUNT}/"))]));
        assert_eq!(child["PATH"], format!("{MOUNT}x/bin:/usr/bin"));
        assert!(host_env_changes(parent, &[PathBuf::from("/")]).is_empty());
    }

    #[test]
    fn the_resolved_mount_counts_too() {
        let d = std::env::temp_dir().join(format!("colony-appimage-roots-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("real")).unwrap();
        std::os::unix::fs::symlink(d.join("real"), d.join("link")).unwrap();
        let roots = appdir_roots(Some(d.join("link").as_os_str()));
        let resolved = std::fs::canonicalize(d.join("real")).unwrap();
        assert_eq!(roots, vec![d.join("link"), resolved.clone()]);
        let parent = os(&[("LD_LIBRARY_PATH", &format!("{}/usr/lib:/opt/lib", resolved.display()))]);
        let child = child_env(&parent, &host_env_changes(parent.clone(), &roots));
        assert_eq!(child["LD_LIBRARY_PATH"], "/opt/lib");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn host_command_applies_the_changes() {
        let parent = appimage_env(MOUNT);
        let changes = host_env_changes(parent, &[PathBuf::from(MOUNT)]);
        let cmd = host_command("update-desktop-database", &changes);
        let envs: BTreeMap<&OsStr, Option<&OsStr>> = cmd.get_envs().collect();
        assert_eq!(envs[OsStr::new("LD_LIBRARY_PATH")], Some(OsStr::new("/opt/host/lib")));
        assert_eq!(envs[OsStr::new("PATH")], Some(OsStr::new("/usr/local/bin:/usr/bin")));
        assert_eq!(envs[OsStr::new("GIO_MODULE_DIR")], None);
        assert_eq!(envs[OsStr::new("APPDIR")], None);
        assert!(!envs.contains_key(OsStr::new("HOME")), "an untouched variable is inherited, not set");
    }

    fn script(path: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// The 0.5.0 failure: the cache refresh exits 127 under the AppImage's glib. The default is
    /// still set, by the host's `xdg-mime` (not one inside the mount), without the AppImage's
    /// variables.
    #[test]
    fn a_failed_cache_refresh_still_sets_the_default() {
        let d = std::env::temp_dir().join(format!("colony-appimage-register-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let mount = d.join("mount");
        let host = d.join("host");
        let ran = |name: &str| d.join(format!("{name}.ran"));
        script(&host.join("update-desktop-database"), &format!("echo \"$1\" > '{}'\nexit 127", ran("udd").display()));
        script(
            &host.join("xdg-mime"),
            &format!(
                "printf '%s\\n' \"$*\" \"LD=${{LD_LIBRARY_PATH-unset}}\" \"APPDIR=${{APPDIR-unset}}\" \"GIO=${{GIO_MODULE_DIR-unset}}\" > '{}'",
                ran("xdg-mime").display()
            ),
        );
        script(&mount.join("usr/bin/xdg-mime"), &format!("echo decoy > '{}'", ran("decoy").display()));
        let m = mount.display().to_string();
        let parent = os(&[
            ("APPDIR", &m),
            ("APPIMAGE", &d.join("Colony.AppImage").display().to_string()),
            ("PATH", &format!("{m}/usr/bin/:{}:/usr/bin:/bin", host.display())),
            ("LD_LIBRARY_PATH", &format!("{m}/usr/lib/:")),
            ("GIO_MODULE_DIR", &format!("{m}//usr/lib/gio/modules")),
        ]);
        let changes = host_env_changes(parent, &appdir_roots(Some(mount.as_os_str())));
        let handler = Handler {
            dir: d.join("data/applications"),
            file_name: "colony-handler.desktop".into(),
            name: "Colony".into(),
            appimage: d.join("Colony.AppImage").into_os_string(),
        };
        let config = d.join("config");

        register(&handler, &config, &changes).expect("registered");

        assert_eq!(std::fs::read_to_string(ran("udd")).unwrap().trim(), handler.dir.display().to_string());
        assert_eq!(
            std::fs::read_to_string(ran("xdg-mime")).unwrap(),
            "default colony-handler.desktop x-scheme-handler/colony\nLD=unset\nAPPDIR=unset\nGIO=unset\n"
        );
        assert!(!ran("decoy").exists(), "the xdg-mime inside the mount ran");
        assert!(config.is_dir());
        let entry = std::fs::read_to_string(handler.dir.join("colony-handler.desktop")).unwrap();
        assert!(entry.lines().any(|l| l == format!("Exec={} %u", d.join("Colony.AppImage").display())));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_failed_default_is_an_error() {
        let d = std::env::temp_dir().join(format!("colony-appimage-default-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        script(&d.join("host/update-desktop-database"), "exit 0");
        script(&d.join("host/xdg-mime"), "exit 4");
        let changes = vec![(OsString::from("PATH"), Some(d.join("host").into_os_string()))];
        let handler = Handler {
            dir: d.join("applications"),
            file_name: "colony-handler.desktop".into(),
            name: "Colony".into(),
            appimage: "/a/Colony.AppImage".into(),
        };
        let err = register(&handler, &d.join("config"), &changes).unwrap_err();
        assert!(err.contains("xdg-mime default colony-handler.desktop x-scheme-handler/colony"), "{err}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The plugin's layout; a later start finds nothing to change.
    #[test]
    fn a_new_entry_is_the_plugins() {
        let exec = exec_value(OsStr::new("/out/Colony.AppImage")).unwrap();
        let entry = merged_entry(None, "Colony", &exec, "x-scheme-handler/colony").unwrap();
        assert_eq!(
            entry,
            "[Desktop Entry]\nType=Application\nName=Colony\nExec=/out/Colony.AppImage %u\nTerminal=false\nMimeType=x-scheme-handler/colony\nNoDisplay=true\n"
        );
        assert_eq!(merged_entry(Some(&entry), "Colony", &exec, "x-scheme-handler/colony"), None);
        assert_eq!(merged_entry(Some("garbage\n"), "Colony", &exec, "x-scheme-handler/colony"), Some(entry));
    }

    /// What 0.4.2 and 0.5.0 wrote (the plugin's quoted `Exec`, which the generic `xdg-open`
    /// cannot run) is rewritten at the next start.
    #[test]
    fn the_quoted_entry_from_0_5_0_is_rewritten() {
        let old = "[Desktop Entry]\nType=Application\nName=Colony\nExec=\"/out/Colony.AppImage\" %u\nTerminal=false\nMimeType=x-scheme-handler/colony\nNoDisplay=true\n";
        let exec = exec_value(OsStr::new("/out/Colony.AppImage")).unwrap();
        assert_eq!(
            merged_entry(Some(old), "Colony", &exec, "x-scheme-handler/colony").unwrap(),
            old.replace("Exec=\"/out/Colony.AppImage\" %u", "Exec=/out/Colony.AppImage %u")
        );
    }

    #[test]
    fn exec_quotes_the_path_only_when_it_has_to() {
        let exec = |p: &str| exec_value(OsStr::new(p));
        assert_eq!(exec("/home/me/Apps/Colony_0.5.1_amd64.AppImage").unwrap(), "/home/me/Apps/Colony_0.5.1_amd64.AppImage %u");
        assert_eq!(exec("/home/me/100%/Colony.AppImage").unwrap(), "/home/me/100%%/Colony.AppImage %u");
        assert_eq!(exec("/home/me/My Apps/Colony.AppImage").unwrap(), "\"/home/me/My Apps/Colony.AppImage\" %u");
        // `$` and `\` are escaped for the Exec quoting, then `\` again for the string value.
        assert_eq!(exec("/a/$x/b\\c").unwrap(), "\"/a/\\\\$x/b\\\\\\\\c\" %u");
        assert_eq!(exec("/a/\"q\"`b`").unwrap(), "\"/a/\\\\\"q\\\\\"\\\\`b\\\\`\" %u");
        assert!(exec("/a/b\nExec=/bin/sh").is_err());
        assert!(exec("/a/b\tc").is_err());
        use std::os::unix::ffi::OsStrExt;
        assert!(exec_value(OsStr::from_bytes(b"/a/\xff")).is_err());
    }

    #[test]
    fn an_existing_entry_keeps_its_keys() {
        let installed = "[Desktop Entry]\nType=Application\nName=Colony\nComment=Opens the game\nExec=/home/me/.local/share/colony/current/colony %u\nIcon=/home/me/.local/share/colony/current/colony.png\nTerminal=false\nNoDisplay=true\nMimeType=x-scheme-handler/colony;\nX-Colony-Install=1\n";
        let exec = "\"/a/Colony.AppImage\" %u";
        let merged = merged_entry(Some(installed), "Colony", exec, "x-scheme-handler/colony").unwrap();
        assert_eq!(merged, installed.replace("Exec=/home/me/.local/share/colony/current/colony %u", "Exec=\"/a/Colony.AppImage\" %u"));
        assert_eq!(merged_entry(Some(&merged), "Colony", exec, "x-scheme-handler/colony"), None);

        let other = "[Desktop Entry]\nName=X\nExec=\"/a/Colony.AppImage\" %u\nMimeType=text/plain;\n[Desktop Action new]\nExec=other\n";
        assert_eq!(
            merged_entry(Some(other), "Colony", exec, "x-scheme-handler/colony").unwrap(),
            "[Desktop Entry]\nName=X\nExec=\"/a/Colony.AppImage\" %u\nMimeType=x-scheme-handler/colony;text/plain;\n[Desktop Action new]\nExec=other\n"
        );
    }

    /// The app registers through this module, never through the plugin's `register_all()`,
    /// whose children inherit the AppImage's environment.
    #[test]
    fn the_app_registers_here() {
        let lib = include_str!("lib.rs");
        assert!(!lib.contains("register_all"));
        assert!(lib.contains("appimage::register("));
        assert!(include_str!("../tauri.conf.json").contains(&format!("\"schemes\": [\"{SCHEME}\"]")));
    }
}
