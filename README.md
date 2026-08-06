# AI Delivery Orchestrator

A governed AI delivery orchestrator that uses LangGraph, GitHub automation,
and AWS to sequence issues, coordinate AI builds, review pull requests, and
preserve human approval boundaries.

## Status

The repository is in its foundation phase. It currently provides a validated
TypeScript worker process, versioned provider-neutral `sprint-delivery/v1`
domain and state-machine contracts, PostgreSQL workflow persistence, a
stub-only LangGraph feasibility, scheduling, and reconciliation dry-run runtime
with durable PostgreSQL checkpoints and authoritative scheduling records,
container build, local runtime, tests, and CI. It does not yet connect to
GitHub, OpenAI, or a deployed AWS environment and cannot mutate another repository. The
reviewed Terraform foundation supports protected GitHub OIDC plan/apply
workflows, networking, image storage, empty secret containers, bounded logs,
and cost guardrails. The pilot foundation is deployed and converges with a
no-op plan; application compute and data-plane infrastructure are not deployed.

The approved implementation direction is maintained in the private owner's
public planning repository:

- `ai-consulting-meta/plans/governed-codex-automation/`

## Local development

Requirements:

- Node.js 22
- npm
- Docker for container validation

Install and validate:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Start PostgreSQL, apply migrations, and run the integration suite:

```bash
docker compose up -d postgres
DATABASE_URL=postgresql://orchestrator:local-orchestrator@127.0.0.1:54329/orchestrator npm run db:migrate
DATABASE_URL=postgresql://orchestrator:local-orchestrator@127.0.0.1:54329/orchestrator npm run db:checkpoints
DATABASE_URL=postgresql://orchestrator:local-orchestrator@127.0.0.1:54329/orchestrator npm run test:integration
```

The Compose volume is intentionally durable. `docker compose stop postgres`
stops compute without deleting local workflow data.

Run the worker locally:

```bash
npm run dev
```

Build and run the container:

```bash
npm run docker:build
docker compose up
```

Copy `.env.example` to `.env` only for local overrides. Never commit `.env` or
credentials.

## Repository boundaries

- GitHub is the human-readable system of record.
- Domain state and policy will not depend directly on LangGraph checkpoint
  formats.
- Model execution will not receive GitHub publishing credentials.
- Infrastructure and external writes require explicit approved work.
- The initial release will prepare pull requests for human review and merge;
  automatic merge is a separately gated future capability.

See [Architecture](./docs/architecture.md),
[Threat model](./docs/threat-model.md),
[Local operating runbook](./docs/operating-runbook.md),
[Client AWS account foundation](./docs/client-aws-account-foundation.md),
[Terraform and AWS bootstrap](./docs/terraform-bootstrap.md), and
[Contributing](./CONTRIBUTING.md) before proposing changes.

Local provider composition is deliberately restricted to deterministic stubs.
The stubs accept registered fixtures, capture proposed GitHub writes as inert
intent, and fail closed when a fixture is missing. Real GitHub and OpenAI
providers require separately reviewed implementation and authority.

The internal `sprint-delivery/v1` runtime can load an existing run, collect
canonical issue fixtures, perform deterministic feasibility analysis, persist
validated dependency/conflict decisions, select at most two dependency- and
conflict-safe work items in issue-number order, re-read their canonical
fixtures for drift, and checkpoint each graph step. Label and implementation
dispatch actions are durable, idempotent proposals only; they are never sent
to the GitHub mutation port and work items remain `ready_to_build`.

With local PostgreSQL running, execute a sanitized fixture report with:

```bash
DATABASE_URL=postgresql://orchestrator:local-orchestrator@127.0.0.1:54329/orchestrator npm run dry-run:schedule -- path/to/fixture.json
```

This is a partial Phase 2 dry-run slice. It does not validate live target
repositories, execute external writes, deploy application compute, or complete
the end-to-end Phase 2 workflow.

## License and reuse

Copyright © 2026 Todd Brunia. All rights reserved. This private repository does
not grant permission to copy, modify, distribute, or operate the software.
