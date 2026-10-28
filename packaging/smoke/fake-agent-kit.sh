#!/bin/sh
# COLONY_SMOKE fixture: stands in for `agent-kit run-plan --events ndjson` and
# `agent-kit run-plan-all --events ndjson` (driver protocol 1.4.0,
# docs/driver-events-protocol.md in the kit) so the smoke can exercise a HITL gate answer,
# the per-tick review, the queue runner and the engine choice end to end without a real
# agent. run-plan: one tick that edits two files, opens gate `smoke-gate` and waits for
# one stdin line. run-plan-all: one session with a queue_state change and gate
# `smoke-queue-gate`. `engine-info --json` announces the protocol. `tick_end` / `run_end`
# carry token `usage` (1.3.0) on the paths that finish: run-plan 1500 tokens, run-plan-all
# 5700 tokens. `hitl_gate` carries the session's `usage` up to the gate (1.4.0). The fixture
# gates are not `context-checkpoint`, so the policy pre-answer never fires on them. `queue gates --json` / `--prompt` print one deferred gate in the shape of the
# kit's helper and write nothing (the driver chat panel calls them whenever the Queue view
# renders, so they must never touch the workspace).
# Use it with COLONY_AGENT_KIT_BIN=<this file> on a scratch clone only (it edits files).
set -u
cmd=${1:-}
sub=${2:-}
backend=cursor-agent max=10 cwd=. json=0 prompt=0
while [ $# -gt 0 ]; do
  case "$1" in
    --backend) backend=$2; shift ;;
    --max-ticks) max=$2; shift ;;
    --cwd) cwd=$2; shift ;;
    --on-limit) onlimit=$2; shift ;;
    --model) model=$2; shift ;;
    --events) events=$2; shift ;;
    --note) shift ;;
    --json) json=1 ;;
    --prompt) prompt=1 ;;
  esac
  shift
done
cd "$cwd" || exit 1
if [ "$cmd" = queue ]; then
  # `agent-kit queue gates` stand-in (kit commands/queue.ts, captured from the real helper on
  # a HANDOFF with one deferred-operator row). Read-only, like the real one: no file is written.
  [ "$sub" = gates ] || { echo "fixture: unknown queue subcommand ${sub:-none}" >&2; exit 1; }
  if [ "$json" = 1 ] && [ "$prompt" = 1 ]; then echo "Use either --json or --prompt, not both." >&2; exit 1; fi
  if [ "$json" = 1 ]; then
    cat <<'JSON'
{
  "ask": true,
  "reason": "deferred_gates",
  "labels": [
    "Resolve gates now",
    "Print resolution prompt",
    "Later"
  ],
  "gates": [
    {
      "plan": "colony-queue-a.plan.md",
      "gate": "Ask smoke-accept + operator dogfood of the smoke build",
      "asks": [
        "smoke-accept"
      ]
    }
  ]
}
JSON
    exit 0
  fi
  if [ "$prompt" = 1 ]; then
    printf 'agent-kit run-plan-all --backend %s\n\nRe-probe the deferred-operator rows first. Operator steps done since the last run:\n- colony-queue-a.plan.md: Ask smoke-accept + operator dogfood of the smoke build (open Asks: smoke-accept)\n' "$backend"
    exit 0
  fi
  printf 'Deferred operator gates (1):\n- colony-queue-a.plan.md: Ask smoke-accept + operator dogfood of the smoke build\n  open Asks: smoke-accept\n'
  exit 0
fi
if [ "$cmd" = commands ]; then
  # Commands catalog stand-in (kit docs/contracts/commands-catalog.schema.json): one row
  # Colony runs, the never-run production commands, a factory row whose name is
  # allowlisted, markup in a description and a name the schema refuses.
  cat <<'JSON'
{"catalogVersion":"1.0.0","kitVersion":"0.0.0-fixture","commands":[
{"name":"continue-plan","description":"Resume a plan from the last handoff and execute only the next unit.","layer":"kit","headless":true},
{"name":"git-prod","description":"Promote staging to production.","layer":"kit","headless":false},
{"name":"git-staging","description":"Bring local changes to the pre-production branch.","layer":"kit","headless":true},
{"name":"handoff","description":"Factory row with an allowlisted name.","layer":"factory","headless":false},
{"name":"kit-prod","description":"Ship the kit.","layer":"factory","headless":false},
{"name":"my-macro","description":"<img src=x onerror=alert(1)> project command","layer":"project","headless":false},
{"name":"run-plan","description":"Run the active plan until it is done or blocked.","layer":"kit","headless":true},
{"name":"../escape","description":"dropped","layer":"kit","headless":true}
]}
JSON
  exit 0
