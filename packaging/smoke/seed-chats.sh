#!/bin/sh
# COLONY_SMOKE fixture: seeds the saved chats of the folder given as $1 (Claude Code's
# ~/.claude/projects/<folder with every non-alphanumeric character as ->/) with the three
# sessions of ./chats (a named one, one with only Claude Code's title, an untitled one)
# and a subagent transcript, newest first in that order. Runs only in the fixture smoke
# (COLONY_CLAUDE_BIN is fake-claude.sh) with a scratch HOME (not the account's home
# folder), so a real ~/.claude is never touched. The folder must be a printable ASCII path
# of at most 200 characters: the sed below is Claude Code's folder name only for those.
set -eu
case "${COLONY_CLAUDE_BIN:-}" in
  */fake-claude.sh) ;;
  *) echo "seed-chats: not a fixture smoke (COLONY_CLAUDE_BIN is not fake-claude.sh)" >&2; exit 2 ;;
esac
user=$(id -un)
eval "real=~$user"
if [ "$(cd "$HOME" && pwd -P)" = "$(cd "$real" && pwd -P)" ]; then
  echo "seed-chats: HOME is $user's real home folder; point HOME at a scratch folder" >&2
  exit 2
fi
src=$(cd "$(dirname "$0")/chats" && pwd -P)
folder=$(cd "$1" && pwd -P)
if printf '%s' "$folder" | LC_ALL=C grep -q '[^ -~]' || [ ${#folder} -gt 200 ]; then
  echo "seed-chats: $folder is not a printable ASCII path of at most 200 characters" >&2
  exit 2
fi
slug=$(printf '%s' "$folder" | LC_ALL=C sed 's/[^A-Za-z0-9]/-/g')
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
