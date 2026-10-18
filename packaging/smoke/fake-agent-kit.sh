#!/bin/sh
# COLONY_SMOKE fixture: stands in for `agent-kit run-plan --events ndjson` (driver
# protocol 1.1.0, docs/driver-events-protocol.md in the kit) so the smoke can exercise a
# HITL gate answer, the per-tick review and the engine choice end to end without a real
# agent. One tick: edit two files, open gate `smoke-gate`, wait for one stdin line.
# Use it with COLONY_AGENT_KIT_BIN=<this file> on a scratch clone only (it edits files).
set -u
backend=cursor-agent max=10 cwd=.
while [ $# -gt 0 ]; do
  case "$1" in
    --backend) backend=$2; shift ;;
    --max-ticks) max=$2; shift ;;
    --cwd) cwd=$2; shift ;;
    --on-limit) onlimit=$2; shift ;;
    --model) model=$2; shift ;;
  esac
  shift
done
cd "$cwd" || exit 1
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
ev() { printf '{"v":1,"ts":"%s",%s}\n' "$(ts)" "$1"; }

ev "\"type\":\"run_start\",\"protocol\":\"1.1.0\",\"backend\":\"$backend\",\"plan\":\"smoke-fixture.plan.md\",\"pending\":1,\"maxTicks\":$max,\"hitl\":\"driver\""
ev "\"type\":\"log\",\"level\":\"info\",\"message\":\"fixture args: backend=$backend on-limit=${onlimit:-none} model=${model:-none}\""
sleep 1
ev "\"type\":\"tick_start\",\"tick\":1,\"maxTicks\":$max,\"pending\":1,\"log\":\".cursor/loop-logs/tick-fixture.log\",\"prompt\":\"TICK_PROMPT fixture\",\"backend\":\"$backend\""
ev "\"type\":\"agent_event\",\"tick\":1,\"event\":{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Fixture tick: editing fixture-tick.txt and README.md.\"}]}}"
printf 'written by the fixture tick\n' > fixture-tick.txt
printf '\nFixture tick line.\n' >> README.md
ev "\"type\":\"hitl_gate\",\"tick\":1,\"askId\":\"smoke-gate\",\"labels\":[\"Ship it\",\"Hold\"],\"detection\":\"sentinel\",\"line\":\"HITL_GATE: smoke-gate | Ship it | Hold\""
if ! IFS= read -r reply; then
  ev "\"type\":\"tick_end\",\"tick\":1,\"backend\":\"$backend\",\"limit\":null,\"exitCode\":4,\"pendingBefore\":1,\"pendingAfter\":1,\"result\":null,\"replies\":[],\"stop\":{\"askId\":\"smoke-gate\",\"cause\":\"EOF\",\"message\":\"stdin closed\",\"exitCode\":4}"
  ev "\"type\":\"run_end\",\"exitCode\":4,\"ticks\":1,\"pending\":1,\"reason\":\"gate EOF\",\"planExhausted\":false"
  exit 4
fi
printf '%s\n' "$reply" > gate-reply.json
ev "\"type\":\"agent_event\",\"tick\":1,\"event\":{\"type\":\"user\",\"isReplay\":true,\"message\":{\"content\":\"HITL_REPLY: smoke-gate | relayed by the fixture\"}}"
printf 'answered\n' >> fixture-tick.txt
ev "\"type\":\"tick_end\",\"tick\":1,\"backend\":\"$backend\",\"limit\":null,\"exitCode\":0,\"pendingBefore\":1,\"pendingAfter\":0,\"result\":{\"kind\":\"done\",\"line\":\"LOOP_TICK_RESULT: done\"},\"replies\":[],\"stop\":null"
ev "\"type\":\"run_end\",\"exitCode\":0,\"ticks\":1,\"pending\":0,\"reason\":\"plan done\",\"planExhausted\":true"
