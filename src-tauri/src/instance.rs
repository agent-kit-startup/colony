//! Single instance (Linux, any Unix): a second `colony [folder]` asks the running
//! window over a Unix socket in `$XDG_RUNTIME_DIR` and exits when that window takes
//! the request, so the desktop entry, `omarchy-launch-or-focus` and a terminal
//! `colony` focus the window that is already open instead of stacking a new one.
//!
//! The running window takes a request with no folder, or with the folder it already
//! has open, and raises itself. A different folder is declined for now (the window
//! cannot switch folders from here yet), and the new process starts its own window,
//! exactly as before this module existed.
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

/// Whether the running window takes a request: no folder, or the one it has open.
pub fn takes(requested: Option<&Path>, open: Option<&Path>) -> bool {
    match requested {
        None => true,
        Some(f) => open == Some(f),
    }
}

/// Ask a running window at `path`, else become the primary there.
pub fn claim_at(path: &Path, folder: Option<&str>) -> Claim {
    match UnixStream::connect(path) {
        Ok(stream) => match ask(stream, folder) {
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

fn ask(mut stream: UnixStream, folder: Option<&str>) -> std::io::Result<bool> {
    stream.set_read_timeout(Some(TIMEOUT))?;
    stream.set_write_timeout(Some(TIMEOUT))?;
    let req = Request { v: PROTOCOL, folder: folder.map(str::to_string) };
    let mut line = serde_json::to_string(&req).map_err(std::io::Error::other)?;
    line.push('\n');
    stream.write_all(line.as_bytes())?;
    let mut reply = String::new();
    BufReader::new(stream.take(MAX_LINE)).read_line(&mut reply)?;
    let reply: Reply = serde_json::from_str(reply.trim()).map_err(std::io::Error::other)?;
    Ok(reply.handled)
}

/// Serve requests on a background thread; `handle(folder)` decides and raises the window.
pub fn serve<F>(listener: UnixListener, handle: F)
where
    F: Fn(Option<PathBuf>) -> bool + Send + 'static,
{
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = answer(stream, &handle);
        }
    });
}

fn answer<F: Fn(Option<PathBuf>) -> bool>(stream: UnixStream, handle: &F) -> std::io::Result<()> {
    stream.set_read_timeout(Some(TIMEOUT))?;
    stream.set_write_timeout(Some(TIMEOUT))?;
    let mut line = String::new();
    BufReader::new((&stream).take(MAX_LINE)).read_line(&mut line)?;
    let handled = match serde_json::from_str::<Request>(line.trim()) {
        Ok(req) if req.v == PROTOCOL => match req.folder.map(PathBuf::from) {
            // The client sends a canonical directory; anything else is declined.
            Some(f) if !f.is_absolute() => false,
            folder => handle(folder),
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
    fn takes_no_folder_or_the_open_one() {
        let open = Path::new("/w/a");
        assert!(takes(None, Some(open)));
        assert!(takes(None, None));
        assert!(takes(Some(open), Some(open)));
        assert!(!takes(Some(Path::new("/w/b")), Some(open)));
        assert!(!takes(Some(open), None));
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
    fn second_launch_is_forwarded_or_declined() {
        let path = sock("forward");
        let Claim::Primary(listener, _) = claim_at(&path, None) else { panic!("first claim must be primary") };
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s = seen.clone();
        serve(listener, move |f| {
            s.lock().unwrap().push(f.clone());
            takes(f.as_deref(), Some(Path::new("/w/open")))
        });
        assert!(matches!(claim_at(&path, None), Claim::Forwarded));
        assert!(matches!(claim_at(&path, Some("/w/open")), Claim::Forwarded));
        assert!(matches!(claim_at(&path, Some("/w/other")), Claim::Standalone));
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen, vec![None, Some(PathBuf::from("/w/open")), Some(PathBuf::from("/w/other"))]);
    }

    #[test]
    fn relative_or_bad_requests_are_declined() {
        let path = sock("bad");
        let Claim::Primary(listener, _) = claim_at(&path, None) else { panic!("primary") };
        serve(listener, |_| true);
        assert!(matches!(claim_at(&path, Some("relative/dir")), Claim::Standalone));
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
        assert!(matches!(claim_at(&path, None), Claim::Primary(..)));
    }

    #[test]
    fn silent_primary_fails_open() {
        let path = sock("silent");
        // Bound but never accepting: the client times out and opens its own window.
        let _l = UnixListener::bind(&path).unwrap();
        let t = std::time::Instant::now();
        assert!(matches!(claim_at(&path, None), Claim::Standalone));
        assert!(t.elapsed() < Duration::from_secs(5));
    }
}
