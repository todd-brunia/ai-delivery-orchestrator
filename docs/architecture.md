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

## Provider ports and local composition

The versioned `providers/v1` boundary separates canonical GitHub reads,
proposed GitHub mutations, feasibility analysis, and pull-request review from
application policy. Model results retain structured decisions, evidence,
provenance, policy/model versions, and usage—not raw reasoning.

Only `PROVIDER_MODE=stub` is enabled. Deterministic in-memory adapters require
explicit fixtures, return isolated copies, capture mutation intent without
executing it, and make no network calls. Real Octokit and OpenAI adapters are
deferred and cannot be selected through configuration.

## Stub-only LangGraph runtime

The internal workflow runtime executes the first bounded
`sprint-delivery/v1` dry-run path: load an existing immutable run, read every
issue through fixture-backed GitHub ports, request fixture-backed feasibility
analysis, validate domain policy and dependency rules, and persist analysis
plus attributable state transitions. It then loads authoritative work-item
state, chooses at most two runnable issues by stable issue-number order,
serializes dependency, overlapping-domain, and low-confidence candidates, and
re-reads selected fixtures. Identity, state, label, timestamp, or plan-content
drift invalidates the schedule. Schedule decisions, reconciliation reports,
and label/dispatch proposals have versioned strict contracts and durable,
idempotent records; the graph never invokes the GitHub mutation port or marks
a work item dispatched.

The official open-source PostgreSQL checkpointer stores graph execution state
in `langgraph_checkpoints`. Stable thread IDs resume interrupted graphs, while
deterministic application idempotency keys prevent replay from duplicating
transitions or outbox actions. Application tables remain authoritative for run
and work-item state; checkpoint payloads cannot add states or bypass policy.
Missing fixtures, incomplete conflict coverage, unsupported versions,
non-stub provider selection, infeasible results, unresolved decisions, and
stale database revisions fail closed.

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
runtime read policy remains unattached. Resource-specific queue, compute, and
database alarms are deferred until those resources exist.

Pilot teardown is a separate manual workflow protected by the same environment,
commit-identity checks, OIDC role, and non-cancelling concurrency group as
apply. It applies a saved main-stack destroy plan first and retains pilot IAM by
default. Bootstrap trust, state storage, and state history are never in the
workflow's destroy boundary.
