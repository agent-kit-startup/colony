//! Raise this window through Hyprland when another launch hands it a request (the bar
//! widget, the Omarchy menu, the desktop entry, a terminal `colony`).
//!
//! `show()` / `set_focus()` end in GTK's `present()`, which on Wayland asks the compositor
//! through xdg-activation with a token GTK mints for itself. Whether that request lands is
//! up to the compositor and is invisible from here, and the bar click reported in dogfood
//! (colony-ui-dogfood-fixes u7) left the window where it was. So on Hyprland Colony also
//! asks the compositor directly, the way Omarchy's own `omarchy-launch-or-focus` does: find
//! this process's window in `hyprctl -j clients`, then `hyprctl dispatch` a focus on its
//! address (the Lua-config form first, the classic `focuswindow` second). Focusing a window
//! on another workspace switches to that workspace. Best effort: a failure is one stderr
//! line, and the GTK path still ran.

use std::process::{Command, Stdio};
use std::time::Duration;

/// The address of this process's mapped window in `hyprctl -j clients` output. Each entry
/// is read on its own, so one client of an odd shape does not hide Colony's.
pub fn client_address(clients_json: &str, pid: u32) -> Option<String> {
    let clients: Vec<serde_json::Value> = serde_json::from_str(clients_json).ok()?;
    clients.iter().find_map(|c| {
        let address = c.get("address")?.as_str()?;
        let mapped = c.get("mapped").and_then(|m| m.as_bool()).unwrap_or(true);
        (c.get("pid")?.as_i64()? == i64::from(pid) && mapped && valid_address(address)).then(|| address.to_string())
    })
}

/// `0x` and hex digits only: the address goes into a dispatch line (and a Lua string).
fn valid_address(a: &str) -> bool {
    a.len() > 2 && a.starts_with("0x") && a[2..].chars().all(|c| c.is_ascii_hexdigit())
}

/// The `hyprctl` argument lists that focus `address`, newest syntax first: the Lua config
/// dispatcher (Hyprland 0.55+ with `hyprland.lua`), then the classic `focuswindow`.
pub fn focus_commands(address: &str) -> [Vec<String>; 2] {
    [
        vec!["dispatch".into(), format!("hl.dsp.focus({{ window = \"address:{address}\" }})")],
        vec!["dispatch".into(), "focuswindow".into(), format!("address:{address}")],
    ]
}

/// `hyprctl dispatch` answers `ok` when Hyprland took the dispatch; under a Lua config it
/// answers what `hl.dispatch(...)` returned, `ok` first (Hyprland 0.56 HyprCtl.cpp
/// `dispatchRequest`). Taken is not focused: Hyprland may still refuse the focus itself
/// (an exclusive layer surface such as the Omarchy menu holding the keyboard).
pub fn dispatch_ok(reply: &str) -> bool {
    reply.trim_start().starts_with("ok")
}

/// Focus the window of `pid`. `hyprctl(args)` runs the tool and returns its stdout, or
/// `None` when it could not run or exited non-zero (injected so tests run nothing).
pub fn raise_pid<F: FnMut(&[String]) -> Option<String>>(pid: u32, mut hyprctl: F) -> Result<(), String> {
    let address = window_address(pid, &mut hyprctl, Duration::from_millis(100))?;
    let mut last = String::new();
    for args in focus_commands(&address) {
        match hyprctl(&args) {
            Some(reply) if dispatch_ok(&reply) => return Ok(()),
            Some(reply) => last = format!("hyprctl {}: {}", args.join(" "), reply.trim()),
            None => last = format!("hyprctl {} failed", args.join(" ")),
        }
    }
    Err(last)
}

/// This process's window address; a window that `show()` is still mapping gets a few
/// more looks, `pause` apart.
fn window_address<F: FnMut(&[String]) -> Option<String>>(pid: u32, hyprctl: &mut F, pause: Duration) -> Result<String, String> {
    const LOOKS: usize = 5;
    for look in 1..=LOOKS {
        let clients = hyprctl(&["-j".to_string(), "clients".to_string()]).ok_or("hyprctl clients did not answer")?;
        if let Some(a) = client_address(&clients, pid) {
            return Ok(a);
        }
        if look < LOOKS {
            std::thread::sleep(pause);
        }
    }
    Err(format!("no mapped window of pid {pid} in hyprctl clients"))
}

