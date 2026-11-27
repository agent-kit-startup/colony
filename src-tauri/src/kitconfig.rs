//! Settings → Kit config: the open folder's `.cursor/agent-kit.config.json`, as a form plus a
//! raw JSON editor (kit ADR 2026-10-24, amend 2026-11-19 point 7).
//!
//! Scope: every command joins the open folder with the one fixed relative path below. No
//! command takes a path, and a `.cursor` folder or a file that resolves outside the folder (a
//! symlink) is refused.
//!
//! Writes: invalid JSON is never written. A form edit changes only the text of the edited
//! value (indentation, key order, line endings and every other byte stay as they were): the
//! value's span is located by a small path-aware scanner and replaced, and the result is
//! parsed again and compared with the old document plus that one change before it is written.
//! The raw editor writes the operator's text verbatim once it parses as a JSON object.
//!
//! Form source (FIELDS): the kit ships no JSON Schema for this file (kit `schemas/` holds the
//! manifest and pack schemas only), and the Mission Control Config allowlist
//! (`dashboard/lib/guards.mjs` `validateConfigWriteBody`) validates a different file,
//! `.cursor/context/config.json` (the kit's operator settings; Settings → Kit config edits it
//! too, in `contextconfig.rs`). This file is the scanner's repository profile
//! (`RepositoryProfile`, kit `packages/cli/src/types.ts` at kit commit 30d6a55f), refreshed by
//! `doctor` with fresh scanner values winning on shared keys. So the form offers only the
//! values the kit reads back as the operator's confirmation instead of re-detecting them:
//! `purpose.value` (scanner/detect-repository.ts `readConfirmedPurpose`), `git.provider`
//! (scanner/detect-git.ts `detectProvider`), and `stack.language` with `stack.testCommands` /
//! `stack.validationCommands` (scanner/detect-stack.ts `readConfirmedStack`). Every other key
//! is edited in the raw JSON. A kit-shipped JSON Schema replaces this table when one exists.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::AppState;

/// The one file these commands read and write, relative to the open folder.
pub const REL_DIR: &str = ".cursor";
pub const FILE_NAME: &str = "agent-kit.config.json";
/// A raw write larger than this is refused (the scanner's profile is a few KiB).
const MAX_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// One of `options`.
    Choice,
    /// A non-empty string.
    Text,
    /// An array of non-empty strings (one per line in the form).
    Lines,
}

pub struct Field {
    pub path: &'static [&'static str],
    pub label: &'static str,
    pub kind: Kind,
    pub options: &'static [&'static str],
}

/// The form's fields (see the module comment for where they come from).
pub const FIELDS: &[Field] = &[
    Field {
        path: &["purpose", "value"],
        label: "Purpose",
        kind: Kind::Choice,
        // RepositoryPurpose (kit packages/cli/src/types.ts).
        options: &["application", "library", "monorepo", "documentation", "knowledge", "operations", "automation", "mixed", "unknown"],
    },
    Field {
        path: &["git", "provider"],
        label: "Git provider",
        kind: Kind::Choice,
        // GitProvider (kit packages/cli/src/types.ts).
        options: &["github", "gitlab", "bitbucket", "azure-devops", "gitea", "other"],
    },
    Field { path: &["stack", "language"], label: "Stack language", kind: Kind::Text, options: &[] },
    Field { path: &["stack", "testCommands"], label: "Test commands", kind: Kind::Lines, options: &[] },
    Field { path: &["stack", "validationCommands"], label: "Validation commands", kind: Kind::Lines, options: &[] },
];

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FieldInfo {
    /// Dotted path (`stack.testCommands`).
    path: String,
    label: &'static str,
    kind: Kind,
    options: &'static [&'static str],
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KitConfigInfo {
    /// Absolute path of the file (shown to the operator).
    path: String,
    exists: bool,
    /// The folder has a `.cursor` folder, so the raw editor may create the file.
    can_create: bool,
    /// The file's text as it is on disk (none when missing).
    text: Option<String>,
    fields: Vec<FieldInfo>,
}

fn field_infos() -> Vec<FieldInfo> {
    FIELDS.iter().map(|f| FieldInfo { path: f.path.join("."), label: f.label, kind: f.kind, options: f.options }).collect()
}

