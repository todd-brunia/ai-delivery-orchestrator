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
private source, or raw model reasoning. LangGraph checkpoints will use a
separate schema and are not authoritative application state.

The persistence adapter also records validated dependency/conflict analysis,
advances work items through the domain state machine, and selects build-ready
items only after their prerequisites merge. Outbox consumers claim bounded
batches with `SKIP LOCKED`; owner and expiry checks govern completion or retry,
and expired claims become recoverable without duplicating completed actions.

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
