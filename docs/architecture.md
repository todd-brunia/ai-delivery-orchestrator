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
