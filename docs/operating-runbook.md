# Local Operating Runbook

## Scope and safety boundary

This runbook primarily covers the local foundation environment. The worker runs
with `PROVIDER_MODE=stub`; it has no GitHub or OpenAI credentials, makes no
provider network calls, and cannot mutate a repository. AWS runtime compute,
webhook HTTP ingress, and the operator API are not implemented. LangGraph
execution is available only through the internal stub-only dry-run runtime.

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

## PostgreSQL lifecycle

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
- Configuration errors fail startup. `PROVIDER_MODE` must remain `stub` until
  a separately reviewed issue enables a real adapter.

## Destructive local reset

`docker compose down --volumes` permanently deletes the local PostgreSQL named
volume and all locally persisted workflow history. Use it only when a complete
local reset is intentional and the data is confirmed disposable. A normal
cost/resource stop is `docker compose stop`, which preserves data.

## Escalation and evidence

Retain concise error messages, migration names, delivery IDs, transition IDs,
and commit SHAs. Do not copy raw webhook bodies, source content, credentials,
or model reasoning into logs or issues. Checkpoints retain only structured
workflow state and minimal issue correlation metadata, and follow the same
local retention boundary as application data. Stop and require human review
for an unknown migration checksum, conflicting idempotency fingerprint,
invalid signature, exhausted retry, or unexpected provider mode.
