# AI Delivery Orchestrator

A governed AI delivery orchestrator that uses LangGraph, GitHub automation,
and AWS to sequence issues, coordinate AI builds, review pull requests, and
preserve human approval boundaries.

## Status

The repository is in its foundation phase. It currently provides a validated
TypeScript worker process, versioned provider-neutral `sprint-delivery/v1`
domain and state-machine contracts, container build, local runtime, tests, and
CI. It does not yet connect to GitHub, OpenAI, or AWS and cannot mutate another
repository.

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
[Threat model](./docs/threat-model.md), and
[Contributing](./CONTRIBUTING.md) before proposing changes.

## License and reuse

Copyright © 2026 Todd Brunia. All rights reserved. This private repository does
not grant permission to copy, modify, distribute, or operate the software.
