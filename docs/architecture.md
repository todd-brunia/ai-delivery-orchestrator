# Architecture

## Direction

The orchestrator separates durable domain policy from runtime and provider
adapters.

```text
Operator API and GitHub webhooks
               |
       durable inbox/outbox
               |
        workflow orchestrator
        /        |         \
   GitHub     OpenAI    persistence
   adapter    adapter      adapter
```

The first deployed workflow will accept one repository and an explicit list of
issues. A versioned workflow definition will coordinate planning, feasibility,
dependency analysis, implementation dispatch, pull request review, bounded
repair, and human merge.

## Boundaries

- **Domain:** states, transitions, policies, evidence requirements,
  idempotency, leases, and workflow versioning.
- **Runtime:** LangGraph execution and checkpoint resume behind an internal
  interface.
- **Providers:** GitHub, OpenAI, PostgreSQL, SQS, DynamoDB, and observability
  adapters.
- **Entrypoints:** secured operator API, webhook receiver, worker, migrations,
  and reconciliation jobs.

Provider objects must not leak into domain types. LangGraph checkpoint state is
not the authoritative public workflow contract.

## Initial deployment

The approved AWS direction uses API Gateway and Lambda for always-available
ingress, SQS for durable callbacks, DynamoDB for deduplication and status
projections, scale-to-zero Fargate workers, and Aurora PostgreSQL Serverless v2
for authoritative operational state and LangGraph checkpoints.

Infrastructure will be added incrementally through Terraform after local
domain and adapter contracts are tested.

## Sprint-delivery v1 domain contract

The stable provider-neutral contract is exported from
`src/domain/sprint-delivery/v1/index.ts`. It owns:

- Versioned run input and strict repository adapter configuration.
- Run and work-item states, commands, events, and fail-closed transitions.
- Risk categories and the human plan-approval boundary.
- Dependency edges, conflict domains, cycle detection, and parallelism policy.
- Transition evidence, idempotency keys, and expected aggregate revisions.

The v1 contract enables only human merge and at most two parallel
implementations. Low-confidence analysis and configured sensitive risks become
more restrictive automatically. Provider adapters may translate these domain
decisions into GitHub, persistence, queue, or model operations, but cannot add
states, weaken transitions, or broaden authority without a new contract
version.

## Application persistence boundary

Versioned SQL migrations under `migrations/` define the authoritative
application schema. `PostgresSprintRunRepository` is the initial adapter behind
the provider-neutral persistence interface. It atomically records validated
state transitions and pending outbox actions, rejects stale revisions, treats
idempotency keys as globally unique commands, and uses expiring aggregate
leases to exclude competing workers.

Sprint workflow identity (definition version, repository, issue list, and merge
policy) is immutable after insertion. The database stores structured events,
actors, and evidence references; it does not store credentials, webhook bodies,
private source, or raw model reasoning. LangGraph checkpoints use the separate
`langgraph_checkpoints` schema and are not authoritative application state.

The persistence adapter also records validated dependency/conflict analysis,
advances work items through the domain state machine, and selects build-ready
items only after their prerequisites merge. Outbox consumers claim bounded
batches with `SKIP LOCKED`; owner and expiry checks govern completion or retry,
and expired claims become recoverable without duplicating completed actions.

Runtime transport uses separate encrypted FIFO command and callback queues with
bounded retries and paired retained DLQs. Application idempotency keys—not SQS
content hashes—control deduplication. A protected DynamoDB table provides
TTL-backed delivery claims, wake generations, and explicitly eventually
consistent status projections. Every projection records its source revision,
event, and observation time; absence or regression falls back to Aurora rather
than becoming authoritative.

The worker service is private Fargate capacity bounded from zero to two tasks.
Its initial desired count is zero and its task definition uses only a full
commit-SHA ECR tag. Scale-down requires two ordered idle observations covering
both queues, outbox, leases, runnable work, and an unchanged durable wake
generation. Drain stops new claims before checkpoint/release. Runtime and task
execution roles remain unattached until their separately reviewed IAM slice.

## GitHub webhook trust boundary

`github-webhook/v1` verifies HMAC-SHA256 over exact request bytes before JSON
parsing and normalizes only correlation metadata. PostgreSQL stores the
normalized envelope and payload hash—not the raw body or secret—and deduplicates
globally by GitHub delivery ID. Inbox claims use expiring ownership,
`SKIP LOCKED`, bounded retries, and dead-letter exhaustion. An HTTP/Lambda
adapter and canonical GitHub refetch are separate future slices.

