//! Single instance (Linux, any Unix): a second `colony [folder]` asks the running
//! window over a Unix socket in `$XDG_RUNTIME_DIR` and exits when that window takes
//! the request, so the desktop entry, `omarchy-launch-or-focus` and a terminal
//! `colony` focus the window that is already open instead of stacking a new one.
//!
//! The running window takes every request with no folder or with an existing absolute
//! directory, and raises itself. A folder other than the open one is handed to the
//! window's frontend (`instance_subscribe`), which opens it the way `Open folder` does,
//! unsaved-file question included: when you cancel that question the window keeps its
//! folder, and the second process has already exited. A request that arrives before the
//! frontend subscribes waits in `Inbox` and is opened right after the startup folder.
//!
//! One socket per binary and `COLONY_ENGINE` (a dev build or another engine never
//! hands its folder to the wrong window). Skipped under `COLONY_SMOKE`, with
//! `--new-instance`, or without `$XDG_RUNTIME_DIR`. Any socket error starts a new
//! window: single instance fails open, never leaves the user with nothing.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const PROTOCOL: u32 = 1;
/// Longest request line read from the socket.
const MAX_LINE: u64 = 8192;
const TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Request {
    v: u32,
    folder: Option<String>,
    /// `inbox` or `open-folder` (`colony --inbox`, `colony --open-folder`); a window
    /// from before this field ignores it and still raises itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    view: Option<String>,
}

/// The views a launch may ask the running window to show.
pub const VIEWS: &[(&str, &str)] = &[("--inbox", "inbox"), ("--open-folder", "open-folder")];

/// The view the command line asks for (`--inbox` / `--open-folder`), if any.
pub fn view_arg<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    let args: Vec<String> = args.into_iter().collect();
    VIEWS.iter().find(|(flag, _)| args.iter().any(|a| a == flag)).map(|(_, v)| v.to_string())
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Reply {
    handled: bool,
}

pub enum Claim {
    /// No other window: this process owns the socket and serves it.
    Primary(UnixListener, PathBuf),
    /// The running window took the request: exit without opening a window.
    Forwarded,
    /// Start a window of our own (declined, skipped, or a socket error).
    Standalone,
}

