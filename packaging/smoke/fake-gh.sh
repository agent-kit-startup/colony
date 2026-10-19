#!/bin/sh
# COLONY_SMOKE fixture: stands in for the GitHub CLI (`gh`) so the smoke can exercise host
# requests, the PR list and the CI/CD tab without touching GitHub. Use it with
# COLONY_GH_BIN=<this file>. Every call is appended to gh-proof.txt in the working folder;
# answers are canned (PR 7 targets feat/base, PR 8 targets release, run 4243 failed).
# It reads no credentials and makes no network call.
printf '%s\n' "$*" >> gh-proof.txt
pr_json() {
  case "$1" in
    7) base=feat/base head=feat/seven title="Smoke PR seven" ;;
    8) base=release head=feat/eight title="Smoke PR eight (release)" ;;
    *) base=feat/base head=feat/other title="Smoke PR $1" ;;
  esac
  printf '{"number":%s,"title":"%s","state":"OPEN","headRefName":"%s","headRefOid":"0123456789abcdef0123456789abcdef01234567","baseRefName":"%s","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":"APPROVED","url":"https://example.invalid/pr/%s","author":{"login":"smoke"},"statusCheckRollup":[{"__typename":"CheckRun","name":"build","status":"COMPLETED","conclusion":"SUCCESS"},{"__typename":"CheckRun","name":"lint","status":"COMPLETED","conclusion":"FAILURE"}]}' "$1" "$title" "$head" "$base" "$1"
}
run_json() {
  case "$1" in
    4242) c=success ;;
    *) c=failure ;;
  esac
  printf '{"databaseId":%s,"displayTitle":"Smoke run %s","workflowName":"CI","headBranch":"feat/seven","headSha":"0123456789abcdef0123456789abcdef01234567","event":"pull_request","status":"completed","conclusion":"%s","createdAt":"2026-10-19T12:00:00Z","url":"https://example.invalid/run/%s"}' "$1" "$1" "$c" "$1"
}
case "$1 $2" in
  "auth status") echo "github.com: Logged in to github.com account smoke (fake gh)" ;;
  "pr list") printf '[%s,%s]\n' "$(pr_json 7)" "$(pr_json 8)" ;;
  "pr view")
    case " $* " in
      *" --web "*) echo "Opening https://example.invalid/pr/$3 in your browser." ;;
      *) pr_json "$3"; echo ;;
    esac ;;
  "pr checks") printf 'build\tpass\t1m2s\thttps://example.invalid/check/1\nlint\tfail\t12s\thttps://example.invalid/check/2\n'; exit 1 ;;
  "pr diff") printf 'diff --git a/smoke.txt b/smoke.txt\n--- a/smoke.txt\n+++ b/smoke.txt\n@@ -1 +1 @@\n-old line\n+new line from PR %s\n' "$3" ;;
  "pr merge") echo "Merged pull request #$3 ($4) (fake gh)" ;;
  "run list") printf '[%s,%s]\n' "$(run_json 4242)" "$(run_json 4243)" ;;
  "run view") run_json "$3"; echo ;;
  "run rerun") echo "Requested rerun of the failed jobs of run $3 (fake gh)" ;;
  *) echo "fake gh: unsupported: $*" >&2; exit 2 ;;
esac
