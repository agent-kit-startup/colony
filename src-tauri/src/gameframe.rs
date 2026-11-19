//! The one remote page Colony shows: the Oligarchy game in its frame (kit ADR 2026-11-17
//! oligarchy-web-game-data-contract-colony-pairing, points 6 and 8). The webview refuses every
//! navigation, in the main frame or in a frame, that is not Colony's own page, an empty frame or
//! the game's exact origin, so the game frame cannot be taken to another site. The CSP
//! `frame-src` (tauri.conf.json) names the same origin (and `connect-src` for the view's HEAD
//! request that tells offline from online); no capability names it, so the page gets no Tauri
//! command.
//!
//! Colony's own page is allowed only until the main frame has committed it once. The frame keeps
//! its own origin for its storage (`allow-same-origin`), so a frame that reached Colony's page
//! would share Colony's origin and with it the IPC; after the first load nothing may navigate
//! there, the frame included (the release app never reloads its page; a debug build keeps the dev
//! server for hot reload).

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Url;

static APP_COMMITTED: AtomicBool = AtomicBool::new(false);

/// The main frame committed Colony's page (`on_page_load`, which WebKitGTK reports for the main
/// frame only): from now on Colony's own page is never a navigation target again.
pub fn app_committed() {
    APP_COMMITTED.store(true, Ordering::SeqCst);
}

/// The game's origin, the same string as `OLIGARCHY_ORIGINS` in src/oligarchyfeed.ts.
pub const GAME_ORIGIN: &str = "https://oligarchy.missionkit.io";

/// Whether the webview may navigate to `url` (WebKitGTK asks for the main frame and for every
/// subframe).
pub fn navigation_allowed(url: &Url) -> bool {
    allowed(url, APP_COMMITTED.load(Ordering::SeqCst))
}

/// `tauri://localhost` and `http(s)://tauri.localhost` are Colony's own page, allowed only before
/// `app_committed`; the dev server only in a debug build.
fn allowed(url: &Url, app_committed: bool) -> bool {
    let host = url.host_str();
    match url.scheme() {
        "tauri" => !app_committed && host == Some("localhost"),
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        "http" | "https" if host == Some("tauri.localhost") => !app_committed,
        "http" if cfg!(debug_assertions) && host == Some("localhost") && url.port() == Some(1420) => true,
        "https" => url.origin().ascii_serialization() == GAME_ORIGIN,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(u: &str) -> bool {
        allowed(&Url::parse(u).unwrap(), false)
    }

    fn ok_after_load(u: &str) -> bool {
        allowed(&Url::parse(u).unwrap(), true)
    }

    #[test]
    fn colony_and_the_game_origin_only() {
        for u in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/",
            "about:blank",
            "about:srcdoc",
            "https://oligarchy.missionkit.io/game/",
            "https://oligarchy.missionkit.io/",
            "https://oligarchy.missionkit.io:443/game/?v=1#x",
            "https://OLIGARCHY.missionkit.io/game/",
        ] {
            assert!(ok(u), "{u}");
        }
        for u in [
            "http://oligarchy.missionkit.io/game/",
            "https://oligarchy.missionkit.io:8443/game/",
            "https://oligarchy-staging.missionkit.io/game/",
            "https://oligarchy.missionkit.io.evil.com/",
            "https://evil-oligarchy.missionkit.io/",
            "https://oligarchy.missionkit.io@evil.com/",
            "https://evil.com/https://oligarchy.missionkit.io",
            "https://missionkit.io/",
            "https://github.com/",
            "http://127.0.0.1:4173/",
            "tauri://evil/index.html",
            "colony://play",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<p>x</p>",
            "blob:https://oligarchy.missionkit.io/1",
            "about:config",
        ] {
            assert!(!ok(u), "{u}");
        }
    }

    #[test]
    fn colony_page_only_before_its_first_load() {
        for u in ["tauri://localhost/index.html", "http://tauri.localhost/index.html", "https://tauri.localhost/"] {
            assert!(ok(u) && !ok_after_load(u), "{u}");
        }
        for u in ["https://oligarchy.missionkit.io/game/", "about:blank"] {
            assert!(ok_after_load(u), "{u}");
        }
        assert!(!ok_after_load("https://github.com/"));
        assert_eq!(ok_after_load("http://localhost:1420/"), cfg!(debug_assertions));
    }

    #[test]
    fn dev_server_only_in_a_debug_build() {
        assert_eq!(ok("http://localhost:1420/"), cfg!(debug_assertions));
        assert!(!ok("http://localhost:1421/"));
        assert!(!ok("https://localhost:1420/"));
    }

    #[test]
    fn same_origin_as_the_frontend_and_the_csp() {
        let feed = include_str!("../../src/oligarchyfeed.ts");
        assert!(feed.contains(&format!("Object.freeze([\"{GAME_ORIGIN}\"])")), "OLIGARCHY_ORIGINS is the production origin alone");
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = conf["app"]["security"]["csp"].as_str().unwrap();
        let frame = csp.split(';').map(str::trim).find(|d| d.starts_with("frame-src")).unwrap();
        assert_eq!(frame, format!("frame-src {GAME_ORIGIN}"), "{csp}");
        // The view's reachability request (HEAD, no-cors) is the one other address it reaches.
        let connect = csp.split(';').map(str::trim).find(|d| d.starts_with("connect-src")).unwrap();
        assert_eq!(connect, format!("connect-src 'self' ipc: http://ipc.localhost {GAME_ORIGIN}"), "{csp}");
        for cap in std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities")).unwrap() {
            let text = std::fs::read_to_string(cap.unwrap().path()).unwrap();
            assert!(!text.contains("missionkit.io") && !text.contains("\"remote\""), "no capability for a remote origin: {text}");
        }
    }
}
