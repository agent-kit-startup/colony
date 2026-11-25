#!/bin/sh
# COLONY_SMOKE fixture: stands in for the GitHub CLI (`gh`) so the smoke can exercise host
# requests, the PR list and the CI/CD tab without touching GitHub. Use it with
# COLONY_GH_BIN=<this file>. Every call is appended to gh-proof.txt in the working folder;
# answers are canned (PR 7 targets feat/base, PR 8 targets release, PR 9 is staging -> main,
# PR 11 is a release-close PR into staging, run 4243 failed; for the forge-style PR list: PR 13
# is a bot PR behind its base, PR 14 conflicts, PR 15 has checks running, PR 16 fails a check,
# PR 17 has merged already). `api graphql` answers the kit
# ship lane collector (Mission Control data 1.8.0) with PR 11 open and tag CI run 4300 failed;
# for data 1.11.0 its Ref.compare of main and staging is 3 ahead (one feat, one merge, one docs
# commit: release pending 1) and 1 behind (staging sync due), and no promote PR merged yet.
# put this file first on PATH as `gh` so the engine's collector reads it too.
# It reads no credentials and makes no network call.
if [ "$1" = api ]; then
  echo "api $2" >> gh-proof.txt
  [ "$2" = graphql ] || { echo "fake gh: unsupported: api $2" >&2; exit 2; }
  printf '%s' '{"data":{"repo":{"base":{"compare":{"aheadBy":3,"behindBy":1,"commits":{"totalCount":3,"nodes":[{"oid":"1111111111111111111111111111111111111111","messageHeadline":"feat: smoke feature","parents":{"totalCount":1}},{"oid":"2222222222222222222222222222222222222222","messageHeadline":"Merge pull request #5 from smoke/feat","parents":{"totalCount":2}},{"oid":"3333333333333333333333333333333333333333","messageHeadline":"docs: smoke note","parents":{"totalCount":1}}]}}},"promoted":{"nodes":[]},"pullRequests":{"totalCount":1,"nodes":[{"number":11,"title":"chore: close release 6.9.1 <img src=x onerror=alert(1)>","isDraft":false,"baseRefName":"staging","headRefName":"chore/close-release-6.9.1","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS","contexts":{"nodes":[{"__typename":"CheckRun","name":"build","status":"COMPLETED","conclusion":"SUCCESS"},{"__typename":"CheckRun","name":"signature-scan","status":"COMPLETED","conclusion":"SUCCESS"}]}}}}]}}]},'
  printf '%s\n' '"latestRelease":{"tagName":"v6.9.0","publishedAt":"2026-10-24T00:00:00Z"},"tag":{"name":"v6.9.0","target":{"__typename":"Commit","checkSuites":{"nodes":[{"workflowRun":{"databaseId":4300,"event":"push","workflow":{"name":"Release"}},"checkRuns":{"nodes":[{"name":"build","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"sync-public","status":"COMPLETED","conclusion":"FAILURE"}]}}]}}}}}}'
  exit 0
fi
printf '%s\n' "$*" >> gh-proof.txt
pr_json() {
  cross=false owner=smoke author='{"login":"smoke","is_bot":false}' state=OPEN mergeable=MERGEABLE merge=CLEAN
  pass='{"__typename":"CheckRun","name":"build","status":"COMPLETED","conclusion":"SUCCESS"}'
  rollup="$pass,{\"__typename\":\"CheckRun\",\"name\":\"lint\",\"status\":\"COMPLETED\",\"conclusion\":\"SUCCESS\"}"
  [ "$1" = 10 ] && cross=true owner=mallory
  case "$1" in
    13) author='{"login":"app/agent-kit-idle","is_bot":true}' merge=BEHIND ;;
    14) author='{"login":"mallory","is_bot":false}' mergeable=CONFLICTING merge=DIRTY ;;
    15) rollup="$pass,{\"__typename\":\"CheckRun\",\"name\":\"e2e\",\"status\":\"IN_PROGRESS\",\"conclusion\":null}" merge=UNSTABLE ;;
    16) rollup="$pass,{\"__typename\":\"CheckRun\",\"name\":\"signature-scan\",\"status\":\"COMPLETED\",\"conclusion\":\"FAILURE\"}" merge=UNSTABLE ;;
    17) state=MERGED mergeable=UNKNOWN merge=UNKNOWN ;;
  esac
  case "$1" in
    7) base=feat/base head=feat/seven title="Smoke PR seven" ;;
    8) base=release head=feat/eight title="Smoke PR eight (release) <img src=x onerror=alert(1)>" ;;
    9) base=main head=staging title="Promote staging to main" ;;
    11) base=staging head=chore/close-release-6.9.1 title="chore: close release 6.9.1" ;;
    10) base=main head=staging title="Promote staging to main (fork)" ;;
    *) base=feat/base head=feat/other title="Smoke PR $1" ;;
  esac
  printf '{"number":%s,"title":"%s","state":"%s","headRefName":"%s","headRefOid":"0123456789abcdef0123456789abcdef01234567","baseRefName":"%s","isDraft":false,"mergeable":"%s","mergeStateStatus":"%s","reviewDecision":"APPROVED","url":"https://example.invalid/pr/%s","author":%s,"createdAt":"2026-11-07T12:00:00Z","isCrossRepository":%s,"headRepositoryOwner":{"login":"%s"},"statusCheckRollup":[%s]}' "$1" "$title" "$state" "$head" "$base" "$mergeable" "$merge" "$1" "$author" "$cross" "$owner" "$rollup"
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
  "pr list") printf '[%s,%s,%s,%s,%s,%s,%s]\n' "$(pr_json 7)" "$(pr_json 8)" "$(pr_json 9)" "$(pr_json 13)" "$(pr_json 14)" "$(pr_json 15)" "$(pr_json 16)" ;;
  "pr view")
    case " $* " in
      *" --web "*) echo "Opening https://example.invalid/pr/$3 in your browser." ;;
      *) pr_json "$3"; echo ;;
    esac ;;
  "pr checks") printf 'build\tpass\t1m2s\thttps://example.invalid/check/1\nlint\tfail\t12s\thttps://example.invalid/check/2\n'; exit 1 ;;
  "pr diff") printf 'diff --git a/smoke.txt b/smoke.txt\n--- a/smoke.txt\n+++ b/smoke.txt\n@@ -1 +1 @@\n-old line\n+new line from PR %s\n' "$3" ;;
  "pr merge") echo "Merged pull request #$3 ($4) (fake gh)" ;;
  "pr create") echo "https://example.invalid/pr/12 (fake gh: created)" ;;
  "pr update-branch") echo "PR branch #$3 updated (fake gh)" ;;
  "pr close") echo "Closed pull request #$3 (fake gh)" ;;
  "run list") printf '[%s,%s]\n' "$(run_json 4242)" "$(run_json 4243)" ;;
  "run view") run_json "$3"; echo ;;
  "run rerun") echo "Requested rerun of the failed jobs of run $3 (fake gh)" ;;
  *) echo "fake gh: unsupported: $*" >&2; exit 2 ;;
esac