/// `<root>/.cursor/agent-kit.config.json`, refused when `.cursor` or the file resolves
/// anywhere else (a symlink, even one pointing inside the folder) or the file is not a regular
/// file. `Ok((path, cursor_dir_exists))`; the file itself may be missing.
pub fn resolve(root: &Path) -> Result<(PathBuf, bool), String> {
    let root = root.canonicalize().map_err(|e| format!("{}: {e}", root.display()))?;
    let dir = root.join(REL_DIR);
    let file = dir.join(FILE_NAME);
    match std::fs::symlink_metadata(&dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((file, false)),
        Err(e) => return Err(format!("{}: {e}", dir.display())),
        Ok(m) if m.file_type().is_symlink() || !m.is_dir() => return Err(format!("{} is not a folder inside {}", dir.display(), root.display())),
        Ok(_) => {}
    }
    match std::fs::symlink_metadata(&file) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((file, true)),
        Err(e) => Err(format!("{}: {e}", file.display())),
        Ok(m) if m.file_type().is_symlink() || !m.is_file() => Err(format!("{} is not a regular file inside {}", file.display(), root.display())),
        Ok(_) => {
            let real = file.canonicalize().map_err(|e| format!("{}: {e}", file.display()))?;
            if real != file {
                return Err(format!("{} resolves outside {}", file.display(), root.display()));
            }
            Ok((file, true))
        }
    }
}

fn read_text(file: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(file) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", file.display())),
    }
}

pub fn info_at(root: &Path) -> Result<KitConfigInfo, String> {
    let (file, dir) = resolve(root)?;
    let text = read_text(&file)?;
    Ok(KitConfigInfo { path: file.display().to_string(), exists: text.is_some(), can_create: dir, text, fields: field_infos() })
}

/// Parse `text` as the kit config: a JSON object, else an error naming why nothing is written.
pub fn parse_object(text: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("Invalid JSON ({e}); nothing was written"))?;
    if !v.is_object() {
        return Err("The kit config must be a JSON object; nothing was written".into());
    }
    Ok(v)
}

/// Check a form value against its field: the JSON value to write.
pub fn check_value(path: &str, value: &Value) -> Result<(&'static Field, Value), String> {
    let f = FIELDS.iter().find(|f| f.path.join(".") == path).ok_or_else(|| format!("{path} is not a form field; edit it in the raw JSON"))?;
    let v = match (f.kind, value) {
        (Kind::Choice, Value::String(s)) if f.options.contains(&s.as_str()) => value.clone(),
        (Kind::Choice, _) => return Err(format!("{path}: one of {}", f.options.join(", "))),
        (Kind::Text, Value::String(s)) if !s.trim().is_empty() => Value::String(s.trim().to_string()),
        (Kind::Text, _) => return Err(format!("{path}: a non-empty string")),
        (Kind::Lines, Value::Array(a)) => {
            let mut out = Vec::new();
            for x in a {
                match x.as_str().map(str::trim) {
                    Some("") => {}
                    Some(s) => out.push(Value::String(s.to_string())),
                    None => return Err(format!("{path}: strings only")),
                }
            }
            Value::Array(out)
        }
        (Kind::Lines, _) => return Err(format!("{path}: an array of strings")),
    };
    Ok((f, v))
}

// ---- the targeted text patch ---------------------------------------------------------------

/// A minimal JSON walker over text already known to parse: the byte span of the value at
/// `path` (object keys only; the first member with a key wins, and the caller's re-parse
/// check refuses a file whose duplicate keys would make that the wrong one).
struct Walk<'a> {
    s: &'a [u8],
    text: &'a str,
    i: usize,
}

impl<'a> Walk<'a> {
    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn peek(&self) -> Result<u8, String> {
        self.s.get(self.i).copied().ok_or_else(|| "unexpected end of JSON".to_string())
    }

    fn expect(&mut self, b: u8) -> Result<(), String> {
        if self.peek()? != b {
            return Err(format!("expected {:?} at byte {}", b as char, self.i));
        }
        self.i += 1;
        Ok(())
    }

    /// A string; its decoded value.
    fn string(&mut self) -> Result<String, String> {
        let start = self.i;
        self.expect(b'"')?;
        while self.peek()? != b'"' {
            if self.s[self.i] == b'\\' {
                self.i += 1;
            }
            self.i += 1;
        }
        self.i += 1;
        serde_json::from_str(&self.text[start..self.i]).map_err(|e| e.to_string())
    }