fi
if [ "$cmd" = engine-info ]; then
  printf '{"name":"@dadado/agent-kit-cli","version":"0.0.0-fixture","node":">=20","driverProtocol":"1.4.0","dashboardDataVersion":"1.0.0"}\n'
  exit 0
fi
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# Token usage (driver protocol 1.3.0) on the finishing tick_end / run_end.
tusage='{"inputTokens":1200,"cachedInputTokens":800,"outputTokens":300,"totalTokens":1500}'
qusage='{"inputTokens":5000,"cachedInputTokens":3000,"outputTokens":700,"totalTokens":5700}'
# Usage up to each fixture gate (1.4.0 hitl_gate.usage).
tgate='{"inputTokens":900,"cachedInputTokens":600,"outputTokens":200,"totalTokens":1100}'
qgate='{"inputTokens":4000,"cachedInputTokens":2500,"outputTokens":500,"totalTokens":4500}'
ev() { printf '{"v":1,"ts":"%s",%s}\n' "$(ts)" "$1"; }
if [ "$cmd" = run-plan-all ] && [ "${events:-}" = ndjson ]; then
  # Queue runner in driver mode: one session (no ticks), queue_state at start and after the
  # cursor moves, one gate answered on stdin. The HANDOFF itself is not touched.
  q0='"cursor":0,"total":2,"current":"colony-queue-a.plan.md","status":"running"'
  ev "\"type\":\"run_start\",\"protocol\":\"1.4.0\",\"command\":\"run-plan-all\",\"backend\":\"$backend\",\"plan\":null,\"pending\":null,\"maxTicks\":null,\"hitl\":\"driver\",\"queue\":{$q0}"
  ev "\"type\":\"queue_state\",$q0"
  ev "\"type\":\"log\",\"level\":\"info\",\"message\":\"fixture queue args: backend=$backend model=${model:-none}\""
  sleep 1
  ev "\"type\":\"queue_state\",\"cursor\":1,\"total\":2,\"current\":\"colony-queue-b.plan.md\",\"status\":\"running\""
  ev "\"type\":\"agent_event\",\"tick\":1,\"event\":{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Plan a is done; the queue moved to b. **Confirm** before I continue:\\n\\nHITL_GATE: smoke-queue-gate | Continue | Stop the queue\"}]}}"
  ev "\"type\":\"hitl_gate\",\"tick\":1,\"askId\":\"smoke-queue-gate\",\"labels\":[\"Continue\",\"Stop the queue\"],\"detection\":\"sentinel\",\"line\":\"HITL_GATE: smoke-queue-gate | Continue | Stop the queue\",\"usage\":$qgate"
  if ! IFS= read -r reply; then
    ev "\"type\":\"run_end\",\"exitCode\":4,\"ticks\":1,\"pending\":null,\"reason\":\"gate EOF\",\"planExhausted\":false,\"replies\":[],\"stop\":{\"askId\":\"smoke-queue-gate\",\"cause\":\"EOF\",\"message\":\"stdin closed\",\"exitCode\":4},\"usage\":null"
    exit 4
  fi
  printf '%s\n' "$reply" > queue-reply.json
  ev "\"type\":\"agent_event\",\"tick\":1,\"event\":{\"type\":\"user\",\"isReplay\":true,\"message\":{\"content\":\"HITL_REPLY: smoke-queue-gate | relayed by the fixture\"}}"
  ev "\"type\":\"run_end\",\"exitCode\":0,\"ticks\":1,\"pending\":null,\"reason\":\"session ended\",\"planExhausted\":false,\"replies\":[],\"stop\":null,\"usage\":$qusage"
  exit 0
