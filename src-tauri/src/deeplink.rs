//! The `colony://play` link (kit ADR 2026-11-06 oligarchy-game-handoff-colony-scheme, point 4).
//!
//! A web page chooses this URL, and on Linux it reaches the app as a command-line argument. So
//! Colony accepts one exact string with no parameters, and has nothing from the page to parse.
//! Anything else that looks like a link is refused: the process ends with no window, no folder,
//! no dialog and nothing sent to a running window.

pub const PLAY_URL: &str = "colony://play";

#[derive(Debug, PartialEq)]
pub enum Link {
    /// No argument looks like a link: a normal launch.
    None,
    /// `colony://play` and no other argument.
    Play,
    Refused,
}

fn is_link(arg: &str) -> bool {
    let arg = arg.trim_start().as_bytes();
    arg.len() >= 7 && arg[..7].eq_ignore_ascii_case(b"colony:")
}

/// What the command line (without the program name) asks for.
pub fn classify<I, S>(args: I) -> Link
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let args: Vec<S> = args.into_iter().collect();
    if !args.iter().any(|a| is_link(a.as_ref())) {
        return Link::None;
    }
    match args.as_slice() {
        [only] if only.as_ref() == PLAY_URL => Link::Play,
        _ => Link::Refused,
    }
}

/// The argument that names a folder: the first that is neither a flag nor a link.
pub fn folder_arg<I>(args: I) -> Option<String>
where
    I: IntoIterator<Item = String>,
{
    args.into_iter().find(|a| !a.starts_with('-') && !is_link(a))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_exact_url() {
        assert_eq!(classify(["colony://play"]), Link::Play);
    }

    /// Security requirement: a web page writes this URL, and no parameter may reach the app.
    #[test]
    fn refuses_every_other_link() {
        for url in [
            "colony://play?x",
            "colony://play?folder=/etc",
            "colony://play?",
            "colony://play/",
            "colony://play/x",
            "colony://play#f",
            "colony://play#",
            "colony://play%3Fx",
            "colony://play:80",
            "colony://user@play",
            "colony://Play",
            "COLONY://play",
            "Colony://play",
            "colony://playx",
            "colony://",
            "colony:",
            "colony:play",
            "colony:/play",
            "colony:///play",
            "colony://open?folder=/etc",
            " colony://play",
            "colony://play ",
            "colony://play\n",
        ] {
            assert_eq!(classify([url]), Link::Refused, "{url:?}");
        }
    }

    #[test]
    fn refuses_the_url_next_to_anything_else() {
        assert_eq!(classify(["colony://play", "colony://play"]), Link::Refused);
        assert_eq!(classify(["colony://play", "/tmp"]), Link::Refused);
        assert_eq!(classify(["/tmp", "colony://play"]), Link::Refused);
        assert_eq!(classify(["--new-instance", "colony://play"]), Link::Refused);
        assert_eq!(classify(["colony://play", "--inbox"]), Link::Refused);
    }

    #[test]
    fn a_launch_without_a_link_is_untouched() {
        assert_eq!(classify(Vec::<String>::new()), Link::None);
        assert_eq!(classify(["/home/me/project"]), Link::None);
        assert_eq!(classify(["--inbox"]), Link::None);
        assert_eq!(classify(["./colony:notes"]), Link::None);
        assert_eq!(classify(["https://example.com/colony://play"]), Link::None);
    }

    #[test]
    fn a_link_is_never_a_folder() {
        let folder = |args: &[&str]| folder_arg(args.iter().map(|a| a.to_string()));
        // `colony://play` as a path is the relative directory `colony:/play`.
        assert_eq!(folder(&["colony://play"]), None);
        assert_eq!(folder(&["--inbox"]), None);
        assert_eq!(folder(&["--new-instance", "/w/a"]), Some("/w/a".into()));
        assert_eq!(folder(&["/w/a", "/w/b"]), Some("/w/a".into()));
    }

    /// The refusal only protects the rest of the launch if it runs first.
    #[test]
    fn the_refusal_runs_before_the_socket_and_the_window() {
        let lib = include_str!("lib.rs");
        let body = &lib[lib.find("pub fn run()").expect("run")..];
        let refuse = body.find("Link::Refused").expect("the refusal");
        assert!(refuse < body.find("instance::socket_path()").expect("the socket"));
        assert!(refuse < body.find("tauri::Builder::default()").expect("the window"));
    }

    /// The bundler's own desktop entry has `Exec=colony`, which never hands the app the URL.
    #[test]
    fn the_deb_and_appimage_entry_takes_a_url() {
        let conf = include_str!("../tauri.conf.json");
        assert!(conf.contains("\"desktopTemplate\": \"../packaging/deb/colony.desktop.hbs\""));
        assert!(conf.contains("\"schemes\": [\"colony\"]"));
        let template = include_str!("../../packaging/deb/colony.desktop.hbs");
        assert!(template.lines().any(|line| line == "Exec={{exec}} %u"));
    }

    /// The Rust side does the registering, so the webview has no reason to call the plugin.
    #[test]
    fn the_webview_gets_no_deep_link_permission() {
        let capabilities = include_str!("../capabilities/default.json");
        assert!(!capabilities.contains("deep-link"));
    }
}