    /// Skip one value; the span of the value at `path` inside it, if any (`path` empty: this
    /// value's own span).
    fn value(&mut self, path: &[&str]) -> Result<Option<(usize, usize)>, String> {
        self.ws();
        let start = self.i;
        let mut found = None;
        match self.peek()? {
            b'{' => {
                self.i += 1;
                self.ws();
                if self.peek()? == b'}' {
                    self.i += 1;
                } else {
                    loop {
                        self.ws();
                        let key = self.string()?;
                        self.ws();
                        self.expect(b':')?;
                        let want = !path.is_empty() && found.is_none() && key == path[0];
                        let sub = self.value(if want { &path[1..] } else { &[] })?;
                        if want {
                            found = sub;
                        }
                        self.ws();
                        match self.peek()? {
                            b',' => self.i += 1,
                            b'}' => {
                                self.i += 1;
                                break;
                            }
                            c => return Err(format!("unexpected {:?} at byte {}", c as char, self.i)),
                        }
                    }
                }
            }
            b'[' => {
                self.i += 1;
                self.ws();
                if self.peek()? == b']' {
                    self.i += 1;
                } else {
                    loop {
                        self.value(&[])?;
                        self.ws();
                        match self.peek()? {
                            b',' => self.i += 1,
                            b']' => {
                                self.i += 1;
                                break;
                            }
                            c => return Err(format!("unexpected {:?} at byte {}", c as char, self.i)),
                        }
                    }
                }
            }
            b'"' => {
                self.string()?;
            }
            _ => {
                while self.i < self.s.len() && !matches!(self.s[self.i], b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r') {
                    self.i += 1;
                }
                if self.i == start {
                    return Err(format!("unexpected byte at {start}"));
                }
            }
        }
        Ok(if path.is_empty() { Some((start, self.i)) } else { found })
    }
}

/// The byte span of the value at `path` in `text` (none when a key on the path is missing).
pub fn value_span(text: &str, path: &[&str]) -> Result<Option<(usize, usize)>, String> {
    let mut w = Walk { s: text.as_bytes(), text, i: 0 };
    let span = w.value(path)?;
    w.ws();
    if w.i != text.len() {
        return Err(format!("trailing text at byte {}", w.i));
    }
    Ok(span)
}

/// The whitespace that starts the line holding byte `at`.
fn line_indent(text: &str, at: usize) -> &str {
    let line = text[..at].rfind('\n').map_or(0, |n| n + 1);
    let rest = &text[line..at];
    &rest[..rest.len() - rest.trim_start_matches([' ', '\t']).len()]
}

/// The file's indent unit: the leading whitespace of its first indented line (else 2 spaces).
fn indent_unit(text: &str) -> &str {
    text.lines()
        .map(|l| &l[..l.len() - l.trim_start_matches([' ', '\t']).len()])
        .find(|w| !w.is_empty())
        .unwrap_or("  ")
}

/// The text for `new` in place of the old value text `old` at `start` of `text`, in the old
/// value's style: a scalar as compact JSON; an array on one line when the old one was on one
/// line, else one item per line at the old items' indent (an empty array that gains items:
/// the key line's indent plus the file's indent unit), with the file's line ending.
fn render(text: &str, start: usize, old: &str, new: &Value) -> Result<String, String> {
    let Value::Array(items) = new else {
        return serde_json::to_string(new).map_err(|e| e.to_string());
    };
    let items: Vec<String> = items.iter().map(serde_json::to_string).collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    if !(old.starts_with('[') && old.ends_with(']')) {
        // The file held another type there: compact JSON, nothing to match.
        return Ok(format!("[{}]", items.join(", ")));
    }
    if items.is_empty() {
        return Ok("[]".into());
    }
    let inner = &old[1..old.len() - 1];
    let empty = inner.trim().is_empty();
    if !old.contains('\n') && !empty {
        // One line: the old separator (a lone item: the file's `": "` style says ", ").
        let spaced = if inner.contains(',') { inner.contains(", ") } else { text.contains("\": ") };
        return Ok(format!("[{}]", items.join(if spaced { ", " } else { "," })));
    }
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let (item, close) = if empty {
        let key = line_indent(text, start);
        (format!("{key}{}", indent_unit(text)), key.to_string())
    } else {
        let first = start + 1 + (inner.len() - inner.trim_start().len());
        (line_indent(text, first).to_string(), line_indent(text, start + old.len() - 1).to_string())
    };
    let body: Vec<String> = items.iter().map(|x| format!("{item}{x}")).collect();
    Ok(format!("[{nl}{}{nl}{close}]", body.join(&format!(",{nl}"))))
}

