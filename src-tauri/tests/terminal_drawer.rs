//! Guards for the terminal drawer as the single terminal control surface (ADR 2026-10-24
//! amend 2026-10-26, points 1 and 3): no rail Terminal item, the drawer bar stays on screen
//! when the drawer is closed, and the drawer lists the user's shells only (the interactive
//! CLIs and queue runners stay centre tabs and are not repeated there).

const STYLES: &str = include_str!("../../src/styles.css");
const MAIN: &str = include_str!("../../src/main.ts");
const TERMINAL: &str = include_str!("../../src/terminal.ts");

/// (selector list, declarations) of every top-level rule in `css`.
fn all_rules(css: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = css;
    while let Some(open) = rest.find('{') {
        let head = &rest[..open];
        let close = rest[open..].find('}').expect("unclosed rule") + open;
        // A selector is what follows the last comment or rule end before the brace.
        let sel = head.rsplit("*/").next().unwrap_or(head).trim().to_string();
        out.push((sel, rest[open + 1..close].to_string()));
        rest = &rest[close + 1..];
    }
    out
}

#[test]
fn a_closed_drawer_keeps_its_bar() {
    let closed: Vec<_> = all_rules(STYLES).into_iter().filter(|(s, _)| s.contains(".no-bottom")).collect();
    assert!(!closed.is_empty(), "no rule for the closed drawer");
    for (sel, body) in &closed {
        let hides = body.contains("display: none") || body.contains("visibility: hidden");
        for part in sel.split(',') {
            let part = part.trim();
            assert!(!(hides && (part.ends_with("#bottom") || part.ends_with("#term-tabs"))), "a closed drawer must keep its bar: {sel} {{{body}}}");
        }
    }
    let hides_terms = closed.iter().any(|(s, b)| s.split(',').any(|p| p.trim().ends_with("#terms")) && b.contains("display: none"));
    assert!(hides_terms, "a closed drawer hides its terminals (#terms), not its bar");
    let base = all_rules(STYLES).into_iter().find(|(s, _)| s == "#shell.no-bottom").expect("#shell.no-bottom");
    assert!(!base.1.contains("--th: 0px"), "the bottom/top track keeps the bar's height: {}", base.1);
}

#[test]
fn the_rail_has_no_terminal_item() {
    let start = MAIN.find("const RAIL: RailItem[] = [").expect("RAIL");
    let rail = &MAIN[start..start + MAIN[start..].find("\n];").expect("RAIL end")];
    assert!(!rail.contains("id: \"terminal\""), "the terminal toggle lives in the drawer bar, not the rail");
}

#[test]
fn the_drawer_bar_has_the_toggle_and_lists_shells_only() {
    let bar_start = MAIN.find("<div id=\"term-tabs\"").expect("#term-tabs markup");
    let bar = &MAIN[bar_start..bar_start + MAIN[bar_start..].find("</div>").expect("#term-tabs end")];
    assert!(bar.contains("data-act=\"toggle-terminal\""), "the drawer bar holds the show / hide toggle");
    assert!(bar.contains("class=\"tab-add\"") && bar.contains("data-dock=\"side\""), "new shell and dock controls stay in the bar");
    for gone in ["term-linked", "linkedTerms", "renderDrawerLinks"] {
        assert!(!MAIN.contains(gone), "{gone}: the drawer no longer repeats the centre terminal tabs");
    }
    for gone in ["setLinked", "term-link"] {
        assert!(!TERMINAL.contains(gone), "{gone}: the drawer no longer repeats the centre terminal tabs");
    }
    assert!(MAIN.contains("terminal: () => toggleTerminal()"), "View → Show or hide the terminal keeps its action");
}
