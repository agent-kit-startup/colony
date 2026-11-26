#!/bin/sh
# COLONY_SMOKE fixture for the Explorer git workbench steps (src/worksmoke.ts; plan
# colony-explorer-git-workbench x8). Run by the smoke from a terminal tab in the scratch
# workspace, after every other git step, so the history it adds never meets them:
#   graph     a side branch merged with --no-ff (the commit graph draws a merge)
#   conflict  two files changed on both sides, then a merge that stops on them (the
#             shape of the operator's dogfood repo: one changed line per file, so the kit
#             reads the merge base of both from the index)
#   commit    the merge commit, once the window has staged every resolved file
#   theme     switch the Omarchy theme under $HOME to the stock theme named in
#             COLONY_SMOKE_THEME_SWITCH (a skip without it, so a real HOME is never touched)
#   theme-restore  put the theme back as it was before `theme`
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
    printf 'name = colony\nport = 8080\nlog = info\n' > smoke-merge/app.conf
    printf 'export const mode = "dev";\nexport const retries = 3;\n' > smoke-merge/config.ts
    commit_dir smoke-merge "feat: conflict base (Colony smoke)"
    $G checkout -q -b smoke/conflict-theirs
    printf 'name = colony\nport = 9090\nlog = info\n' > smoke-merge/app.conf
    printf 'export const mode = "prod";\nexport const retries = 3;\n' > smoke-merge/config.ts
    commit_dir smoke-merge "feat: conflict theirs (Colony smoke)"
    $G checkout -q "$here"
    printf 'name = colony\nport = 8081\nlog = info\n' > smoke-merge/app.conf
    printf 'export const mode = "staging";\nexport const retries = 3;\n' > smoke-merge/config.ts
    commit_dir smoke-merge "feat: conflict ours (Colony smoke)"
    if $G merge -q --no-edit smoke/conflict-theirs; then echo "fixture: the merge did not conflict" >&2; exit 1; fi
    git ls-files -u | cut -f2 | sort -u
    ;;
  commit)
    [ -z "$(git ls-files -u)" ] || { echo "fixture: unmerged paths remain" >&2; exit 1; }
    $G commit -q --no-edit
    $G log --oneline -1
    ;;
  theme)
    [ -n "${COLONY_SMOKE_THEME_SWITCH:-}" ] || { echo "skip: COLONY_SMOKE_THEME_SWITCH is not set"; exit 0; }
    cur="$HOME/.local/state/omarchy/current"
    src="/usr/share/omarchy/themes/$COLONY_SMOKE_THEME_SWITCH/colors.toml"
    [ -f "$cur/theme/colors.toml" ] && [ -f "$src" ] || { echo "fixture: no Omarchy theme to switch" >&2; exit 1; }
    [ -f "$cur/theme/colors.toml.smoke-orig" ] || cp "$cur/theme/colors.toml" "$cur/theme/colors.toml.smoke-orig"
    [ -f "$cur/theme.name.smoke-orig" ] || cp "$cur/theme.name" "$cur/theme.name.smoke-orig" 2>/dev/null || true
    cp "$src" "$cur/theme/colors.toml.new" && mv "$cur/theme/colors.toml.new" "$cur/theme/colors.toml"
    printf '%s\n' "$COLONY_SMOKE_THEME_SWITCH" > "$cur/theme.name"
    echo "switched to $COLONY_SMOKE_THEME_SWITCH"
    ;;
  theme-restore)
    cur="$HOME/.local/state/omarchy/current"
    [ -f "$cur/theme/colors.toml.smoke-orig" ] || { echo "skip: nothing to restore"; exit 0; }
    mv "$cur/theme/colors.toml.smoke-orig" "$cur/theme/colors.toml"
    [ ! -f "$cur/theme.name.smoke-orig" ] || mv "$cur/theme.name.smoke-orig" "$cur/theme.name"
    echo restored
    ;;
  *)
    echo "usage: workbench-fixture.sh graph|conflict|commit|theme|theme-restore" >&2
    exit 64
    ;;
esac