Callback processing uses a separate `github-callback/v1` routing contract. A
bounded worker claims FIFO inbox entries, obtains a work-item lease, refetches
canonical evidence through an injected resolver, and commits any legal
transition, projection outbox action, sanitized result, and inbox completion in
one PostgreSQL transaction. Unsupported or uncertain observations are stable
no-ops or blockers; they never authorize an external action.

The HTTP adapter is exposed only as `POST /github/webhooks` through an HTTP API
and a concurrency-bounded Lambda. It caps request size, preserves exact bytes
through signature verification, loads the webhook secret only through an
injected boundary, and publishes only the normalized envelope. Responses are
bounded receipts and never echo payloads. The Lambda role remains an exact
validated reference owned by the separate IAM root.

## Operator API v1

The operator surface uses API Gateway IAM/SigV4 authorization plus an exact
application-level principal allowlist. Versioned routes support run creation,
bounded list/detail/event reads, pause/resume/cancel/reconcile, and worker
wake/drain. Every mutation requires an idempotency key bound to principal,
route, and validated payload digest and returns `202` with a stable command
location. Reads label authoritative or projection sources and projection time.
Unknown routes, versions, fields, principals, stale revisions, pagination, and
oversized bodies fail closed.

## Runtime command processing

`runtime-command/v1` binds command identity, target, expected revision,
idempotency, actor, causation/correlation, and configuration version. A bounded
FIFO consumer validates the envelope, acquires an aggregate lease, and lets the
PostgreSQL repository atomically commit the domain transition and projection
outbox action before acknowledging transport. Duplicate transition keys return
the committed result; stale revisions, target drift, unsupported actors, and
unknown versions do not transition state. DynamoDB projection writes use a
source-revision conditional update and explicit `projectionAsOf`; regressions
are ignored and projection outages retry independently. Wake and drain use
compare-and-swap generations so a racing wake cannot be lost.

## Provider ports and local composition

The versioned `providers/v1` boundary separates canonical GitHub reads,
proposed GitHub mutations, feasibility analysis, and pull-request review from
application policy. Model results retain structured decisions, evidence,
provenance, policy/model versions, and usage—not raw reasoning.

Ordinary worker composition remains `PROVIDER_MODE=stub`. Deterministic
in-memory adapters require explicit fixtures, return isolated copies, capture
mutation intent without executing it, and make no network calls. The dedicated
supervised-dispatch executable is the sole live composition: it binds one
allowlisted portal repository to the narrow GitHub App reader, OpenAI
feasibility adapter, builder-only workflow mutation transport, PostgreSQL
repository, exact outbox consumer, and canonical workflow-run reconciler. It
is not reachable from the ordinary worker or operator API and is disabled by
default.

The supervised pilot task is an unscheduled Fargate task definition, not an ECS
service. Under the owner-approved checkpoint exception it runs in a public
subnet with an ephemeral public IP, a dedicated security group with no ingress,
TCP 443-only internet egress, and exact PostgreSQL egress. Its task role can
read only the builder GitHub App and portal-builder OpenAI secrets; its
execution role can inject only the RDS credential and pull/log the immutable
image. Deployment registers the task but never invokes it.

## Checkpointed planning and dispatch safety

The internal workflow runtime executes a bounded `sprint-delivery/v1` path:
load an immutable run, collect canonical issue and marked-plan evidence,
acquire a per-work-item lease, and persist an immutable planning binding before
feasibility analysis. It validates policy and dependency rules, then chooses
dependency- and conflict-safe work within the adapter-configured ceiling of
two. Identity, state, label, timestamp, or plan-content drift invalidates the
schedule.

Dispatch is split across typed intent, durable attempt, and canonical evidence
boundaries. Attempt records distinguish proposed, claimed, accepted, ambiguous,
rejected, and blocked outcomes. `build_dispatched` is permitted only after a
canonical workflow run matches the implementation workflow, bound SHA, and
post-acceptance timeline; an outbox claim, response, model result, or
checkpoint is never proof that a build started.

The official open-source PostgreSQL checkpointer stores graph execution state
in `langgraph_checkpoints`. Stable thread IDs resume interrupted graphs, while
deterministic application idempotency keys prevent replay from duplicating
transitions or outbox actions. Application tables remain authoritative for run
and work-item state; checkpoint payloads cannot add states or bypass policy.
Missing evidence, lease contention, incomplete conflict coverage, unsupported
versions, infeasible results, unresolved decisions, binding drift, and stale
database revisions fail closed.

## Immutable automatic-run authorization

The domain can represent, but cannot yet execute, an automatic-merge run. A
strict `run-authorization/v1` envelope binds the canonical repository, sorted
issue scope, SHA-256 digest of each approved marked plan, default-branch commit
SHA, automatic-merge policy version and digest, stable GitHub human identity,
and authorization time. The complete validated envelope has a deterministic
SHA-256 fingerprint. Exact UTF-8 bytes of the approved marked plan are the
hashing input; callers must not silently normalize or rewrite plan content.

