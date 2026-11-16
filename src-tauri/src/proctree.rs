//! The engine process tree (kit ADR 2026-10-19_colony-managed-engine-distribution, amend
//! 2026-11-16 point 7): closing Colony ends every engine and agent process it started and
//! keeps the state on disk. Each engine driver starts in its own process group; on exit
//! Colony sends SIGTERM to the group and to every descendant, waits a short grace period so
//! the current write can finish, then sends SIGKILL to whatever is left.
//!
//! The descendants are read from `/proc` on Linux, so an agent tool subprocess that left the
//! group (`setsid`, a detached spawn) is still reached while its parent lives. Elsewhere only
//! the group is signalled. Colony never signals pid or group 0 or 1, nor its own pid or group.

use std::time::Duration;

/// Grace between SIGTERM and SIGKILL when Colony ends a tree.
pub const GRACE: Duration = Duration::from_secs(3);

/// Start the spawned process in its own process group (group id = its pid), so the agent CLI
/// and its tool subprocesses can be signalled as one unit.
pub fn own_group(cmd: &mut std::process::Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(not(unix))]
    let _ = cmd;
}

/// One process, identified by pid and start time so a reused pid is never signalled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Proc {
    pid: i32,
    start: u64,
}

/// `/proc/<pid>/stat`: (ppid, pgrp, state, start time in clock ticks).
#[cfg(target_os = "linux")]
fn stat(pid: i32) -> Option<(i32, i32, char, u64)> {
    let s = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name (field 2) is in parentheses and may hold spaces: split after it.
    let rest = s.get(s.rfind(')')? + 2..)?;
    let f: Vec<&str> = rest.split_whitespace().collect();
    // rest starts at field 3 (state): ppid is field 4, pgrp 5, starttime 22.
    Some((f.get(1)?.parse().ok()?, f.get(2)?.parse().ok()?, f.first()?.chars().next()?, f.get(19)?.parse().ok()?))
}

/// The root, its descendants, and every other member of the root's group.
#[cfg(target_os = "linux")]
fn members(root: i32) -> Vec<Proc> {
    let mut table: Vec<(i32, i32, i32, u64)> = Vec::new();
    if let Ok(dir) = std::fs::read_dir("/proc") {
        for e in dir.flatten() {
            let Some(pid) = e.file_name().to_str().and_then(|n| n.parse::<i32>().ok()) else { continue };
            if let Some((ppid, pgrp, _, start)) = stat(pid) {
                table.push((pid, ppid, pgrp, start));
            }
        }
    }
    let mut out: Vec<Proc> = Vec::new();
    let mut frontier = vec![root];
    if let Some(&(_, _, _, start)) = table.iter().find(|t| t.0 == root) {
        out.push(Proc { pid: root, start });
    }
    while let Some(parent) = frontier.pop() {
        for &(pid, ppid, _, start) in &table {
            if ppid == parent && !out.iter().any(|p| p.pid == pid) {
                out.push(Proc { pid, start });
                frontier.push(pid);
            }
        }
    }
    for &(pid, _, pgrp, start) in &table {
        if pgrp == root && !out.iter().any(|p| p.pid == pid) {
            out.push(Proc { pid, start });
        }
    }
    out
}

#[cfg(all(unix, not(target_os = "linux")))]
fn members(_root: i32) -> Vec<Proc> {
    Vec::new()
}

/// Still running: same start time, and not a zombie waiting to be reaped.
#[cfg(target_os = "linux")]
fn alive(p: Proc) -> bool {
    matches!(stat(p.pid), Some((_, _, state, start)) if start == p.start && state != 'Z' && state != 'X')
}

#[cfg(all(unix, not(target_os = "linux")))]
fn alive(_p: Proc) -> bool {
    false
}

/// The process start time (clock ticks since boot) of `pid`, recorded at spawn so a root
/// whose pid was reused later is never signalled. `None` off Linux or when it is gone.
pub fn start_of(pid: i32) -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        stat(pid).map(|s| s.3)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        None
    }
}

/// A root recorded at spawn is still the same process (or its group outlived it). A live
/// process at that pid with another start time means the pid was reused, and since Linux
/// never hands out a pid that still names a process group, the old group is gone too: skip.
fn same_root(pid: i32, start: Option<u64>) -> bool {
    match (start, start_of(pid)) {
        (Some(recorded), Some(now)) => recorded == now,
        _ => true,
    }
}

/// A group Colony may signal: never 0 or 1, never Colony's own pid or group.
pub fn safe_root(root: i32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: getpid and getpgrp have no preconditions.
        let (me, my_group) = unsafe { (libc::getpid(), libc::getpgrp()) };
        root > 1 && root != me && root != my_group
    }
    #[cfg(not(unix))]
    {
        let _ = root;
        false
    }
}

/// Some member of the group still exists (a zombie leader counts until it is reaped).
#[cfg(unix)]
fn group_exists(pgid: i32) -> bool {
    // SAFETY: signal 0 only checks for existence.
    unsafe { libc::killpg(pgid, 0) == 0 }
}