/// The socket for this binary and engine, or `None` when single instance is off.
pub fn socket_path() -> Option<PathBuf> {
    if std::env::var_os("COLONY_SMOKE").is_some_and(|s| !s.is_empty()) {
        return None;
    }
    if std::env::args().skip(1).any(|a| a == "--new-instance") {
        return None;
    }
    let runtime = PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").filter(|s| !s.is_empty())?);
    if !runtime.is_absolute() || !runtime.is_dir() {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let engine = std::env::var("COLONY_ENGINE").unwrap_or_default();
    Some(runtime.join(format!("colony-{}.sock", instance_key(&exe, &engine))))
}

/// Stable short key for (binary, engine).
fn instance_key(exe: &Path, engine: &str) -> String {
    let mut h = Sha256::new();
    h.update(exe.as_os_str().as_encoded_bytes());
    h.update([0]);
    h.update(engine.as_bytes());
    h.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// What the running window does with a request.
#[derive(Debug, PartialEq)]
pub enum Route {
    /// No folder, or the folder already open: raise the window.
    Raise,
    /// Another folder: raise the window and open that folder there.
    Open(PathBuf),
}

/// Route a request: no folder or the open one raises, another folder opens there.
pub fn route(requested: Option<&Path>, open: Option<&Path>) -> Route {
    match requested {
        None => Route::Raise,
        Some(f) if open == Some(f) => Route::Raise,
        Some(f) => Route::Open(f.to_path_buf()),
    }
}

/// Folders forwarded by later launches, and the frontend channels that open them.
#[derive(Default)]
pub struct Inbox {
    inner: std::sync::Mutex<InboxInner>,
}

#[derive(Default)]
struct InboxInner {
    pending: Vec<InstanceEvent>,
    subs: Vec<tauri::ipc::Channel<InstanceEvent>>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InstanceEvent {
    /// `colony <folder>` from another process: open this folder in this window.
    Open { folder: String },
    /// `colony --inbox` / `colony --open-folder`: show that view.
    Show { view: String },
}

impl Inbox {
    /// Deliver to the live subscribers, or keep it until the frontend subscribes.
    pub fn push(&self, folder: PathBuf) {
        self.send(InstanceEvent::Open { folder: folder.display().to_string() });
    }

    /// Ask the frontend to show a view (only the names in `VIEWS`).
    pub fn show(&self, view: &str) {
        if VIEWS.iter().any(|(_, v)| *v == view) {
            self.send(InstanceEvent::Show { view: view.to_string() });
        }
    }

    fn send(&self, ev: InstanceEvent) {
        let Ok(mut i) = self.inner.lock() else { return };
        i.subs.retain(|c| c.send(ev.clone()).is_ok());
        if i.subs.is_empty() {
            i.pending.push(ev);
        }
    }

    /// Subscribe a frontend channel; it first gets every folder that waited.
    pub fn subscribe(&self, ch: tauri::ipc::Channel<InstanceEvent>) -> Result<(), String> {
        let mut i = self.inner.lock().map_err(|_| "instance lock poisoned")?;
        for ev in std::mem::take(&mut i.pending) {
            ch.send(ev).map_err(|e| e.to_string())?;
        }
        i.subs.push(ch);
        Ok(())
    }
}

/// Ask a running window at `path`, else become the primary there.
pub fn claim_at(path: &Path, folder: Option<&str>, view: Option<&str>) -> Claim {
    match UnixStream::connect(path) {
        Ok(stream) => match ask(stream, folder, view) {
            Ok(true) => Claim::Forwarded,
            Ok(false) => Claim::Standalone,
            Err(e) => {
                eprintln!("colony: running window did not answer ({e}); opening a new one");
                Claim::Standalone
            }
        },
        Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused) => {
            // Nobody listens: a stale socket from a crashed window, or none at all.
            if e.kind() == std::io::ErrorKind::ConnectionRefused {
                let _ = std::fs::remove_file(path);
            }
            match UnixListener::bind(path) {
                Ok(l) => Claim::Primary(l, path.to_path_buf()),
                // Lost a race with another starting window: run on our own.
                Err(_) => Claim::Standalone,
            }
        }
        Err(_) => Claim::Standalone,
    }
}

fn ask(mut stream: UnixStream, folder: Option<&str>, view: Option<&str>) -> std::io::Result<bool> {
    stream.set_read_timeout(Some(TIMEOUT))?;
    stream.set_write_timeout(Some(TIMEOUT))?;
    let req = Request { v: PROTOCOL, folder: folder.map(str::to_string), view: view.map(str::to_string) };
    let mut line = serde_json::to_string(&req).map_err(std::io::Error::other)?;
    line.push('\n');
    stream.write_all(line.as_bytes())?;
    let mut reply = String::new();
    BufReader::new(stream.take(MAX_LINE)).read_line(&mut reply)?;
    let reply: Reply = serde_json::from_str(reply.trim()).map_err(std::io::Error::other)?;
    Ok(reply.handled)
}

/// Serve requests on a background thread; `handle(folder, view)` routes, raises and answers.
pub fn serve<F>(listener: UnixListener, handle: F)
where
    F: Fn(Option<PathBuf>, Option<String>) -> bool + Send + 'static,
{
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = answer(stream, &handle);
        }
    });
}

