#!/bin/sh
# COLONY_SMOKE fixture: stands in for the interactive vendor CLI (`claude`). Use it with
# COLONY_CLAUDE_BIN=<this file>. Records its arguments and working folder next to the
# opened folder's README.md, says it is ready, then waits like an interactive session
# until Colony closes the tab. It reads no credentials and starts no agent.
printf 'args: %s\ncwd: %s\n' "$*" "$(pwd -P)" > interactive-proof.txt
echo "fake claude ready"
while IFS= read -r line; do echo "fake claude got: $line"; done