/// `text` with the value at `path` replaced by `new`, every other byte unchanged. Refused when
/// the key is missing (the form edits only values the file has) or the result would not parse
/// back to the old document with exactly that one change.
pub fn patch_text(text: &str, path: &[&str], new: &Value) -> Result<String, String> {
    let old_doc = parse_object(text)?;
    let pointer = format!("/{}", path.join("/"));
    if old_doc.pointer(&pointer) == Some(new) {
        // The same value, however it is spelled in the file: nothing to change.
        return Ok(text.to_string());
    }
    let (start, end) = value_span(text, path)?.ok_or_else(|| format!("{} is not in the file; add it in the raw JSON", path.join(".")))?;
    let replaced = render(text, start, &text[start..end], new)?;
    let out = format!("{}{}{}", &text[..start], replaced, &text[end..]);
    let mut want = old_doc;
    *want.pointer_mut(&pointer).ok_or_else(|| format!("{} is not in the file", path.join(".")))? = new.clone();
    let got: Value = serde_json::from_str(&out).map_err(|e| format!("The edit would break the JSON ({e}); nothing was written"))?;
    if got != want {
        return Err(format!("The file has {} more than once; edit it in the raw JSON", path.join(".")));
    }
    Ok(out)
}

/// `v` as JSON text for a member written at indent `base`: objects and arrays one member per
/// line with the file's indent `unit` and line ending `nl`, scalars compact.
fn render_at(v: &Value, base: &str, unit: &str, nl: &str) -> Result<String, String> {
    let inner = format!("{base}{unit}");
    match v {
        Value::Object(m) if !m.is_empty() => {
            let mut rows = Vec::new();
            for (k, x) in m {
                rows.push(format!("{inner}{}: {}", serde_json::to_string(k).map_err(|e| e.to_string())?, render_at(x, &inner, unit, nl)?));
            }
            Ok(format!("{{{nl}{}{nl}{base}}}", rows.join(&format!(",{nl}"))))
        }
        Value::Array(a) if !a.is_empty() => {
            let rows: Vec<String> = a.iter().map(|x| render_at(x, &inner, unit, nl).map(|t| format!("{inner}{t}"))).collect::<Result<_, _>>()?;
            Ok(format!("[{nl}{}{nl}{base}]", rows.join(&format!(",{nl}"))))
        }
        _ => serde_json::to_string(v).map_err(|e| e.to_string()),
    }
}

/// `text` with the member `key: value` added at the end of the object spanning `start..end`,
/// in the object's style: one member per line at the other members' indent (an empty object
/// opens on new lines at the key line's indent plus the file's unit, the shape Mission
/// Control's `JSON.stringify(…, null, 2)` writes), or on the same line when the object is on
/// one line.
fn insert_member(text: &str, start: usize, end: usize, key: &str, value: &Value) -> Result<String, String> {
    let obj = &text[start..end];
    if !(obj.starts_with('{') && obj.ends_with('}')) {
        return Err("not an object".into());
    }
    let inner = &obj[1..obj.len() - 1];
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let unit = indent_unit(text);
    let key = serde_json::to_string(key).map_err(|e| e.to_string())?;
    let (at, add) = if inner.trim().is_empty() {
        let base = line_indent(text, start);
        let member = format!("{base}{unit}");
        return Ok(format!("{}{{{nl}{member}{key}: {}{nl}{base}}}{}", &text[..start], render_at(value, &member, unit, nl)?, &text[end..]));
    } else if inner.contains('\n') {
        let first = start + 1 + (inner.len() - inner.trim_start().len());
        let member = line_indent(text, first);
        (start + 1 + inner.trim_end().len(), format!(",{nl}{member}{key}: {}", render_at(value, member, unit, nl)?))
    } else {
        let colon = if inner.contains("\":") && !inner.contains("\": ") { ":" } else { ": " };
        let comma = if inner.contains(',') && !inner.contains(", ") { "," } else { ", " };
        (start + 1 + inner.trim_end().len(), format!("{comma}{key}{colon}{}", serde_json::to_string(value).map_err(|e| e.to_string())?))
    };
    Ok(format!("{}{}{}", &text[..at], add, &text[at..]))
}

/// `text` without the member whose value spans `vstart..vend` (key `key`), with its comma; the
/// next member moves up into its place. The last member takes the comma before it; a lone
/// member leaves `{}`.
fn remove_member(text: &str, vstart: usize, vend: usize, key: &str) -> Result<String, String> {
    let s = text.as_bytes();
    let is_ws = |b: u8| matches!(b, b' ' | b'\t' | b'\n' | b'\r');
    let mut i = vstart;
    while i > 0 && is_ws(s[i - 1]) {
        i -= 1;
    }
    if i == 0 || s[i - 1] != b':' {
        return Err("no member there".into());
    }
    i -= 1;
    while i > 0 && is_ws(s[i - 1]) {
        i -= 1;
    }
    let quoted = serde_json::to_string(key).map_err(|e| e.to_string())?;
    if !text[..i].ends_with(&quoted) {
        return Err(format!("the key {quoted} is spelled with escapes in the file"));
    }
    let kstart = i - quoted.len();
    let mut j = vend;
    while j < s.len() && is_ws(s[j]) {
        j += 1;
    }
    if j < s.len() && s[j] == b',' {
        let mut k = j + 1;
        while k < s.len() && is_ws(s[k]) {
            k += 1;
        }
        return Ok(format!("{}{}", &text[..kstart], &text[k..]));
    }
    let mut b = kstart;
    while b > 0 && is_ws(s[b - 1]) {
        b -= 1;
    }
    if b > 0 && s[b - 1] == b',' {
        return Ok(format!("{}{}", &text[..b - 1], &text[vend..]));
    }
    // The only member: `{` before it, `}` after it.
    Ok(format!("{}{}", &text[..b], &text[j..]))
}

