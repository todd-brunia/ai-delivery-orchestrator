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
