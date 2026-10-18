---
description: Load Agent Kit session context (HANDOFF, project-context, commands). Manual refresh only.
disable-model-invocation: true
---

Read these files if they exist. Prefer a one-shot ASCII Mission Control snapshot over a plain HANDOFF paraphrase.

1. Run `agent-kit mission-control --once` (or `npx @dadado/agent-kit-cli mission-control --once`) in the project root and paste the stdout frame as the snapshot. Do not start a live loop: Claude Code cannot sustain one across turns.
2. If that command is missing or fails, fall back to reading:
   - `AGENTS.md`
   - `.cursor/project-context.md`
   - `.cursor/HANDOFF.md`
   - The plan file named in HANDOFF `- **Plan:**` under `.cursor/plans/`

If HANDOFF is missing, say so and point at `/agent-kit-onboard` or `/start-project` rather than inventing a plan.

HITL: numbered-list fallback for Ask questions labels. Never `/git-prod` from this skill.

Non-goals: not audits / `/plan-external-review`, not a second tick dialect, not Cursor hook clones beyond the SessionStart and PreToolUse(Bash) adapters, not a continuous TUI loop.
