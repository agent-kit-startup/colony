#!/bin/sh
# COLONY_SMOKE runner check for the process-tree-armed step (kit ADR 2026-10-19 amend
# 2026-11-16 point 7): run it after Colony has exited. It reads the pids the fixture's
# `run-plan --model smoke-tree` run wrote to <folder>/.git/colony-tree-pids (fixture, agent
# child, detached subprocess) and exits 1 when any of them is still alive, 2 when the file
# is missing or malformed, 0 when the whole tree is gone.
set -u
folder=${1:?usage: check-process-tree.sh <smoke folder>}
file="$folder/.git/colony-tree-pids"
[ -r "$file" ] || { echo "process-tree: no $file (did the process-tree-armed step run?)" >&2; exit 2; }
pids=$(cat "$file")
case "$pids" in
  *[!0-9\ ]*|"") echo "process-tree: malformed $file: $pids" >&2; exit 2 ;;
esac
alive=""
for p in $pids; do
  # A zombie waiting for its parent to reap it is not running.
  state=$(awk '{ sub(/^.*\) /, ""); print $1 }' "/proc/$p/stat" 2>/dev/null || true)
  if [ -n "$state" ] && [ "$state" != Z ] && [ "$state" != X ]; then alive="$alive $p"; fi
done
if [ -n "$alive" ]; then
  echo "process-tree: FAIL, still alive after Colony exited:$alive" >&2
  ps -o pid,ppid,pgid,sid,etime,args -p "$(echo $alive | tr ' ' ',')" >&2 || true
  exit 1
fi
echo "process-tree: ok, none of $pids is alive"
