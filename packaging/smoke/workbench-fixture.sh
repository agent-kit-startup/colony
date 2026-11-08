#!/bin/sh
# COLONY_SMOKE fixture for the Explorer git workbench steps (src/worksmoke.ts; plan
# colony-explorer-git-workbench x8). Run by the smoke from a terminal tab in the scratch
# workspace, after every other git step, so the history it adds never meets them:
#   graph     a side branch merged with --no-ff (the commit graph draws a merge)
#   conflict  two files changed on both sides, then a merge that stops on them
#   commit    the merge commit, once the window has staged every resolved file
# Commits name only their own paths, and the merges refuse a staged index, so the other
# steps' leftovers (an edited README, untracked proofs) stay out of every commit.
# Use it on a scratch clone only.
set -eu
G="git -c user.name=smoke -c user.email=smoke@example.invalid -c commit.gpgsign=false -c merge.conflictStyle=merge -c rerere.enabled=false"
here=$($G symbolic-ref --short HEAD)
clean_index() { git diff --cached --quiet || { echo "fixture: the index has staged changes" >&2; exit 1; }; }
commit_dir() { $G add -- "$1" && $G commit -q -m "$2" -- "$1"; }

case "${1:-}" in
  graph)
    clean_index
    mkdir -p smoke-graph
    $G checkout -q -b smoke/graph-feature
    printf 'one\n' > smoke-graph/feature.txt
    commit_dir smoke-graph "feat: graph feature side (Colony smoke)"
    $G checkout -q "$here"
    mkdir -p smoke-graph
    printf 'main side\n' > smoke-graph/main.txt
    commit_dir smoke-graph "feat: graph main side (Colony smoke)"
    $G merge -q --no-ff -m "Merge branch 'smoke/graph-feature' (Colony smoke)" smoke/graph-feature
    $G log --oneline -3
    ;;
  conflict)
    clean_index
    mkdir -p smoke-merge
    printf 'name = colony\nport = 8080\n\nmode = dev\nlevel = 1\n' > smoke-merge/app.conf
    printf 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n' > smoke-merge/config.ts
    commit_dir smoke-merge "feat: conflict base (Colony smoke)"
    $G checkout -q -b smoke/conflict-theirs
    printf 'name = colony\nport = 9090\n\nmode = prod\nlevel = 1\n' > smoke-merge/app.conf
    printf 'export const a = 1;\nexport const b = 20;\nexport const c = 3;\n' > smoke-merge/config.ts
    commit_dir smoke-merge "feat: conflict theirs (Colony smoke)"
    $G checkout -q "$here"
    printf 'name = colony\nport = 7070\n\nmode = test\nlevel = 1\n' > smoke-merge/app.conf
    printf 'export const a = 1;\nexport const b = 200;\nexport const c = 3;\n' > smoke-merge/config.ts
    commit_dir smoke-merge "feat: conflict ours (Colony smoke)"
    if $G merge -q --no-edit smoke/conflict-theirs; then echo "fixture: the merge did not conflict" >&2; exit 1; fi
    git ls-files -u | cut -f2 | sort -u
    ;;
  commit)
    [ -z "$(git ls-files -u)" ] || { echo "fixture: unmerged paths remain" >&2; exit 1; }
    $G commit -q --no-edit
    $G log --oneline -1
    ;;
  *)
    echo "usage: workbench-fixture.sh graph|conflict|commit" >&2
    exit 64
    ;;
esac