fn answer<F: Fn(Option<PathBuf>, Option<String>) -> bool>(stream: UnixStream, handle: &F) -> std::io::Result<()> {
    stream.set_read_timeout(Some(TIMEOUT))?;
    stream.set_write_timeout(Some(TIMEOUT))?;
    let mut line = String::new();
    BufReader::new((&stream).take(MAX_LINE)).read_line(&mut line)?;
    let handled = match serde_json::from_str::<Request>(line.trim()) {
        Ok(req) if req.v == PROTOCOL => match req.folder.map(PathBuf::from) {
            // The client sends a canonical directory; anything else is declined, so the
            // client opens its own window and reports the bad folder there.
            Some(f) if !f.is_absolute() || !f.is_dir() => false,
            folder => handle(folder, req.view),
        },
        _ => false,
    };
    let mut out = serde_json::to_string(&Reply { handled }).map_err(std::io::Error::other)?;
    out.push('\n');
    (&stream).write_all(out.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn sock(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("colony-instance-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("i.sock")
    }

    #[test]
    fn routes_no_folder_or_the_open_one_to_raise_and_others_to_open() {
        let open = Path::new("/w/a");
        assert_eq!(route(None, Some(open)), Route::Raise);
        assert_eq!(route(None, None), Route::Raise);
        assert_eq!(route(Some(open), Some(open)), Route::Raise);
        assert_eq!(route(Some(Path::new("/w/b")), Some(open)), Route::Open(PathBuf::from("/w/b")));
        assert_eq!(route(Some(open), None), Route::Open(PathBuf::from("/w/a")));
    }

    #[test]
    fn key_depends_on_binary_and_engine() {
        let a = instance_key(Path::new("/opt/colony"), "");
        assert_eq!(a.len(), 16);
        assert_eq!(a, instance_key(Path::new("/opt/colony"), ""));
        assert_ne!(a, instance_key(Path::new("/opt/colony"), "/home/u/agent-kit-dev"));
        assert_ne!(a, instance_key(Path::new("/home/u/target/release/colony"), ""));
    }

    #[test]
    fn every_existing_folder_is_forwarded() {
        let path = sock("forward");
        let dir = path.parent().unwrap().to_path_buf();
        let (open, other) = (dir.join("open"), dir.join("other"));
        std::fs::create_dir_all(&open).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let Claim::Primary(listener, _) = claim_at(&path, None, None) else { panic!("first claim must be primary") };
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s = seen.clone();
        let o = open.clone();
        serve(listener, move |f, _view| {
            s.lock().unwrap().push(route(f.as_deref(), Some(&o)));
            true
        });
        assert!(matches!(claim_at(&path, None, None), Claim::Forwarded));
        assert!(matches!(claim_at(&path, Some(open.to_str().unwrap()), None), Claim::Forwarded));
        assert!(matches!(claim_at(&path, Some(other.to_str().unwrap()), None), Claim::Forwarded));
        // Not a directory (gone, or a file): declined before `handle`, the client opens its own window.
        assert!(matches!(claim_at(&path, Some(dir.join("missing").to_str().unwrap()), None), Claim::Standalone));
        assert!(matches!(claim_at(&path, Some(path.to_str().unwrap()), None), Claim::Standalone));
        let seen = std::mem::take(&mut *seen.lock().unwrap());
        assert_eq!(seen, vec![Route::Raise, Route::Raise, Route::Open(other)]);
    }

    #[test]
    fn a_view_rides_along_and_old_requests_still_parse() {
        assert_eq!(view_arg(["colony".to_string(), "--inbox".to_string()]), Some("inbox".into()));
        assert_eq!(view_arg(["--open-folder".to_string()]), Some("open-folder".into()));
        assert_eq!(view_arg(["--new-instance".to_string()]), None);
        let path = sock("view");
        let Claim::Primary(listener, _) = claim_at(&path, None, None) else { panic!("primary") };
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s = seen.clone();
        serve(listener, move |_, v| {
            s.lock().unwrap().push(v);
            true
        });
        assert!(matches!(claim_at(&path, None, Some("inbox")), Claim::Forwarded));
        // A launcher from before `view` existed sends no such field.
        let mut c = UnixStream::connect(&path).unwrap();
        c.write_all(b"{\"v\":1,\"folder\":null}\n").unwrap();
        let mut r = String::new();
        BufReader::new(c).read_line(&mut r).unwrap();
        assert_eq!(serde_json::from_str::<Reply>(r.trim()).unwrap(), Reply { handled: true });
        assert_eq!(*seen.lock().unwrap(), vec![Some("inbox".to_string()), None]);
    }

    #[test]
    fn relative_or_bad_requests_are_declined() {
        let path = sock("bad");
        let Claim::Primary(listener, _) = claim_at(&path, None, None) else { panic!("primary") };
        serve(listener, |_, _| true);
        assert!(matches!(claim_at(&path, Some("relative/dir"), None), Claim::Standalone));
        let mut s = UnixStream::connect(&path).unwrap();
        s.write_all(b"{\"v\":99,\"folder\":null}\n").unwrap();
        let mut r = String::new();
        BufReader::new(s).read_line(&mut r).unwrap();
        assert_eq!(serde_json::from_str::<Reply>(r.trim()).unwrap(), Reply { handled: false });
    }

    #[test]
    fn stale_socket_is_replaced() {
        let path = sock("stale");
        // A window that crashed leaves its socket file with nobody listening.
        drop(UnixListener::bind(&path).unwrap());
        assert!(path.exists());
        assert!(matches!(claim_at(&path, None, None), Claim::Primary(..)));
    }

    #[test]
    fn silent_primary_fails_open() {
        let path = sock("silent");
        // Bound but never accepting: the client times out and opens its own window.
        let _l = UnixListener::bind(&path).unwrap();
        let t = std::time::Instant::now();
        assert!(matches!(claim_at(&path, None, None), Claim::Standalone));
        assert!(t.elapsed() < Duration::from_secs(5));
    }
}