fi
if [ "$cmd" = run-plan-all ]; then
  # Queue runner stand-in without --events (a PTY tab in Colony on an older engine): print
  # one line and leave a proof file.
  echo "fixture run-plan-all backend=$backend"
  printf 'run-plan-all backend=%s\n' "$backend" > run-plan-all-proof.txt
  exit 0
fi

ev "\"type\":\"run_start\",\"protocol\":\"1.4.0\",\"command\":\"run-plan\",\"backend\":\"$backend\",\"plan\":\"smoke-fixture.plan.md\",\"pending\":1,\"maxTicks\":$max,\"hitl\":\"driver\""
ev "\"type\":\"log\",\"level\":\"info\",\"message\":\"fixture args: backend=$backend on-limit=${onlimit:-none} model=${model:-none}\""
sleep 1
ev "\"type\":\"tick_start\",\"tick\":1,\"maxTicks\":$max,\"pending\":1,\"log\":\".cursor/loop-logs/tick-fixture.log\",\"prompt\":\"TICK_PROMPT fixture\",\"backend\":\"$backend\""
ev "\"type\":\"agent_event\",\"tick\":1,\"event\":{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Fixture tick: editing fixture-tick.txt and README.md.\"}]}}"
ev "\"type\":\"agent_event\",\"tick\":1,\"event\":{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_fixture1\",\"name\":\"Bash\",\"input\":{\"command\":\"printf 'written by the fixture tick' > fixture-tick.txt\"}}]}}"
printf 'written by the fixture tick\n' > fixture-tick.txt
ev "\"type\":\"agent_event\",\"tick\":1,\"event\":{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_fixture1\",\"content\":\"wrote fixture-tick.txt\"}]}}"
ev "\"type\":\"agent_event\",\"tick\":1,\"event\":{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Both files are written. **One decision** before I finish:\\n\\n- Ship it: keep the change\\n- Hold: stop here\\n\\nHITL_GATE: smoke-gate | Ship it | Hold\"}]}}"

printf '\nFixture tick line.\n' >> README.md
ev "\"type\":\"hitl_gate\",\"tick\":1,\"askId\":\"smoke-gate\",\"labels\":[\"Ship it\",\"Hold\"],\"detection\":\"sentinel\",\"line\":\"HITL_GATE: smoke-gate | Ship it | Hold\",\"usage\":$tgate"
if ! IFS= read -r reply; then
  ev "\"type\":\"tick_end\",\"tick\":1,\"backend\":\"$backend\",\"limit\":null,\"exitCode\":4,\"pendingBefore\":1,\"pendingAfter\":1,\"result\":null,\"replies\":[],\"stop\":{\"askId\":\"smoke-gate\",\"cause\":\"EOF\",\"message\":\"stdin closed\",\"exitCode\":4},\"usage\":null"
  ev "\"type\":\"run_end\",\"exitCode\":4,\"ticks\":1,\"pending\":1,\"reason\":\"gate EOF\",\"planExhausted\":false,\"usage\":null"
  exit 4
fi
printf '%s\n' "$reply" > gate-reply.json
esc=$(printf '%s' "$reply" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
ev "\"type\":\"log\",\"level\":\"info\",\"message\":\"fixture reply: $esc\""
ev "\"type\":\"agent_event\",\"tick\":1,\"event\":{\"type\":\"user\",\"isReplay\":true,\"message\":{\"content\":\"HITL_REPLY: smoke-gate | relayed by the fixture\"}}"
printf 'answered\n' >> fixture-tick.txt
ev "\"type\":\"tick_end\",\"tick\":1,\"backend\":\"$backend\",\"limit\":null,\"exitCode\":0,\"pendingBefore\":1,\"pendingAfter\":0,\"result\":{\"kind\":\"done\",\"line\":\"LOOP_TICK_RESULT: done\"},\"replies\":[],\"stop\":null,\"usage\":$tusage"
ev "\"type\":\"run_end\",\"exitCode\":0,\"ticks\":1,\"pending\":0,\"reason\":\"plan done\",\"planExhausted\":true,\"usage\":$tusage"
