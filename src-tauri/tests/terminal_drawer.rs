//! Guards for the terminal drawer as the single terminal control surface (ADR 2026-10-24
//! amend 2026-10-26, points 1 and 3): no rail Terminal item, the drawer bar stays on screen
//! when the drawer is closed, and the drawer lists the user's shells only (the interactive
//! CLIs and queue runners stay centre tabs and are not repeated there).

const STYLES: &str = include_str!("../../src/styles.css");
const MAIN: &str = include_str!("../../src/main.ts");
const TERMINAL: &str = include_str!("../../src/terminal.ts");

/// `css` without its comments.
fn strip_comments(css: &str) -> String {
    let mut out = String::new();
    let mut rest = css;
    while let Some(i) = rest.find("/*") {
        out.push_str(&rest[..i]);
        rest = rest[i..].find("*/").map_or("", |j| &rest[i + j + 2..]);
    }
    out.push_str(rest);
    out
}

/// (selector list, declarations) of every flat rule in `css` (comments stripped). An
/// at-rule block (@media, @keyframes, ...) is skipped whole: the drawer rules are flat.
fn all_rules(css: &str) -> Vec<(String, String)> {
    let css = strip_comments(css);
    let mut out = Vec::new();
    let mut rest = css.as_str();
    while let Some(open) = rest.find('{') {
        let sel = rest[..open].trim().to_string();
        if sel.starts_with('@') {
            // Skip to the brace that closes the at-rule.
            let mut depth = 0usize;
            let mut end = rest.len();
            for (i, c) in rest[open..].char_indices() {
                match c {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            end = open + i + 1;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            rest = &rest[end.min(rest.len())..];
            continue;
        }
        let close = rest[open..].find('}').expect("unclosed rule") + open;
        out.push((sel, rest[open + 1..close].to_string()));
        rest = &rest[close + 1..];
    }
    out
}

#[test]
fn a_closed_drawer_keeps_its_bar() {
    // With a folder open (no-folder: the welcome screen has no shells, so no bar).
    let closed: Vec<_> = all_rules(STYLES).into_iter().filter(|(s, _)| s.contains(".no-bottom") && !s.contains(".no-folder")).collect();
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

#[test]
fn ctrl_digits_match_the_rail_tooltips() {
    // Ctrl+1..9 are the first nine rail items in rail order (ADR 2026-10-24 amend
    // 2026-10-28); the drawer toggles with Ctrl+` only, so no digit names it.
    assert!(MAIN.contains("const CTRL_DIGITS = RAIL.slice(0, 9).map((r) => r.id);"), "Ctrl+<n> follows the rail order");
    let rail_start = MAIN.find("const RAIL: RailItem[] = [").expect("RAIL");
    let rail = &MAIN[rail_start..rail_start + MAIN[rail_start..].find("\n];").unwrap()];
    let items: Vec<&str> = rail.lines().filter(|l| l.contains("id: \"")).collect();
    assert_eq!(items.len(), 12, "every kit item on the rail");
    for (i, line) in items.iter().enumerate() {
        let id = line.split("id: \"").nth(1).unwrap().split('"').next().unwrap();
        if i < 9 {
            assert!(line.contains(&format!("(Ctrl+{})", i + 1)), "{id}: its tooltip must name Ctrl+{}", i + 1);
        } else {
            assert!(!line.contains("(Ctrl+"), "{id}: only the first nine items have a Ctrl+<n>");
        }
    }
    assert!(MAIN.contains("if (ev.code === \"Backquote\") toggleTerminal("), "Ctrl+` toggles the drawer");
    assert!(!MAIN.contains("Ctrl+5 or Ctrl+"), "the drawer toggle no longer claims Ctrl+5");
}