/// `text` with the value at `path` set to `new` (`None`: the member removed), every other byte
/// unchanged. A missing member is added (with any missing parent objects) at the end of its
/// object. Refused when a parent on the path is not an object, or the result would not parse
/// back to the old document with exactly that one change (a duplicate key, a key spelled with
/// escapes).
pub fn edit_text(text: &str, path: &[&str], new: Option<&Value>) -> Result<String, String> {
    let old_doc = parse_object(text)?;
    let mut want = old_doc.clone();
    {
        let mut cur = &mut want;
        for k in &path[..path.len() - 1] {
            let obj = cur.as_object_mut().ok_or_else(|| format!("{} is not an object in the file", path.join(".")))?;
            if new.is_none() && !obj.contains_key(*k) {
                return Ok(text.to_string());
            }
            cur = obj.entry(k.to_string()).or_insert_with(|| Value::Object(Default::default()));
        }
        let obj = cur.as_object_mut().ok_or_else(|| format!("{} is not an object in the file", path[..path.len() - 1].join(".")))?;
        let last = path[path.len() - 1].to_string();
        match new {
            Some(v) => {
                obj.insert(last, v.clone());
            }
            None => {
                obj.remove(&last);
            }
        }
    }
    if want == old_doc {
        return Ok(text.to_string());
    }
    let out = match (new, value_span(text, path)?) {
        (Some(v), Some((start, end))) => format!("{}{}{}", &text[..start], render(text, start, &text[start..end], v)?, &text[end..]),
        (Some(v), None) => {
            // The deepest object on the path that the file has; the rest is added under it.
            let mut have = 0;
            let mut cur = &old_doc;
            while have < path.len() - 1 {
                match cur.get(path[have]) {
                    Some(x) => {
                        cur = x;
                        have += 1;
                    }
                    None => break,
                }
            }
            let (start, end) = value_span(text, &path[..have])?.ok_or_else(|| format!("{} is not in the file", path[..have].join(".")))?;
            let mut value = v.clone();
            for k in path[have + 1..].iter().rev() {
                value = Value::Object([(k.to_string(), value)].into_iter().collect());
            }
            insert_member(text, start, end, path[have], &value)?
        }
        (None, Some((start, end))) => remove_member(text, start, end, path[path.len() - 1])?,
        (None, None) => return Ok(text.to_string()),
    };
    let got: Value = serde_json::from_str(&out).map_err(|e| format!("The edit would break the JSON ({e}); nothing was written"))?;
    if got != want {
        return Err(format!("The file has {} more than once; nothing was written", path.join(".")));
    }
    Ok(out)
}

// ---- writes ----------------------------------------------------------------------------------

/// One kit-config writer at a time in this process (both kit files: this one and
/// `contextconfig.rs`).
pub(crate) static WRITE: Mutex<()> = Mutex::new(());

/// Temp file in the same folder, the old file's permissions, then rename.
pub(crate) fn write_atomic(file: &Path, text: &str) -> Result<(), String> {
    use std::io::Write;
    let tmp = file.with_extension(format!("json.colony-{}.tmp", std::process::id()));
    let mut f = std::fs::File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
    let done = f.write_all(text.as_bytes()).and_then(|_| f.sync_all());
    drop(f);
    if let Ok(m) = std::fs::metadata(file) {
        let _ = std::fs::set_permissions(&tmp, m.permissions());
    }
    done.and_then(|_| std::fs::rename(&tmp, file)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {e}", file.display())
    })
}

/// A form edit: read the file fresh, patch the one value, write.
pub fn set_at(root: &Path, path: &str, value: &Value) -> Result<KitConfigInfo, String> {
    let (field, value) = check_value(path, value)?;
    let _one = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let (file, _) = resolve(root)?;
    let text = read_text(&file)?.ok_or_else(|| format!("{} does not exist", file.display()))?;
    let out = patch_text(&text, field.path, &value)?;
    if out != text {
        write_atomic(&file, &out)?;
    }
    info_at(root)
}

