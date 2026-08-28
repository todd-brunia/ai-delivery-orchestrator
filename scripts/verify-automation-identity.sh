#!/usr/bin/env bash
set -euo pipefail

role="${1:-}"
profile="${AWS_PROFILE:-ai-orchestrator-pilot}"
secret_version_stage="${SECRET_VERSION_STAGE:-AWSCURRENT}"
pull_request="${2:-}"
expected_head="${3:-}"

if [[ "$role" != "builder" && "$role" != "reviewer" && "$role" != "merger" ]]; then
  echo "usage: AWS_PROFILE=PROFILE $0 builder | reviewer [PR_NUMBER EXPECTED_HEAD_SHA] | merger" >&2
  exit 2
fi
if [[ "$secret_version_stage" != "AWSCURRENT" && "$secret_version_stage" != "AWSPREVIOUS" ]]; then
  echo "SECRET_VERSION_STAGE must be AWSCURRENT or AWSPREVIOUS" >&2
  exit 2
fi
if [[ "$role" != "reviewer" && ( -n "$pull_request" || -n "$expected_head" ) ]]; then
  echo "$role verification never accepts a pull request or invokes a mutation" >&2
  exit 2
fi
if [[ "$role" == "reviewer" && ( -n "$pull_request" || -n "$expected_head" ) ]]; then
  [[ "$pull_request" =~ ^[1-9][0-9]*$ && "$expected_head" =~ ^[0-9a-f]{40}$ ]] || {
    echo "reviewer mutation requires PR_NUMBER and exact 40-character head SHA" >&2
    exit 2
  }
fi

for command in aws curl jq openssl; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 2; }
done

repository="todd-brunia/ai-consulting-client-portal"
config="config/automation-identities/v1/${role}.json"
app_id="$(jq -er .appId "$config")"
app_slug="$(jq -er .appSlug "$config")"
installation_id="$(jq -er .installationId "$config")"
secret_name="$(jq -er .secretContainerName "$config")"
secret_arn="${AUTOMATION_IDENTITY_SECRET_ARN:-}"
if [[ ! "$secret_arn" =~ ^arn:aws:secretsmanager:us-east-1:[0-9]{12}:secret:${secret_name}-[A-Za-z0-9]{6}$ ]]; then
  echo "AUTOMATION_IDENTITY_SECRET_ARN must identify the exact configured role secret in us-east-1" >&2
  exit 1
fi
configuration_revision="$(jq -er .configurationRevision "$config")"

