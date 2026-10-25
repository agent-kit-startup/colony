//! Guards for the Mission view's gate strip (no JS test runner exists). The answer buttons
//! must be reachable without scrolling: the strip is not a scroller of its own, the
//! question in it never scrolls, and a gate card puts its controls before the question.

const STYLES: &str = include_str!("../../src/styles.css");
const INBOX: &str = include_str!("../../src/inbox.ts");

/// Declarations of every rule whose selector list is exactly `selector`.
fn rules<'a>(css: &'a str, selector: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    for (i, _) in css.match_indices(selector) {
        let rest = &css[i + selector.len()..];
        let rest = rest.trim_start();
        let line_start = css[..i].rfind('\n').map_or(0, |n| n + 1);
        if !css[line_start..i].trim().is_empty() || !rest.starts_with('{') {
            continue;
        }
        let end = rest.find('}').expect("unclosed rule");
        out.push(&rest[1..end]);
    }
    out
}

#[test]
fn gate_strip_is_not_a_scroller() {
    for sel in [".gate-strip", ".cv-mission .gate-strip"] {
        let found = rules(STYLES, sel);
        assert!(!found.is_empty(), "no rule for {sel}");
        for body in found {
            assert!(!body.contains("overflow"), "{sel} must not scroll on its own: {body}");
            assert!(!body.contains("max-height"), "{sel} must not cap its height: {body}");
        }
    }
}

#[test]
fn gate_strip_prompt_is_clamped_not_scrolled() {
    let found = rules(STYLES, ".gate-strip .gate-prompt");
    assert_eq!(found.len(), 1);
    assert!(found[0].contains("overflow: hidden") && found[0].contains("line-clamp"), "{}", found[0]);
}

#[test]
fn gate_card_puts_controls_before_the_question() {
    let card = &INBOX[INBOX.find("export function gateCard(").expect("gateCard")..];
    let controls = card.find("gateControls(").expect("gateControls call");
    let prompt = card.find("\"gate-prompt\"").expect("gate-prompt");
    let line = card.find("\"inbox-line\"").expect("inbox-line");
    assert!(controls < prompt && controls < line, "answer controls must come before the question and the gate line");
}