/// The raw editor's save: `text` verbatim once it parses as a JSON object. `base` is the text
/// the editor started from (none: the file was missing); a file changed on disk since then is
/// not overwritten. A missing file is created only inside an existing `.cursor` folder.
pub fn write_raw_at(root: &Path, text: &str, base: Option<&str>) -> Result<KitConfigInfo, String> {
    if text.len() > MAX_BYTES {
        return Err(format!("The text is over {} KiB; nothing was written", MAX_BYTES / 1024));
    }
    parse_object(text)?;
    let _one = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let (file, dir) = resolve(root)?;
    if !dir {
        return Err(format!("{} has no {REL_DIR} folder (not an Agent Kit folder); nothing was written", root.display()));
    }
    if read_text(&file)?.as_deref() != base {
        return Err("The file changed on disk since it was loaded; reload it. Nothing was written".into());
    }
    write_atomic(&file, text)?;
    info_at(root)
}

#[tauri::command]
pub fn kit_config_read(state: State<'_, AppState>) -> Result<KitConfigInfo, String> {
    info_at(&crate::workspace::workspace_root(&state)?)
}

/// A form edit of one FIELDS value (`path` is the field's dotted path, not a file path).
#[tauri::command]
pub fn kit_config_set(state: State<'_, AppState>, path: String, value: Value) -> Result<KitConfigInfo, String> {
    set_at(&crate::workspace::workspace_root(&state)?, &path, &value)
}

