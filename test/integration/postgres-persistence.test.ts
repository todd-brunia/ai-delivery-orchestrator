import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { WORKFLOW_VERSION } from "../../src/domain/sprint-delivery/v1/index.js";
import {
  ConcurrencyError,
  migrate,
  PostgresSprintRunRepository,
  type RunTransitionRequest,
} from "../../src/persistence/index.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");

const pool = new Pool({ connectionString });
const repository = new PostgresSprintRunRepository(pool);

function transition(
  runId: string,
  expectedRevision: number,
  event: RunTransitionRequest["event"] = { type: "plan_collection_started" },
  idempotencyKey = `transition:${randomUUID()}`,
  outboxIdempotencyKey = `outbox:${randomUUID()}`,
): RunTransitionRequest {
  return {
    runId,
    event,
    metadata: {
      transitionId: randomUUID(),
      aggregateId: runId,
      expectedRevision,
      idempotencyKey,
      occurredAt: new Date().toISOString(),
      actor: { kind: "system", id: "integration-test" },
      evidence: [{ kind: "policy", uri: "test://policy/sprint-delivery-v1" }],
    },
    outbox: {
      id: randomUUID(),
      type: "projection.update",
      payload: { runId },
      idempotencyKey: outboxIdempotencyKey,
    },
  };
}

async function createRun(): Promise<string> {
  const id = randomUUID();
  await repository.createRun(id, {
    workflowVersion: WORKFLOW_VERSION,
    repository: "todd-brunia/ai-consulting-client-portal",
    issueNumbers: [81, 82, 83],
    mergePolicy: "human",
  });
  return id;
}

beforeAll(async () => {
  await migrate(pool);
  await migrate(pool);
});

beforeEach(async () => {
  await pool.query(`
    TRUNCATE orchestrator.outbox, orchestrator.transitions, orchestrator.leases,
      orchestrator.conflict_domains, orchestrator.dependency_edges,
      orchestrator.work_items, orchestrator.sprint_runs CASCADE
  `);
});

afterAll(async () => {
  await pool.end();
});

describe("PostgresSprintRunRepository", () => {
  it("persists and reconstructs an immutable sprint issue list", async () => {
    const runId = await createRun();
    const run = await repository.getRun(runId);

    expect(run).toMatchObject({
      id: runId,
      state: "accepted",
      revision: 0,
      input: { issueNumbers: [81, 82, 83], mergePolicy: "human" },
    });
    expect(run?.workItems.map((item) => item.issueNumber)).toEqual([81, 82, 83]);
    await expect(
      pool.query(
        "UPDATE orchestrator.sprint_runs SET issue_numbers = ARRAY[81, 82] WHERE id = $1",
        [runId],
      ),
    ).rejects.toMatchObject({ code: "23000" });
  });

  it("records a transition and outbox action atomically", async () => {
    const runId = await createRun();
    const request = transition(runId, 0);
    const result = await repository.transitionRun(request);

    expect(result).toMatchObject({ duplicate: false, run: { state: "collecting_plans", revision: 1 } });
    const counts = await pool.query<{ transitions: string; outbox: string }>(`
      SELECT
        (SELECT count(*) FROM orchestrator.transitions)::text AS transitions,
        (SELECT count(*) FROM orchestrator.outbox)::text AS outbox
    `);
    expect(counts.rows[0]).toEqual({ transitions: "1", outbox: "1" });
  });

  it("returns the original result for a duplicate idempotency key", async () => {
    const runId = await createRun();
    const request = transition(runId, 0);
    const singleConnectionPool = new Pool({ connectionString, max: 1 });
    const singleConnectionRepository = new PostgresSprintRunRepository(
      singleConnectionPool,
    );
    const duplicate = await (async () => {
      try {
        await singleConnectionRepository.transitionRun(request);
        return await singleConnectionRepository.transitionRun(request);
      } finally {
        await singleConnectionPool.end();
      }
    })();

    expect(duplicate).toMatchObject({ duplicate: true, run: { revision: 1 } });
    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM orchestrator.outbox",
    );
    expect(result.rows[0]?.count).toBe("1");
  });

  it("rejects an idempotency key reused for another aggregate", async () => {
    const firstRunId = await createRun();
    const secondRunId = await createRun();
    const first = transition(firstRunId, 0);
    await repository.transitionRun(first);
    const reused = transition(secondRunId, 0, undefined, first.metadata.idempotencyKey);

    await expect(repository.transitionRun(reused)).rejects.toBeInstanceOf(ConcurrencyError);
  });

  it("rejects stale revisions", async () => {
    const runId = await createRun();
    await repository.transitionRun(transition(runId, 0));
    await expect(repository.transitionRun(transition(runId, 0))).rejects.toBeInstanceOf(
      ConcurrencyError,
    );
  });

  it("rolls back state when the outbox insert fails", async () => {
    const runId = await createRun();
    const first = transition(runId, 0);
    await repository.transitionRun(first);
    const second = transition(
      runId,
      1,
      { type: "analysis_started" },
      `transition:${randomUUID()}`,
      first.outbox.idempotencyKey,
    );

    await expect(repository.transitionRun(second)).rejects.toMatchObject({ code: "23505" });
    await expect(repository.getRun(runId)).resolves.toMatchObject({
      state: "collecting_plans",
      revision: 1,
    });
  });

  it("excludes competing lease owners until expiry", async () => {
    const runId = await createRun();
    const now = new Date("2026-07-31T20:00:00.000Z");
    const expiresAt = new Date("2026-07-31T20:01:00.000Z");

    await expect(
      repository.tryAcquireLease(
        { aggregateType: "sprint_run", aggregateId: runId, ownerId: "worker-a", expiresAt },
        now,
      ),
    ).resolves.toBe(true);
    await expect(
      repository.tryAcquireLease(
        { aggregateType: "sprint_run", aggregateId: runId, ownerId: "worker-b", expiresAt },
        now,
      ),
    ).resolves.toBe(false);
    await expect(
      repository.tryAcquireLease(
        {
          aggregateType: "sprint_run",
          aggregateId: runId,
          ownerId: "worker-b",
          expiresAt: new Date("2026-07-31T20:03:00.000Z"),
        },
        new Date("2026-07-31T20:02:00.000Z"),
      ),
    ).resolves.toBe(true);
  });

  it("survives repository and connection-pool restart", async () => {
    const runId = await createRun();
    const restartedPool = new Pool({ connectionString });
    try {
      const restartedRepository = new PostgresSprintRunRepository(restartedPool);
      await expect(restartedRepository.getRun(runId)).resolves.toMatchObject({ id: runId });
    } finally {
      await restartedPool.end();
    }
  });
});
