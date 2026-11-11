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
# `conflicts --json` goes to a real kit when COLONY_SMOKE_KIT_REAL names one (an executable
# that runs `agent-kit`, from a kit after 6.14.0): the conflict window splices by the kit's
# marker lines, so a canned listing would drift. `conflicts propose` is stubbed (no model,
# no session): one accepted proposal per hunk, theirs then ours, built from that listing.
# `promote rules|wait --json` print the kit's JSON shapes and write nothing.
# `run-plan --model smoke-card-*` is the Current mission card branch (driver protocol 1.5.0
# stop_after_tick; see below): it writes no files.
# Use it with COLONY_AGENT_KIT_BIN=<this file> on a scratch clone only (it edits files).
set -u
if [ "${1:-}" = conflicts ]; then
  [ -n "${COLONY_SMOKE_KIT_REAL:-}" ] || { echo "Unknown command conflicts (fixture: COLONY_SMOKE_KIT_REAL is not set)" >&2; exit 1; }
  if [ "${2:-}" != propose ]; then exec "$COLONY_SMOKE_KIT_REAL" "$@"; fi
  path=$3 kcwd=. backend=auto
  while [ $# -gt 0 ]; do
    case "$1" in
      --cwd) kcwd=$2; shift ;;
      --backend) backend=$2; shift ;;
    esac
    shift
  done
  "$COLONY_SMOKE_KIT_REAL" conflicts --json --cwd "$kcwd" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const [path, backend] = process.argv.slice(1);
      const f = JSON.parse(s).files.find((x) => x.path === path);
      if (!f) { console.error(`fixture: ${path} is not conflicted`); process.exit(1); }
      const proposals = f.hunks.map((h) => ({ hunk: h.index, status: "accepted", text: h.theirs + h.ours, rationale: "fixture: theirs, then ours" }));
      const verification = { status: "skipped", reason: "fixture: no verification", commands: [], notes: ["COLONY_SMOKE propose stub: no agent session ran"] };
      console.log(JSON.stringify({ schema: 1, path, backend: `${backend} (fixture)`, proposals, unresolvedHunks: [], resolvedText: null, verification }));
    });' "$path" "$backend"
  exit $?
fi
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
if [ "$cmd" = promote ]; then
  # `agent-kit promote rules|wait --json` stand-ins (kit commands/promote.ts, #1417/#1418), read-only
  # like the real ones: the PR detail's merge box runs them for a promote. They must never fall
  # through to the run-plan stand-in below, which edits files.
  case "$sub" in
    rules) echo '{"ok":true,"base":"main","unmodeled":[{"name":"required_signatures","rulesetId":42}]}' ;;
    wait) echo '{"outcome":"merged","pr":{"state":"MERGED","mergedAt":"2026-11-08T12:00:00Z"},"polls":1}' ;;
    *) echo "fixture: unknown promote subcommand ${sub:-none}" >&2; exit 1 ;;
  esac
  exit 0
fi
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
# Current mission card (COLONY_SMOKE card-* steps), picked by `--model smoke-card-*`: plan
# smoke-fixture.plan.md, and NO file is written (the 2026-10-27 tick-review fixture gap: a
# stand-in that edits the workspace shows up in a later step's review). The stdin line it
# reads comes back as a `log` event, so the smoke checks the exact request Colony sent.
#   smoke-card-tick: protocol 1.5.0, a tick with no gate waits for one line;
#     {"type":"stop_after_tick"} ends the tick 2 s later, then the run: run_end.reason
#     "stopped by request after tick 1", exit 0 (kit docs/driver-events-protocol.md).
#   smoke-card-gate: protocol 1.5.0, gate smoke-card-gate; {"type":"stop"} ends the run at
#     the gate (driver stop, exit 4).
#   smoke-card-old: protocol 1.4.0 (below stop_after_tick), no gate: the tick runs 4 s and
#     the run ends on its own. Colony offers Kill there, which the smoke never clicks.
if [ "$cmd" = run-plan ] && case "${model:-}" in smoke-card-*) true ;; *) false ;; esac; then
  proto=1.5.0
  [ "$model" = smoke-card-old ] && proto=1.4.0
  ev "\"type\":\"run_start\",\"protocol\":\"$proto\",\"command\":\"run-plan\",\"backend\":\"$backend\",\"plan\":\"smoke-fixture.plan.md\",\"pending\":1,\"maxTicks\":$max,\"hitl\":\"driver\""
  ev "\"type\":\"tick_start\",\"tick\":1,\"maxTicks\":$max,\"pending\":1,\"log\":\".cursor/loop-logs/tick-card.log\",\"prompt\":\"TICK_PROMPT card fixture\",\"backend\":\"$backend\""
  say() { ev "\"type\":\"agent_event\",\"tick\":1,\"event\":{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"$1\"}]}}"; }
  # One stdin line (EOF reads as "EOF"), echoed as a log event.
  line_in() {
    IFS= read -r line || line=EOF
    esc=$(printf '%s' "$line" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
    ev "\"type\":\"log\",\"level\":\"info\",\"message\":\"fixture card stdin: $esc\""
  }
  # $1 tick exit, $2 tick result or null, $3 stop object or null, $4 run exit, $5 run_end.reason
  finish() {
    ev "\"type\":\"tick_end\",\"tick\":1,\"backend\":\"$backend\",\"limit\":null,\"exitCode\":$1,\"pendingBefore\":1,\"pendingAfter\":1,\"result\":$2,\"replies\":[],\"stop\":$3,\"usage\":null"
    ev "\"type\":\"run_end\",\"exitCode\":$4,\"ticks\":1,\"pending\":1,\"reason\":\"$5\",\"planExhausted\":false,\"usage\":null"
    exit "$4"
  }
  case "$model" in
    smoke-card-old)
      say "Card fixture (driver protocol 1.4.0): a tick with no gate that ends on its own."
      sleep 4
      finish 0 '{"kind":"continue","line":"LOOP_TICK_RESULT: continue"}' null 0 "max ticks reached" ;;
    smoke-card-gate)
      say "Card fixture: **one decision** before the tick goes on.\\n\\nHITL_GATE: smoke-card-gate | Go | Wait"
      ev "\"type\":\"hitl_gate\",\"tick\":1,\"askId\":\"smoke-card-gate\",\"labels\":[\"Go\",\"Wait\"],\"detection\":\"sentinel\",\"line\":\"HITL_GATE: smoke-card-gate | Go | Wait\",\"usage\":null"
      line_in
      case "$line" in
        *'"type":"stop"'*) finish 4 null '{"askId":"smoke-card-gate","cause":"driver stop","message":"stop sent by the app","exitCode":4}' 4 "driver stop" ;;
        *) finish 4 null '{"askId":"smoke-card-gate","cause":"protocol error","message":"fixture expected a stop","exitCode":4}' 4 "protocol error" ;;
      esac ;;
    *)
      say "Card fixture: a tick with no gate, running until the app asks to stop after it."
      line_in
      case "$line" in
        *'"type":"stop_after_tick"'*)
          # The tick finishes as it would have (2 s here), then the run ends: the card reads
          # Stopping… meanwhile.
          sleep 2
          finish 0 '{"kind":"continue","line":"LOOP_TICK_RESULT: continue"}' null 0 "stopped by request after tick 1" ;;
        *) finish 4 null '{"askId":null,"cause":"protocol error","message":"fixture expected stop_after_tick","exitCode":4}' 4 "protocol error" ;;
      esac ;;
  esac
fi
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