#[tauri::command]
pub fn kit_config_write_raw(state: State<'_, AppState>, text: String, base: Option<String>) -> Result<KitConfigInfo, String> {
    write_raw_at(&crate::workspace::workspace_root(&state)?, &text, base.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn folder(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("colony-kitconfig-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(REL_DIR)).unwrap();
        d
    }

    fn file(root: &Path) -> PathBuf {
        root.join(REL_DIR).join(FILE_NAME)
    }

    const PROFILE: &str = "{\n  \"schemaVersion\": 1,\n  \"purpose\": {\n    \"value\": \"mixed\",\n    \"categories\": [\"monorepo\"],\n    \"note\": \"the \\\"value\\\": key\"\n  },\n  \"stack\": {\n    \"language\": \"node\",\n    \"testCommands\": [\n      \"pnpm test\"\n    ],\n    \"validationCommands\": [],\n    \"value\": \"other\"\n  },\n  \"git\": { \"provider\": \"github\", \"workflow\": \"homolog-prod\" },\n  \"unknownKey\": {\"keep\":   true}\n}";

    #[test]
    fn an_unchanged_file_stays_byte_identical() {
        let root = folder("same");
        std::fs::write(file(&root), PROFILE).unwrap();
        let before = std::fs::metadata(file(&root)).unwrap().modified().unwrap();
        set_at(&root, "purpose.value", &json!("mixed")).unwrap();
        set_at(&root, "stack.testCommands", &json!(["pnpm test"])).unwrap();
        assert_eq!(std::fs::read_to_string(file(&root)).unwrap(), PROFILE);
        assert_eq!(std::fs::metadata(file(&root)).unwrap().modified().unwrap(), before, "no write when nothing changes");
        // A patch to the same value is the same text, whatever the formatting.
        for t in [PROFILE, &PROFILE.replace('\n', "\r\n"), &PROFILE.replace("  ", "\t"), PROFILE.trim_end()] {
            assert_eq!(patch_text(t, &["stack", "language"], &json!("node")).unwrap(), t);
        }
        // Spelled differently, the same value: the file is not re-rendered.
        let t = "{\"stack\": {\"language\": \"n\\u00f6de\", \"testCommands\": [ \"a\" ]}}";
        assert_eq!(patch_text(t, &["stack", "language"], &json!("nöde")).unwrap(), t);
        assert_eq!(patch_text(t, &["stack", "testCommands"], &json!(["a"])).unwrap(), t);
    }

    #[test]
    fn one_edit_changes_only_that_span() {
        let out = patch_text(PROFILE, &["purpose", "value"], &json!("library")).unwrap();
        assert_eq!(out, PROFILE.replacen("\"value\": \"mixed\"", "\"value\": \"library\"", 1));
        // The same key under another parent and the key name inside a string stay as they were.
        assert!(out.contains("\"value\": \"other\"") && out.contains("the \\\"value\\\": key"));
        let out = patch_text(PROFILE, &["git", "provider"], &json!("gitlab")).unwrap();
        assert_eq!(out, PROFILE.replace("{ \"provider\": \"github\",", "{ \"provider\": \"gitlab\","));
        let out = patch_text(PROFILE, &["stack", "language"], &json!("rust")).unwrap();
        assert_eq!(out, PROFILE.replace("\"language\": \"node\"", "\"language\": \"rust\""));
    }

    #[test]
    fn arrays_keep_the_file_style() {
        // Multi-line array: items at the old items' indent, closing bracket where it was.
        let out = patch_text(PROFILE, &["stack", "testCommands"], &json!(["pnpm test", "cargo test"])).unwrap();
        assert_eq!(out, PROFILE.replace("[\n      \"pnpm test\"\n    ]", "[\n      \"pnpm test\",\n      \"cargo test\"\n    ]"));
        // An empty array that gains items: the key line's indent plus the file's unit.
        let out = patch_text(PROFILE, &["stack", "validationCommands"], &json!(["pnpm build"])).unwrap();
        assert_eq!(out, PROFILE.replace("\"validationCommands\": []", "\"validationCommands\": [\n      \"pnpm build\"\n    ]"));
        // Emptied: [].
        let out = patch_text(PROFILE, &["stack", "testCommands"], &json!([])).unwrap();
        assert_eq!(out, PROFILE.replace("[\n      \"pnpm test\"\n    ]", "[]"));
        // One-line array stays on one line, with its separator.
        let t = "{\"stack\":{\"language\":\"go\",\"testCommands\":[\"go test\"]}}";
        assert_eq!(patch_text(t, &["stack", "testCommands"], &json!(["go test", "go vet"])).unwrap(), "{\"stack\":{\"language\":\"go\",\"testCommands\":[\"go test\",\"go vet\"]}}");
    }

    #[test]
    fn tabs_four_spaces_crlf_and_no_trailing_newline() {
        let tabs = "{\n\t\"stack\": {\n\t\t\"language\": \"node\",\n\t\t\"testCommands\": []\n\t}\n}\n";
        assert_eq!(
            patch_text(tabs, &["stack", "testCommands"], &json!(["a"])).unwrap(),
            "{\n\t\"stack\": {\n\t\t\"language\": \"node\",\n\t\t\"testCommands\": [\n\t\t\t\"a\"\n\t\t]\n\t}\n}\n"
        );
        let four = "{\n    \"stack\": {\n        \"testCommands\": [\n            \"x\"\n        ]\n    }\n}";
        assert_eq!(
            patch_text(four, &["stack", "testCommands"], &json!(["x", "y"])).unwrap(),
            "{\n    \"stack\": {\n        \"testCommands\": [\n            \"x\",\n            \"y\"\n        ]\n    }\n}"
        );
        let crlf = PROFILE.replace('\n', "\r\n");
        let out = patch_text(&crlf, &["stack", "testCommands"], &json!(["pnpm test", "b"])).unwrap();
        assert_eq!(out, crlf.replace("[\r\n      \"pnpm test\"\r\n    ]", "[\r\n      \"pnpm test\",\r\n      \"b\"\r\n    ]"));
        let out = patch_text(&crlf, &["purpose", "value"], &json!("library")).unwrap();
        assert_eq!(out, crlf.replacen("\"mixed\"", "\"library\"", 1));
    }

    #[test]
    fn escapes_and_unicode_round_trip() {
        let t = "{\"stack\": {\"language\": \"n\\u00f6de \\\"x\\\"\", \"testCommands\": [\"echo \\\"hi\\\"\"]}}";
        assert_eq!(patch_text(t, &["stack", "language"], &json!("ünï \"q\"")).unwrap(), "{\"stack\": {\"language\": \"ünï \\\"q\\\"\", \"testCommands\": [\"echo \\\"hi\\\"\"]}}");
        let out = patch_text(t, &["stack", "testCommands"], &json!(["echo \"hi\"", "a\\b"])).unwrap();
        assert_eq!(out, "{\"stack\": {\"language\": \"n\\u00f6de \\\"x\\\"\", \"testCommands\": [\"echo \\\"hi\\\"\", \"a\\\\b\"]}}");
    }

    #[test]
    fn a_missing_key_or_a_duplicate_is_refused() {
        let err = patch_text("{\"stack\": {}}", &["stack", "language"], &json!("go")).unwrap_err();
        assert!(err.contains("raw JSON"), "{err}");
        let dup = "{\"purpose\": {\"value\": \"mixed\", \"value\": \"library\"}}";
        assert!(patch_text(dup, &["purpose", "value"], &json!("automation")).is_err());
    }

    #[test]
    fn form_values_are_checked_against_the_fields() {
        assert!(check_value("purpose.value", &json!("nope")).is_err());
        assert!(check_value("stack.language", &json!("  ")).is_err());
        assert!(check_value("stack.testCommands", &json!([1])).is_err());
        assert!(check_value("detection.generatedAt", &json!("x")).is_err(), "not a form field");
        assert_eq!(check_value("stack.testCommands", &json!([" a ", "", "b"])).unwrap().1, json!(["a", "b"]));
    }

    #[test]
    fn invalid_json_is_never_written() {
        let root = folder("invalid");
        std::fs::write(file(&root), PROFILE).unwrap();
        for bad in ["{", "[1, 2]", "\"text\"", "{\"a\": 1,}", ""] {
            let err = write_raw_at(&root, bad, Some(PROFILE)).unwrap_err();
            assert!(err.contains("nothing was written"), "{bad}: {err}");
        }
        assert_eq!(std::fs::read_to_string(file(&root)).unwrap(), PROFILE);
        // A file that does not parse is not patched either.
        std::fs::write(file(&root), "{ broken").unwrap();
        assert!(set_at(&root, "purpose.value", &json!("library")).is_err());
        assert_eq!(std::fs::read_to_string(file(&root)).unwrap(), "{ broken");
    }

    #[test]
    fn raw_writes_verbatim_keeps_unknown_keys_and_refuses_a_stale_base() {
        let root = folder("raw");
        std::fs::write(file(&root), PROFILE).unwrap();
        let next = PROFILE.replace("\"schemaVersion\": 1", "\"schemaVersion\": 1,\n  \"mine\": [1,2]");
        let info = write_raw_at(&root, &next, Some(PROFILE)).unwrap();
        assert_eq!(info.text.as_deref(), Some(next.as_str()));
        assert_eq!(std::fs::read_to_string(file(&root)).unwrap(), next);
        let err = write_raw_at(&root, PROFILE, Some(PROFILE)).unwrap_err();
        assert!(err.contains("changed on disk"), "{err}");
        assert_eq!(std::fs::read_to_string(file(&root)).unwrap(), next);
        // A form edit keeps the keys it does not know.
        set_at(&root, "git.provider", &json!("gitea")).unwrap();
        let after = std::fs::read_to_string(file(&root)).unwrap();
        assert!(after.contains("\"mine\": [1,2]") && after.contains("\"unknownKey\": {\"keep\":   true}"));
    }

    #[test]
    fn a_missing_file_is_created_only_by_the_raw_editor_inside_cursor() {
        let root = folder("missing");
        let info = info_at(&root).unwrap();
        assert!(!info.exists && info.can_create && info.text.is_none());
        assert!(set_at(&root, "purpose.value", &json!("library")).unwrap_err().contains("does not exist"));
        write_raw_at(&root, "{}\n", None).unwrap();
        assert_eq!(std::fs::read_to_string(file(&root)).unwrap(), "{}\n");
        let bare = std::env::temp_dir().join(format!("colony-kitconfig-bare-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&bare);
        std::fs::create_dir_all(&bare).unwrap();
        assert!(!info_at(&bare).unwrap().can_create);
        assert!(write_raw_at(&bare, "{}", None).unwrap_err().contains("no .cursor folder"));
        assert!(!bare.join(REL_DIR).exists());
    }

    #[test]
    fn the_path_is_scoped_to_the_open_folder() {
        use std::os::unix::fs::symlink;
        let outside = folder("outside");
        std::fs::write(file(&outside), PROFILE).unwrap();
        // A symlinked .cursor folder.
        let root = std::env::temp_dir().join(format!("colony-kitconfig-link-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        symlink(outside.join(REL_DIR), root.join(REL_DIR)).unwrap();
        assert!(info_at(&root).is_err());
        assert!(write_raw_at(&root, "{}", Some(PROFILE)).is_err());
        assert!(set_at(&root, "purpose.value", &json!("library")).is_err());
        // A symlinked file inside a real .cursor folder.
        let root = folder("link-file");
        symlink(file(&outside), file(&root)).unwrap();
        assert!(info_at(&root).is_err());
        assert!(write_raw_at(&root, "{}", Some(PROFILE)).is_err());
        assert!(set_at(&root, "purpose.value", &json!("library")).is_err());
        assert_eq!(std::fs::read_to_string(file(&outside)).unwrap(), PROFILE, "the file outside is untouched");
        // A directory where the file should be.
        let root = folder("dir-file");
        std::fs::create_dir_all(file(&root)).unwrap();
        assert!(info_at(&root).is_err());
        // The resolved path is always <root>/.cursor/agent-kit.config.json.
        let root = folder("plain");
        let (p, dir) = resolve(&root).unwrap();
        assert!(dir && p == root.canonicalize().unwrap().join(".cursor").join("agent-kit.config.json"));
    }
}
