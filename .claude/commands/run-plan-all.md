---
description: Orchestrate multiple plans as an ordered queue, then ship one release per completed plan.
disable-model-invocation: true
---

Read `.cursor/commands/run-plan-all.md` now and follow that contract exactly — it is the source of truth for /run-plan-all; this file is only a thin adapter for Claude Code.

Adapter rules (Claude Code CLI):
- Cursor "Ask questions" is unavailable here: use AskUserQuestion when possible, else print one line `HITL_GATE: <ask-id> | <label 1> | <label 2> | ...` immediately followed by the same labels as one numbered list, one list per message, and WAIT for the answer (ask-id and labels: `.cursor/skills/core/hitl-gates/SKILL.md`). A headless reply arrives as `HITL_REPLY: <ask-id> | operator reply <n> | <label>`; cite that line as the Ask provenance.
- Skip or cancel means stop.
- Never `/git-prod` without an explicit operator yes.
- Do not clone Cursor hooks or invent behavior beyond the SoT file.
