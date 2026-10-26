//! Guards for the plan / HANDOFF preview (plan colony-shell-topbar t3). The renderer runs on
//! untrusted text (plans, HANDOFF, agent output): it builds the DOM with h() only, the parser
//! has no DOM and no imports (scripts/markdown.test.mjs runs it in Node), and only plan files
//! and the HANDOFF open rendered; every other file opens in the editor.

const MAIN: &str = include_str!("../../src/main.ts");
const MARKDOWN: &str = include_str!("../../src/markdown.ts");
const PREVIEW: &str = include_str!("../../src/docpreview.ts");
const TRANSCRIPT: &str = include_str!("../../src/transcript.ts");

#[test]
fn the_renderer_never_writes_markup() {
    for (name, src) in [("markdown.ts", MARKDOWN), ("docpreview.ts", PREVIEW), ("transcript.ts", TRANSCRIPT)] {
        for bad in ["innerHTML", "outerHTML", "insertAdjacentHTML", "DOMParser", "document.write"] {
            assert!(!src.contains(bad), "{name} uses {bad}: rendered Markdown must be built with h()");
        }
    }
    // A link never gets an href: the webview does not navigate (repo files open in Colony,
    // web addresses are copied).
    let link = &TRANSCRIPT[TRANSCRIPT.find("function linkNode(").expect("linkNode")..];
    let link = &link[..link.find("\n}\n").expect("linkNode end")];
    let attrs = &link[link.find("h(\"a\", {").expect("the link element")..];
    let attrs = &attrs[..attrs.find('}').unwrap()];
    assert!(!attrs.contains("href:") && !link.contains("\"href\"") && !link.contains(".href ="), "a rendered link must not carry an href: {attrs}");
}

#[test]
fn the_parser_is_pure() {
    assert!(!MARKDOWN.lines().any(|l| l.starts_with("import ")), "markdown.ts must not import (Node runs it in pnpm test)");
    for dom in ["document.", "window.", "HTMLElement"] {
        assert!(!MARKDOWN.contains(dom), "markdown.ts must not touch the DOM ({dom})");
    }
}

#[test]
fn only_plans_and_the_handoff_open_rendered() {
    let f = &MAIN[MAIN.find("function isPreviewDoc(").expect("isPreviewDoc")..];
    let f = &f[..f.find("\n}\n").expect("isPreviewDoc end")];
    assert!(f.contains(r"/^\.cursor\/plans\/.+\.md$/") && f.contains("\"HANDOFF.md\""), "{f}");
    let open = &MAIN[MAIN.find("openRepoFile: (rel) => {").expect("host.openRepoFile")..];
    let open = &open[..open.find("\n  },").unwrap()];
    assert!(open.contains("isPreviewDoc(path) ? \"preview\" : undefined"), "{open}");
    assert!(MAIN.contains("new Editors($(\"monaco-host\")"), "Monaco lives under the Preview | Editor bar");
}
