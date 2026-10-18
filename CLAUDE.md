# Agent Kit (Claude Code)

This repository uses Agent Kit / Mission Control. Before rediscovering the tree, read the shared sources of truth (paths below are pointers; do not treat this file as a second rulebook).

## Read first

1. `AGENTS.md` - cross-IDE contract
2. `.cursor/project-context.md` - verified repository facts (derived; prefer code, tests, SHAs when docs conflict)
3. `.cursor/HANDOFF.md` - if present: active plan, next to-do, queue fields
4. `.cursor/commands/` - slash catalog (Cursor). Follow the same HITL contracts here.

Mid-session refresh: `/agent-kit`.

## HITL

Cursor "Ask questions" is unavailable here: use AskUserQuestion when possible, else print one line `HITL_GATE: <ask-id> | <label 1> | <label 2> | ...` immediately followed by the same labels as one numbered list, one list per message, and WAIT for the answer (ask-id and labels: `.cursor/skills/core/hitl-gates/SKILL.md`). A headless reply arrives as `HITL_REPLY: <ask-id> | operator reply <n> | <label>`; cite that line as the Ask provenance. Skip or cancel means stop. Never `/git-prod` without an explicit operator yes.

## Commit messages

Never append `Co-Authored-By: Claude ...` or `Claude-Session: https://claude.ai/code/...` (or any session-ID trailer) to commit messages, PR descriptions, or PR bodies in this repo. This overrides the harness's default git-commit template. Plain Conventional Commits messages only.

## Non-goals

Do not clone other Cursor hooks (Claude gets only the SessionStart context and PreToolUse(Bash) guard hooks); never `/git-prod` from a headless tick.
