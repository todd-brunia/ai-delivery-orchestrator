#!/usr/bin/env bash
set -euo pipefail

# A non-generic, human-supervised fixture runner. It has no runtime worker use.
operation="${1:-}"
expected_head="${2:-}"
profile="${AWS_PROFILE:-ai-orchestrator-pilot}"
repository="todd-brunia/ai-consulting-client-portal"
issue_number="136"
pull_request_number="137"
workflow="m3e1-builder-fixture.yml"
label="m3e1-builder-fixture"

if [[ "$operation" != "set-label" && "$operation" != "dispatch-workflow" && "$operation" != "mark-ready" ]]; then
  echo "usage: M3E1_FIXTURE_CONFIRMATION=EXECUTE-M3E1-BUILDER-FIXTURE $0 set-label|dispatch-workflow|mark-ready [EXACT_PR_HEAD_SHA]" >&2; exit 2
fi
if [[ "$operation" == "mark-ready" && ! "$expected_head" =~ ^[0-9a-f]{40}$ ]]; then echo "mark-ready requires an exact 40-character PR head SHA" >&2; exit 2; fi
if [[ "$operation" != "mark-ready" && -n "$expected_head" ]]; then echo "only mark-ready accepts a PR head SHA" >&2; exit 2; fi
if [[ "${M3E1_FIXTURE_CONFIRMATION:-}" != "EXECUTE-M3E1-BUILDER-FIXTURE" ]]; then echo "fixture execution is disabled without the exact confirmation phrase" >&2; exit 1; fi
if [[ "$-" == *x* ]]; then echo "shell tracing is forbidden" >&2; exit 1; fi
for command in aws curl jq openssl; do command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 2; }; done

config="config/automation-identities/v1/builder.json"
app_id="$(jq -er .appId "$config")"
installation_id="$(jq -er .installationId "$config")"
[[ "$(jq -r .appSlug "$config")" == "todd-brunia-ai-delivery-builder" ]] || { echo "builder contract drifted" >&2; exit 1; }
[[ "$(jq -c .permissionCeiling "$config")" == '["metadata:read","issues:write","actions:write","pull_requests:write"]' ]] || { echo "builder permission ceiling drifted" >&2; exit 1; }

work="$(mktemp -d)"; chmod 700 "$work"; trap 'rm -f "$work"/*; rmdir "$work"' EXIT; umask 077
secret="ai-delivery-orchestrator/pilot/github-app-builder-private-key"
arn="$(aws secretsmanager describe-secret --profile "$profile" --region us-east-1 --secret-id "$secret" --query ARN --output text)"
key="$work/key.pem"
aws secretsmanager get-secret-value --profile "$profile" --region us-east-1 --secret-id "$arn" --version-stage AWSCURRENT --query SecretString --output text >"$key"
openssl pkey -in "$key" -noout -check >/dev/null
base64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
iat="$(( $(date +%s) - 60 ))"
header="$(printf '%s' '{"alg":"RS256","typ":"JWT"}' | base64url)"
payload="$(printf '{"iat":%s,"exp":%s,"iss":"%s"}' "$iat" "$((iat + 540))" "$app_id" | base64url)"
unsigned="$header.$payload"
jwt="$unsigned.$(printf '%s' "$unsigned" | openssl dgst -binary -sha256 -sign "$key" | base64url)"
common=(-sS --connect-timeout 10 --max-time 30 -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")
token_json="$work/token.json"
curl "${common[@]}" -X POST -H "Authorization: Bearer $jwt" "https://api.github.com/app/installations/$installation_id/access_tokens" -d '{"repositories":["ai-consulting-client-portal"],"permissions":{"actions":"write","issues":"write","pull_requests":"write"}}' >"$token_json"
token="$(jq -er .token "$token_json")"; rm -f "$token_json"
auth=("${common[@]}" -H "Authorization: Bearer $token")
issue="$work/issue.json"; repo="$work/repo.json"
curl "${auth[@]}" "https://api.github.com/repos/$repository/issues/$issue_number" >"$issue"
curl "${auth[@]}" "https://api.github.com/repos/$repository" >"$repo"
[[ "$(jq -r .state "$issue")" == "open" ]] || { echo "fixture issue is not open" >&2; exit 1; }
method=""; path=""; body=""
case "$operation" in
  set-label)
    [[ "$(jq -c '[.labels[].name] | sort' "$issue")" == '[]' ]] || { echo "fixture issue labels drifted; refusing replacement" >&2; exit 1; }
    method="PATCH"; path="/repos/$repository/issues/$issue_number"; body="{\"labels\":[\"$label\"]}";;
  dispatch-workflow)
    ref="$(jq -er .commit.sha "$repo")"
    method="POST"; path="/repos/$repository/actions/workflows/$workflow/dispatches"; body="{\"ref\":\"$ref\",\"inputs\":{\"issue_number\":\"136\",\"fixture_id\":\"m3e1-builder-136\"}}";;
  mark-ready)
    pull="$work/pull.json"; curl "${auth[@]}" "https://api.github.com/repos/$repository/pulls/$pull_request_number" >"$pull"
    [[ "$(jq -r .state "$pull")" == "open" && "$(jq -r .draft "$pull")" == "true" && "$(jq -r .head.sha "$pull")" == "$expected_head" ]] || { echo "fixture PR state or head drifted" >&2; exit 1; }
    method="PATCH"; path="/repos/$repository/pulls/$pull_request_number"; body='{"draft":false}';;
esac
headers="$work/headers"
status="$(curl "${auth[@]}" -X "$method" -H "Content-Type: application/json" -H "X-AI-Orchestrator-Idempotency-Key: m3e1-builder-136:$operation" -D "$headers" -o /dev/null -w '%{http_code}' "https://api.github.com$path" -d "$body")"
[[ "$status" =~ ^2 ]] || { echo "fixture operation was rejected with HTTP $status" >&2; exit 1; }
request_id="$(awk 'BEGIN{IGNORECASE=1} /^x-github-request-id:/{print $2}' "$headers" | tr -d '\r' | tail -n 1)"
jq -n --arg operation "$operation" --arg status "$status" --arg request_id "$request_id" --arg expected_head "$expected_head" '{operation:$operation,fixture:"m3e1-builder-136",status:($status|tonumber),request_id:($request_id | if length > 0 then . else null end),expected_head:($expected_head | if length > 0 then . else null end)}'