Automatic run input must match the envelope exactly. PostgreSQL persists the
envelope and fingerprint as immutable run identity, and rehydration validates
both before exposing the run. Canonical observations are evaluated separately
and any missing evidence or repository, scope, plan, base-branch, or policy
drift denies progress. Changed bound values require a new human authorization
and run rather than an in-place refresh.

The work-item domain also defines an authorization- and exact-head-bound path
from human-review readiness through policy check, merger readiness, merge
request, and recorded completion. It is a policy contract only: no live GitHub
read, review, publisher, merger, credential, release, or deployment capability
is enabled by these states.

This slice does not implement webhook transport, live target-repository
validation, live provider adapters, GitHub writes, proposal execution, or
application AWS compute. Scheduling/reconciliation is fixture-only and does
not constitute end-to-end Phase 2 completion.

## Automation identity contract

`src/domain/automation-identities/v1` defines the provider-neutral identity
schema, pure operation authorization, and startup/protection preflight. It
binds builder, reviewer, and merger to one immutable GitHub App/installation,
one exact portal audience, one permission ceiling and operation set, a
configuration revision, and a role-specific secret container. Unknown or
unavailable identity, permission, audience, configuration, or protection data
denies without side effects.

The pilot defines three empty GitHub App key containers. Only the builder
container is in the future runtime read policy; reviewer and merger have no
workload attachment in this slice. Terraform never stores a key or secret
version. Provisioning and live attribution remain a human-gated later story.

## Terraform foundation

`infra/bootstrap` defines the protected S3 state bucket plus separate GitHub
OIDC roles for pull-request planning and protected-environment apply.
Both roles bind to GitHub's immutable subject format, including the stable
numeric owner and repository IDs, so namespace reuse cannot inherit AWS trust.
`infra/environments/pilot-iam` owns pilot/application IAM in the independent
`pilot-iam/terraform.tfstate` state key. Its exact, account-scoped outputs are
passed as validated inputs to `infra/environments/pilot`; neither root reads the
other's state or guesses resource names. The main pilot root contains no
managed IAM resources and defines immutable ECR storage, two-AZ
public/isolated networking, empty secret containers, retained log groups, an
informational billing alarm, and a monthly budget. The pilot data plane includes
an encrypted Aurora PostgreSQL Serverless v2 cluster in the isolated subnets.
Its managed master secret never enters Terraform configuration or output, and
PostgreSQL ingress is possible only from explicitly supplied worker or migration
security groups. Application state remains in `orchestrator`; LangGraph uses
`langgraph_checkpoints`. There is no NAT Gateway or application compute in this
slice.

Pull requests can produce read-only plans. Provisioning requires manual
dispatch for an explicit commit already on `main`, approval through the GitHub
`pilot` environment, and short-lived OIDC credentials. IAM provisioning is an
explicit, fail-closed workflow option that defaults off; when enabled, its
saved plan is applied before the saved main-stack plan for the same commit. A
one-time human
bootstrap creates the state bucket and OIDC roles because that trust cannot
bootstrap itself. Secret values are entered outside Terraform; the future
runtime read policy remains unattached. Runtime roles and their exact positive
and negative boundaries are documented in the [pilot runtime authority
matrix](./runtime-authority-matrix.md). Workload, execution, webhook, operator,
migration, GitHub role, and target-specific OpenAI authority are separated in
`pilot-iam`; the main root only attaches exact role ARN inputs. Terraform
creates containers but never secret values or long-lived AWS credentials.
The pilot observability layer supplies versioned bounded
telemetry dimensions, redaction helpers, service and recovery alarms, and one
operational dashboard. CloudWatch is operational evidence only; PostgreSQL
remains authoritative. Restore verification creates a tagged private copy from
an approved snapshot, performs read-only schema checks, and leaves deletion to
a distinct protected workflow checkpoint.

Runtime promotion is a separate protected workflow bound to current `main`, an
immutable ECR tag and expected digest, non-destructive saved plans, and an exact
deployment role that is intentionally not provisioned by this slice. Migration
and synthetic smoke are opt-in named checkpoints. Rollback changes only the
immutable application image under the current Terraform revision and never
reverses migration history.

Pilot teardown is a separate manual workflow protected by the same environment,
commit-identity checks, OIDC role, and non-cancelling concurrency group as
apply. It applies a saved main-stack destroy plan first and retains pilot IAM by
default. Bootstrap trust, state storage, and state history are never in the
workflow's destroy boundary.