fn run_hyprctl(args: &[String]) -> Option<String> {
    let out = Command::new("hyprctl").args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// On Hyprland, focus this process's window from a background thread; elsewhere nothing.
pub fn raise_self() {
    if crate::tiling_wm().as_deref() != Some("Hyprland") {
        return;
    }
    let pid = std::process::id();
    std::thread::spawn(move || {
        if let Err(e) = raise_pid(pid, run_hyprctl) {
            eprintln!("colony: could not raise the window through Hyprland ({e})");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // Trimmed from a real `hyprctl -j clients` (Hyprland 0.56.2): Colony's window and others.
    const CLIENTS: &str = r#"[
      {"address":"0x55b0aeaef590","mapped":true,"hidden":false,"workspace":{"id":1,"name":"1"},"class":"google-chrome","pid":4121214},
      {"address":"0x55b0aebe9dd0","mapped":true,"hidden":false,"workspace":{"id":2,"name":"2"},"class":"colony","pid":1815010}
    ]"#;

    #[test]
    fn finds_the_window_of_this_pid_only() {
        assert_eq!(client_address(CLIENTS, 1815010).as_deref(), Some("0x55b0aebe9dd0"));
        assert_eq!(client_address(CLIENTS, 42), None);
        assert_eq!(client_address("not json", 1815010), None);
        // An unmapped window, or an address that is not plain hex, is never dispatched to.
        assert_eq!(client_address(r#"[{"address":"0xabc","mapped":false,"pid":7}]"#, 7), None);
        assert_eq!(client_address(r#"[{"address":"0xabc\" }) os.exit() --","pid":7}]"#, 7), None);
        assert_eq!(client_address(r#"[{"address":"0xabc","pid":7}]"#, 7).as_deref(), Some("0xabc"));
        // Another client of an odd shape does not hide ours.
        assert_eq!(client_address(r#"[{"address":null,"pid":null},{"address":"0xabc","pid":7}]"#, 7).as_deref(), Some("0xabc"));
    }

    #[test]
    fn focus_commands_match_omarchy_launch_or_focus() {
        let [lua, classic] = focus_commands("0x55b0aebe9dd0");
        assert_eq!(lua, vec!["dispatch", r#"hl.dsp.focus({ window = "address:0x55b0aebe9dd0" })"#]);
        assert_eq!(classic, vec!["dispatch", "focuswindow", "address:0x55b0aebe9dd0"]);
        assert!(dispatch_ok("ok\n"));
        assert!(dispatch_ok("ok (lua)"));
        assert!(!dispatch_ok("Invalid dispatcher"));
    }

    #[test]
    fn raise_tries_the_lua_form_then_the_classic_one() {
        // Lua form taken: one dispatch.
        let mut ran = Vec::new();
        let r = raise_pid(1815010, |a| {
            ran.push(a.join(" "));
            Some(if a[0] == "-j" { CLIENTS.into() } else { "ok".into() })
        });
        assert_eq!(r, Ok(()));
        assert_eq!(ran, vec!["-j clients".to_string(), r#"dispatch hl.dsp.focus({ window = "address:0x55b0aebe9dd0" })"#.into()]);

        // Lua form refused (a hyprlang config): the classic dispatcher focuses.
        let mut ran = Vec::new();
        let r = raise_pid(1815010, |a| {
            ran.push(a.join(" "));
            match a[0].as_str() {
                "-j" => Some(CLIENTS.into()),
                _ if a[1] == "focuswindow" => Some("ok".into()),
                _ => None,
            }
        });
        assert_eq!(r, Ok(()));
        assert_eq!(ran.last().unwrap(), "dispatch focuswindow address:0x55b0aebe9dd0");

        // Both refused, or no window of ours: an error to log, nothing else.
        assert!(raise_pid(1815010, |a| if a[0] == "-j" { Some(CLIENTS.into()) } else { Some("Invalid dispatcher".into()) }).unwrap_err().contains("Invalid dispatcher"));
        let mut dispatched = false;
        assert!(raise_pid(42, |a| {
            dispatched |= a[0] == "dispatch";
            Some(CLIENTS.into())
        })
        .is_err());
        assert!(!dispatched);
        assert!(raise_pid(1815010, |_| None).is_err());
    }

    #[test]
    fn a_window_still_mapping_gets_a_few_more_looks() {
        let mut looks = 0;
        let mut hyprctl = |_: &[String]| {
            looks += 1;
            Some(if looks < 3 { "[]".to_string() } else { CLIENTS.to_string() })
        };
        assert_eq!(window_address(1815010, &mut hyprctl, Duration::ZERO).as_deref(), Ok("0x55b0aebe9dd0"));
        let mut looks = 0;
        let mut never = |_: &[String]| {
            looks += 1;
            Some("[]".to_string())
        };
        assert!(window_address(1815010, &mut never, Duration::ZERO).is_err());
        assert_eq!(looks, 5);
    }
}