/// End the trees rooted at `roots` (engine pids started with [`own_group`], each with the
/// start time recorded at spawn, or `None` when it is read now): SIGTERM to each group and
/// each descendant, up to `grace` for them to exit (`reap` is called on every poll so Colony
/// collects its own exited children), then SIGKILL to what is left. Roots that fail
/// [`safe_root`], or whose pid now belongs to another process, are skipped. Returns the pids
/// still alive after the SIGKILL (empty when the whole tree is gone).
pub fn end_trees(roots: &[(i32, Option<u64>)], grace: Duration, mut reap: impl FnMut()) -> Vec<i32> {
    #[cfg(unix)]
    {
        use std::time::Instant;
        let roots: Vec<i32> = roots.iter().filter(|(r, start)| safe_root(*r) && same_root(*r, *start)).map(|(r, _)| *r).collect();
        if roots.is_empty() {
            return Vec::new();
        }
        let mut targets: Vec<Proc> = roots.iter().flat_map(|r| members(*r)).collect();
        targets.sort_by_key(|p| p.pid);
        targets.dedup();
        let signal = |sig: i32, targets: &[Proc]| {
            for r in &roots {
                // SAFETY: plain syscalls on a vetted group id.
                unsafe { libc::killpg(*r, sig) };
            }
            for p in targets {
                if p.pid > 1 && alive(*p) {
                    // SAFETY: pid checked against its start time just above.
                    unsafe { libc::kill(p.pid, sig) };
                }
            }
        };
        signal(libc::SIGTERM, &targets);
        let deadline = Instant::now() + grace;
        loop {
            reap();
            let left = targets.iter().any(|p| alive(*p));
            let groups = roots.iter().any(|r| group_exists(*r));
            if !left && !groups || Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // A descendant may have forked during the grace period: read the tree again.
        let late: Vec<Proc> = roots.iter().flat_map(|r| members(*r)).filter(|p| !targets.contains(p)).collect();
        targets.extend(late);
        signal(libc::SIGKILL, &targets);
        for _ in 0..20 {
            reap();
            if !targets.iter().any(|p| alive(*p)) {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        targets.iter().filter(|p| alive(**p)).map(|p| p.pid).collect()
    }
    #[cfg(not(unix))]
    {
        let _ = (roots, grace, &mut reap);
        Vec::new()
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::Instant;

    /// Read `n` pids the stub prints on stdout, one per line.
    fn read_pids(child: &mut std::process::Child, n: usize) -> Vec<i32> {
        use std::io::{BufRead, BufReader};
        let out = child.stdout.take().unwrap();
        let mut lines = BufReader::new(out).lines();
        (0..n).map(|_| lines.next().unwrap().unwrap().trim().parse().unwrap()).collect()
    }

    fn running(pid: i32) -> bool {
        matches!(stat(pid), Some((_, _, s, _)) if s != 'Z' && s != 'X')
    }

    /// A stub engine with a child in its group and one that left it (setsid), the shape of an
    /// agent CLI whose tool subprocess detached: both are gone after `end_trees`.
    #[test]
    fn ends_the_group_and_a_detached_descendant() {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg("sleep 300 & echo $!; setsid sleep 300 & echo $!; wait").stdout(Stdio::piped());
        own_group(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        let root = child.id() as i32;
        let pids = read_pids(&mut child, 2);
        // `$!` is printed at fork time, before the child runs setsid: wait for it.
        let left_group = (0..100).any(|_| {
            std::thread::sleep(Duration::from_millis(20));
            stat(pids[1]).is_some_and(|s| s.1 != root)
        });
        assert!(left_group, "the setsid child left the group");
        assert!(pids.iter().all(|p| running(*p)));
        let started = Instant::now();
        let left = end_trees(&[(root, start_of(root))], Duration::from_secs(3), || {
            let _ = child.try_wait();
        });
        assert!(left.is_empty(), "survivors: {left:?}");
        let _ = child.wait();
        for p in pids {
            assert!(!running(p), "pid {p} survived");
        }
        // sleep exits on SIGTERM: no need to wait for the grace period.
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    /// A process that ignores SIGTERM is killed with SIGKILL once the grace period is over.
    #[test]
    fn escalates_to_sigkill_after_the_grace_period() {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg("trap '' TERM; sleep 300 & echo $!; wait").stdout(Stdio::piped());
        own_group(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        let root = child.id() as i32;
        let pids = read_pids(&mut child, 1);
        let started = Instant::now();
        let left = end_trees(&[(root, None)], Duration::from_millis(400), || {
            let _ = child.try_wait();
        });
        assert!(left.is_empty(), "survivors: {left:?}");
        assert!(started.elapsed() >= Duration::from_millis(400));
        let _ = child.wait();
        assert!(!running(pids[0]));
    }

    /// Never 0, 1, Colony's own pid or its own group: those calls signal nothing.
    #[test]
    fn refuses_unsafe_roots() {
        let me = std::process::id() as i32;
        // SAFETY: no preconditions.
        let group = unsafe { libc::getpgrp() };
        for r in [-1, 0, 1, me, group] {
            assert!(!safe_root(r), "{r}");
        }
        assert!(end_trees(&[(0, None), (1, None), (me, None), (group, None)], Duration::from_millis(10), || {}).is_empty());
        // Still here: nothing was signalled.
        assert!(running(me));
    }

    /// A run that ended long ago keeps its pid in the registry: when that pid now names
    /// another process (another start time), nothing is signalled.
    #[test]
    fn skips_a_root_whose_pid_was_reused() {
        let mut cmd = Command::new("sleep");
        cmd.arg("300");
        own_group(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        let pid = child.id() as i32;
        let real = start_of(pid).unwrap();
        let left = end_trees(&[(pid, Some(real + 1))], Duration::from_millis(200), || {});
        assert!(left.is_empty());
        assert!(running(pid), "a reused pid must not be signalled");
        assert!(end_trees(&[(pid, Some(real))], Duration::from_secs(3), || {
            let _ = child.try_wait();
        })
        .is_empty());
        let _ = child.wait();
        assert!(!running(pid));
    }

    #[test]
    fn stat_reads_ppid_group_and_start() {
        let me = std::process::id() as i32;
        let (ppid, pgrp, state, start) = stat(me).unwrap();
        assert!(ppid > 0 && pgrp > 0 && start > 0 && state != 'Z');
        // SAFETY: no preconditions.
        assert_eq!(pgrp, unsafe { libc::getpgrp() });
    }
}
