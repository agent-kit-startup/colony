#!/bin/sh
# COLONY_SMOKE fixture: stands in for $EDITOR. Records the path it was asked to open
# next to that path, so the smoke can check "Open in my editor" without a real editor.
printf 'opened %s\n' "$1" > "$(dirname "$1")/editor-proof.txt"