work_directory="$(mktemp -d)"
chmod 700 "$work_directory"
cleanup() {
  rm -f "$work_directory"/*
  rmdir "$work_directory"
}
trap cleanup EXIT
umask 077

key_file="$work_directory/private-key.pem"
aws secretsmanager get-secret-value \
  --profile "$profile" \
  --region us-east-1 \
  --secret-id "$secret_arn" \
  --version-stage "$secret_version_stage" \
  --query SecretString \
  --output text >"$key_file"
openssl pkey -in "$key_file" -noout -check >/dev/null

base64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
issued_at="$(($(date +%s) - 60))"
expires_at="$(($(date +%s) + 540))"
header="$(printf '%s' '{"alg":"RS256","typ":"JWT"}' | base64url)"
payload="$(printf '{"iat":%s,"exp":%s,"iss":"%s"}' "$issued_at" "$expires_at" "$app_id" | base64url)"
unsigned="$header.$payload"
signature="$(printf '%s' "$unsigned" | openssl dgst -binary -sha256 -sign "$key_file" | base64url)"
jwt="$unsigned.$signature"

api_headers=(
  --silent --show-error --fail
  -H "Accept: application/vnd.github+json"
  -H "X-GitHub-Api-Version: 2022-11-28"
)
app_file="$work_directory/app.json"
installation_file="$work_directory/installation.json"
token_response="$work_directory/token-response.json"
token_file="$work_directory/installation-token"
repositories_file="$work_directory/repositories.json"

curl "${api_headers[@]}" -H "Authorization: Bearer $jwt" https://api.github.com/app >"$app_file"
curl "${api_headers[@]}" -H "Authorization: Bearer $jwt" "https://api.github.com/app/installations/$installation_id" >"$installation_file"

if [[ "$role" == "builder" ]]; then
  token_request='{"repositories":["ai-consulting-client-portal"],"permissions":{"actions":"write","issues":"write","pull_requests":"write"}}'
elif [[ "$role" == "reviewer" ]]; then
  token_request='{"repositories":["ai-consulting-client-portal"],"permissions":{"checks":"read","contents":"read","pull_requests":"write"}}'
else
  token_request='{"repositories":["ai-consulting-client-portal"],"permissions":{"contents":"write"}}'
fi
curl "${api_headers[@]}" -X POST -H "Authorization: Bearer $jwt" \
  "https://api.github.com/app/installations/$installation_id/access_tokens" \
  -d "$token_request" >"$token_response"
jq -er .token "$token_response" >"$token_file"
token_expiry="$(jq -er .expires_at "$token_response")"
rm -f "$token_response"
installation_token="$(<"$token_file")"
curl "${api_headers[@]}" -H "Authorization: Bearer $installation_token" \
  https://api.github.com/installation/repositories >"$repositories_file"

expected_permissions="$(jq -c '[.permissionCeiling[] | split(\":\") | {(.[0]): .[1]}] | add' "$config")"
jq -e \
  --arg expected_slug "$app_slug" \
  --arg expected_app_id "$app_id" \
  --arg expected_installation_id "$installation_id" \
  --arg repository "$repository" \
  --argjson expected_permissions "$expected_permissions" \
  --slurpfile app "$app_file" \
  --slurpfile installation "$installation_file" \
  --slurpfile repositories "$repositories_file" \
  '($app[0].slug == $expected_slug) and
   (($app[0].id | tostring) == $expected_app_id) and
   (($installation[0].id | tostring) == $expected_installation_id) and
   ($installation[0].account.login == "todd-brunia") and
   ($installation[0].repository_selection == "selected") and
   ($installation[0].permissions == $expected_permissions) and
   ([$repositories[0].repositories[] | {id:(.id | tostring), full_name}] == [{id:"1308170964", full_name:$repository}])' >/dev/null || {
    echo "canonical GitHub identity, permission, or repository scope does not match the contract" >&2
    exit 1
  }

jq -n \
  --arg role "$role" \
  --arg configuration_revision "$configuration_revision" \
  --arg expected_slug "$app_slug" \
  --arg expected_app_id "$app_id" \
  --arg expected_installation_id "$installation_id" \
  --arg token_expires_at "$token_expiry" \
  --arg secret_version_stage "$secret_version_stage" \
  --slurpfile app "$app_file" \
  --slurpfile installation "$installation_file" \
  --slurpfile repositories "$repositories_file" \
  '{role:$role, configuration_revision:$configuration_revision, secret_version_stage:$secret_version_stage,
    expected:{slug:$expected_slug,app_id:$expected_app_id,installation_id:$expected_installation_id},
    observed:{slug:$app[0].slug,app_id:($app[0].id|tostring),
      installation_id:($installation[0].id|tostring),account:$installation[0].account.login,
      repository_selection:$installation[0].repository_selection,
      permissions:$installation[0].permissions,
      repositories:[$repositories[0].repositories[]|{id:(.id|tostring),full_name}],
      token_expires_at:$token_expires_at}}'

if [[ "$role" == "reviewer" && -n "$pull_request" ]]; then
  pull_file="$work_directory/pull.json"
  review_file="$work_directory/review.json"
  curl "${api_headers[@]}" -H "Authorization: Bearer $installation_token" \
    "https://api.github.com/repos/$repository/pulls/$pull_request" >"$pull_file"
  actual_head="$(jq -er .head.sha "$pull_file")"
  [[ "$actual_head" == "$expected_head" ]] || {
    echo "canonical pull-request head does not match expected head" >&2
    exit 1
  }
  review_request="$(jq -n --arg commit_id "$expected_head" \
    '{commit_id:$commit_id,event:"COMMENT",body:"Identity verification for ai-delivery-orchestrator issue #59; this review does not approve or merge."}')"
  curl "${api_headers[@]}" -X POST -H "Authorization: Bearer $installation_token" \
    "https://api.github.com/repos/$repository/pulls/$pull_request/reviews" \
    -d "$review_request" >"$review_file"
  jq '{review:{id:(.id|tostring),actor:.user.login,state,commit_id,submitted_at}}' "$review_file"
fi
