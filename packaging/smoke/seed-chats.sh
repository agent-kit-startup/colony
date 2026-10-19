#!/bin/sh
# COLONY_SMOKE fixture: seeds the saved chats of the folder given as $1 (Claude Code's
# ~/.claude/projects/<folder with every non-alphanumeric character as ->/) with the three
# sessions of ./chats (a named one, one with only Claude Code's title, an untitled one)
# and a subagent transcript, newest first in that order. Runs only in the fixture smoke
# (COLONY_CLAUDE_BIN is fake-claude.sh), so a real ~/.claude is never touched.
set -eu
case "${COLONY_CLAUDE_BIN:-}" in
  */fake-claude.sh) ;;
  *) echo "seed-chats: not a fixture smoke (COLONY_CLAUDE_BIN is not fake-claude.sh)" >&2; exit 2 ;;
esac
src=$(cd "$(dirname "$0")/chats" && pwd -P)
slug=$(cd "$1" && pwd -P | sed 's/[^A-Za-z0-9]/-/g')
dst="$HOME/.claude/projects/$slug"
mkdir -p "$dst"
cp -R "$src"/. "$dst"/
now=$(date +%s)
age=60
for id in 5e0b2c1a-7d4f-4a3b-9c2e-1f6a8b0d3c41 6f1c3d2b-8e5a-4b4c-8d3f-2a7b9c1e4d52 7a2d4e3c-9f6b-4c5d-9e4a-3b8c0d2f5e63; do
  touch -d "@$((now - age))" "$dst/$id.jsonl"
  age=$((age * 60))
done
echo "seeded $dst"
