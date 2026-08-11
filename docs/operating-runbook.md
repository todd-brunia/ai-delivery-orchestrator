# Local Operating Runbook

## Scope and safety boundary

This runbook primarily covers the local foundation environment. The worker runs
with `PROVIDER_MODE=stub`; it has no GitHub or OpenAI credentials, makes no
provider network calls, and cannot mutate a repository. AWS runtime compute,
webhook HTTP ingress, and the operator API are not implemented. LangGraph
execution is available only through the internal stub-only dry-run runtime.

## Scheduling dry run

Prepare a non-secret JSON fixture containing strict `run`, `request`, `issues`,
and `feasibility` objects, then run:

```bash
DATABASE_URL=postgresql://orchestrator:local-orchestrator@127.0.0.1:54329/orchestrator npm run dry-run:schedule -- path/to/fixture.json
```

The command rejects non-local database hosts and non-stub provider requests.
Its sanitized report contains selected issues, blockers, capacity, drift,
evidence, and inert proposed actions. It loads no provider credentials and
makes no provider network calls.

Never place secrets in `.env`, fixtures, logs, issue bodies, or committed
files. The example database password is local-only and must not be reused.

## Install and validate

Requirements are Node.js 22, npm, and Docker. From the repository root:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run docker:build
```

Run `npm audit --audit-level=high` and a secret scan before requesting review.

## Automation identity preflight

Before any future identity consumer starts, obtain canonical GitHub reads and
validate exact App slug/ID, installation ID/account, selected portal repository
ID/name, permissions, and configuration revision against
`automation-identities/v1`. Independently require a public portal with base
`main`, strict `CI Gate`, an independent approval, stale/last-push protections,
resolved conversations, admin enforcement, linear history, squash-only merge,
and auto-merge disabled. Unavailable, ambiguous, stale, or mismatched state
stops startup. Reports may contain sanitized IDs and permission names, never
keys or tokens.

The human owner runs `scripts/verify-automation-identity.sh` only from an
isolated trusted operator workstation with an authenticated AWS profile. The
script keeps the key, JWT, and installation token in a mode-700 temporary
directory, removes them on exit, and prints only sanitized identity,
installation, repository, permission, expiry, and optional review metadata.
Do not run it in CI, a builder/model environment, or with shell tracing.

```bash
AWS_PROFILE=ai-orchestrator-pilot scripts/verify-automation-identity.sh reviewer
AWS_PROFILE=ai-orchestrator-pilot scripts/verify-automation-identity.sh merger
```

Reviewer attribution uses a human-created non-production verification PR. Bind
the call to its current canonical head SHA; the script refuses a stale head and
submits a `COMMENT` review that neither approves nor merges:

```bash
AWS_PROFILE=ai-orchestrator-pilot scripts/verify-automation-identity.sh reviewer PR_NUMBER EXACT_HEAD_SHA
```

The merger mode never accepts a PR number and never invokes the merge endpoint.
It proves the exact installation, selected repository, and Contents: write
ceiling; application policy tests separately prove that build, review, settings,
and non-merge ref/content writes are denied.

For a controlled rotation, generate a second GitHub App key, update the same
role-specific secret so the new version becomes `AWSCURRENT`, and rerun the
ordinary diagnostic. After that succeeds, revoke the old GitHub key and require
the same diagnostic with `SECRET_VERSION_STAGE=AWSPREVIOUS` to fail
authentication. Never restore the old stage or print either value. Remove the
obsolete Secrets Manager stage through a trusted operator action after the
failure is recorded; derived installation tokens remain live until expiry.

## PostgreSQL lifecycle

The pilot Aurora cluster is private, encrypted, deletion-protected, backed up
for at least seven days, and requires a final snapshot. Terraform manages the
cluster and an empty connectivity allowlist; AWS manages the master password.
Do not place the managed secret ARN, endpoint, or connection string in issue or
workflow output. Worker and migration security groups are added only after
their owning changes are reviewed.

Before an authorized pilot migration, verify the full commit and image digest,
cluster availability, expected migration checksums, and that no other migration
holds the advisory lock. Cold-resume connection attempts use bounded exponential
backoff. A checksum mismatch or exhausted connection retry is terminal: stop,
preserve evidence, and reconcile instead of editing migration history.

Restore verification always creates a separate isolated cluster from an
approved snapshot. Never restore over the authoritative cluster. Deleting the
verification cluster and its final snapshot is a distinct reviewed checkpoint.

Start only PostgreSQL and wait for a healthy status:

```bash
docker compose up -d postgres
docker compose ps postgres
```

Apply versioned migrations and run real-database tests:

```bash
DATABASE_URL=postgresql://orchestrator:local-orchestrator@127.0.0.1:54329/orchestrator npm run db:migrate
DATABASE_URL=postgresql://orchestrator:local-orchestrator@127.0.0.1:54329/orchestrator npm run db:checkpoints
DATABASE_URL=postgresql://orchestrator:local-orchestrator@127.0.0.1:54329/orchestrator npm run test:integration
```

Stop compute while preserving workflow data:

```bash
docker compose stop
```

Restarting with `docker compose up -d postgres` reuses the named volume.
Migrations are checksum-verified and safe to rerun. Never edit an applied
migration; add a new numbered migration.

`db:checkpoints` repeatably creates or upgrades only the dedicated
`langgraph_checkpoints` schema through the official checkpointer. Run it after
application migrations and before executing a dry-run graph. The application
schema remains authoritative; do not repair application state by editing
checkpoint tables.

## Worker lifecycle

Queue messages use `runtime-envelope/v1`, remain below 32 KiB, and contain only
attributable correlation data and bounded command payloads. Never include raw
webhooks, credentials, source, prompts, or reasoning. On retry exhaustion,
preserve the DLQ message and sanitized receive metadata. Stop producers and
consumers before replay; reconcile the idempotency key against Aurora, then
redrive through a reviewed operation. Never purge a queue or delete DLQ evidence.

The pilot ECS service is merged at desired/minimum capacity zero and maximum
capacity two. Do not raise capacity for the all-zero placeholder image SHA or
before runtime roles are attached. A graceful stop first blocks new claims,
persists or releases the current claim according to its lease policy, and exits
inside the 60-second task stop timeout. A new wake generation observed during
either idle check cancels scale-down. Emergency containment disables wake and
sets desired capacity to zero while preserving queues, leases, and checkpoints.

Start the local stack and inspect structured logs:

```bash
docker compose up -d
docker compose logs worker
```

Validate the production image without starting the long-running worker:

```bash
docker run --rm ai-delivery-orchestrator:local node dist/index.js --check
```

Use `docker compose stop worker` for a normal stop. The current worker only
emits heartbeats; it does not yet claim inbox or outbox work.

## Published worker images

A push to `main` publishes the worker image to the existing pilot ECR
repository under the full 40-character commit SHA. Publication uses a dedicated
main-only OIDC role and does not deploy or start the image. Confirm the workflow
commit matches the intended merge and retain the workflow run URL and image
digest as evidence; do not copy registry credentials or account identifiers
into issues or logs.

The publishing workflow fails closed when its immutable SHA tag already exists.
Treat that result as evidence of a prior publication or possible preemption.
Do not delete, overwrite, retag, or accept the existing image automatically.
Investigate the original workflow run and ECR metadata before deciding on a
new reviewed commit.

## Recovery

- If PostgreSQL is unhealthy, inspect `docker compose logs postgres`, stop the
  service, and start it again. Do not delete the volume as a first response.
- If a migration fails, preserve the database and logs, correct the new
  unapplied migration, and rerun it. Do not alter a successfully applied file.
- Expired database leases and inbox/outbox claims are designed for another
  worker to recover. Completed records are not claimable again.
- Resume an interrupted graph with the original stable thread ID. A missing or
  incorrect thread ID is an operator correlation error. Preserve both schemas
  while investigating failures.
- Checkpoint replay is guarded by deterministic application idempotency keys.
  Stop if replay reports stale revisions or an idempotency conflict; do not
  delete checkpoints or application transitions to force progress.
- A repeated schedule run does not duplicate proposed actions. On lease
  contention, wait for the one-minute lease to expire and retry with the same
  run and thread IDs. On drift or stale revision, correct the fixture or start
  a newly reviewed run; do not edit authoritative scheduling rows.
- Configuration errors fail startup. `PROVIDER_MODE` must remain `stub` until
  a separately reviewed issue enables a real adapter.

## Automatic-merge containment and recovery

These procedures define future operational behavior and current manual
containment. The live automatic-merge executor, operator API, and automated
kill controls are not implemented. Until they are, the human owner contains an
incident by keeping provider mode stub-only, disabling the affected GitHub App
installation or credential if one exists, and preventing deployment of any
publisher. See the [authority matrix](./automatic-merge-authority.md) and
[threat model](./threat-model.md).

All procedures retain the run ID, issue/PR number, authorization fingerprint,
expected and observed base/head/policy/plan hashes, transition and delivery
IDs, relevant sanitized audit events, actor, time, and human decisions. Never
retain live secrets, raw webhook bodies, source dumps, prompts, responses, or
model reasoning in an incident record.

### Pause

- **Trigger/initiator:** Operator or human owner observes drift, outage,
  contradictory state, repeated failure, or needs a reversible stop.
- **Actions:** Block new dispatch, review, publication, and merge progression;
  record the reason and expected revision; allow claims already executing to
  reach a bounded safe point; do not issue new external intents.
- **Complete when:** The durable run is paused, no new intent is claimable, and
  in-flight claims are identified with expirations.
- **Re-entry:** Operator may resume an ordinary pause only after canonical
  reconciliation reports no drift and no owner-only restoration trigger.
- **Never:** Treat pause as credential revocation or delete claims/history.

### Drain

- **Trigger/initiator:** Operator or owner needs a controlled shutdown without
  abandoning known in-flight actions.
- **Actions:** Pause new work, enumerate claimed inbox/outbox/work items, wait
  only to their bounded expiry, capture results, and reconcile every uncertain
  claim from canonical state.
- **Complete when:** No live claim remains and each item is completed, pending,
  failed, or explicitly uncertain and blocked.
- **Re-entry:** Resume only after uncertain items are reconciled.
- **Never:** Start replacement work during drain or assume an expired claim did
  not mutate an external system.

### Cancel

- **Trigger/initiator:** Operator or owner decides one work item or run must end
  terminally within existing authority.
- **Actions:** Pause, record cancellation at the expected revision, prevent or
  invalidate pending intents, drain claims, and reconcile possible external
  effects.
- **Complete when:** The target is durably cancelled and no pending action can
  advance it.
- **Re-entry:** Cancellation is not resumed. Changed work starts under a new
  run and, for automatic mode, a new human authorization.
- **Never:** Rewrite cancellation to another state or delete its evidence.

### Kill automatic authority

- **Trigger/initiator:** Human owner, or operator invoking a pre-authorized
  emergency kill, for suspected compromise, kill bypass, cross-repository
  target, protection drift, authorization/evidence mismatch, or unsafe outage.
- **Actions:** Set the repository or global kill before draining; block all new
  builder/reviewer/merger intents; disable/revoke the affected installation or
  credential when compromise is possible; preserve claims and audit evidence;
  test that a synthetic denied request cannot execute.
- **Complete when:** No affected identity can publish, review, or merge; pending
  intents are unclaimable; revocation/disablement and the kill revision are
  evidenced.
- **Re-entry:** Human owner only, after reconciliation, audit, credential
  rotation where relevant, verified controls, and new authorization for any
  changed bound value.
- **Never:** Restore merely because queues are empty or the suspected token
  expired.

### Reconcile canonical state

- **Trigger/initiator:** Operator or owner after restart, timeout, expired
  claim, duplicate response, drift signal, pause, drain, cancellation, or kill.
- **Actions:** Read canonical GitHub repository/installation, protection,
  default branch, PR exact head and merge status, checks, reviews, and audit
  metadata; compare them with the immutable authorization, transitions,
  inbox/outbox, and checkpoint correlation. Record differences and deny on
  unavailable/unknown values.
- **Complete when:** Every uncertain intent has one explained canonical outcome
  and all bindings either match or the item is blocked.
- **Re-entry:** Matching state may resume within authority. Any changed plan,
  policy, repository, issue scope, or base requires fresh human authorization.
- **Never:** Edit PostgreSQL/checkpoints or trust a webhook/model claim instead
  of the canonical read.

### Credential compromise, revocation, and rotation

- **Trigger/initiator:** Human owner on suspected builder, reviewer, merger,
  operator, or owner credential exposure or unexpected use.
- **Actions:** Kill affected authority; revoke/disable the credential or App
  installation; inventory its platform and runtime scope; audit all actions in
  the suspected window; rotate without sharing identities across roles;
  invalidate derived sessions; reconcile every affected repository/run.
- **Complete when:** Old credentials cannot authenticate, replacement scope is
  least privilege, audit findings are classified, and affected work is blocked
  or independently rebuilt/reviewed.
- **Re-entry:** Human owner restores after rotation and new authorization/review
  wherever integrity cannot be proven.
- **Never:** Put the credential value in evidence or rotate only the application
  secret while leaving active installation tokens/sessions usable.

### Duplicate or ambiguous merge request

- **Trigger/initiator:** Operator observes duplicate idempotency key, timeout,
  crash after request, expired merger claim, or conflicting completion state.
- **Actions:** Pause the item and stop retries; query the PR by repository and
  number; compare exact requested head, merge commit/method/time, actor, intent
  ID, and current authorization; complete the original intent only when the
  canonical result proves it succeeded exactly as authorized.
- **Complete when:** The request is classified as exact success, definite
  non-execution safe to retry with the same idempotency identity, or blocked
  ambiguity requiring owner review.
- **Re-entry:** Retry only definite non-execution after all gates are rechecked.
- **Never:** Send a new merge request because the response was lost.

### Protection drift, stale approval, or artifact substitution

- **Trigger/initiator:** Operator or owner sees ruleset/protection differences,
  missing checks/reviews, or plan/policy/base/head/artifact hash mismatch.
- **Actions:** Kill repository automatic authority, invalidate pending merge
  intent, preserve expected and observed fingerprints, audit the change actor,
  and reconcile other affected runs.
- **Complete when:** The drift source and scope are known and no affected intent
  can execute.
- **Re-entry:** Human owner restores correct settings and requires fresh check,
  independent review, and immutable authorization wherever bound evidence
  changed.
- **Never:** Accept a semantically similar artifact or bypass a missing gate.

### Incident evidence and restoration

- **Trigger/initiator:** Operator opens a sanitized incident record for every
  kill, compromise, evidence-integrity failure, unauthorized mutation, or
  unresolved ambiguity; human owner owns restoration.
- **Actions:** Capture the minimum identifiers listed above, control status,
  containment proof, timeline, reconciliation report, credential/protection
  changes by identifier, and owner decisions. Store evidence in the approved
  access-controlled audit location and link rather than copy sensitive data.
- **Complete when:** The incident explains scope, mutations, containment,
  residual uncertainty, and required reauthorization/review.
- **Re-entry:** Owner verifies kill effectiveness, remediation, least privilege,
  canonical reconciliation, independent checks/reviews, and a new immutable
  authorization when any binding changed; then records an explicit restoration.
- **Never:** Let the identity under investigation approve its own evidence or
  delete durable history to make reconciliation pass.

## Destructive local reset

`docker compose down --volumes` permanently deletes the local PostgreSQL named
volume and all locally persisted workflow history. Use it only when a complete
local reset is intentional and the data is confirmed disposable. A normal
cost/resource stop is `docker compose stop`, which preserves data.

## Escalation and evidence

Retain concise error messages, migration names, delivery IDs, transition IDs,
and commit SHAs. Do not copy raw webhook bodies, source content, credentials,
or model reasoning into logs or issues. Checkpoints may contain fixture-backed
issue content during execution; PostgreSQL retains decisions, reconciliation
observations, and proposed actions until the local volume is intentionally
destroyed. Reports omit issue title/body content. Stop and require human review
for an unknown migration checksum, conflicting idempotency fingerprint,
invalid signature, exhausted retry, or unexpected provider mode.
