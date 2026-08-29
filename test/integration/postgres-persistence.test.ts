import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  WORKFLOW_VERSION,
  fingerprintAuthorization,
  RunAuthorizationSchema,
} from "../../src/domain/sprint-delivery/v1/index.js";
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
      orchestrator.workflow_node_results, orchestrator.work_item_planning_bindings,
      orchestrator.dispatch_attempts,
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

  it("round-trips an immutable automatic run authorization", async () => {
    const authorization = RunAuthorizationSchema.parse({
      schemaVersion: "run-authorization/v1",
      repository: "todd-brunia/ai-delivery-orchestrator",
      issueNumbers: [56],
      plans: [{ issueNumber: 56, planSha256: "a".repeat(64) }],
      defaultBranchSha: "b".repeat(40),
      policy: { version: "automatic-merge/v1", sha256: "c".repeat(64) },
      authorizedBy: { provider: "github", id: "user:1234" },
      authorizedAt: "2026-08-09T20:00:00-05:00",
    });
    const authorizationFingerprint = fingerprintAuthorization(authorization);
    const runId = randomUUID();
    await repository.createRun(runId, {
      workflowVersion: WORKFLOW_VERSION,
      repository: authorization.repository,
      issueNumbers: authorization.issueNumbers,
      mergePolicy: "automatic",
      authorization,
      authorizationFingerprint,
    });

    await expect(repository.getRun(runId)).resolves.toMatchObject({
      input: { mergePolicy: "automatic", authorization, authorizationFingerprint },
    });
    await expect(
      pool.query(
        "UPDATE orchestrator.sprint_runs SET authorization_fingerprint = $2 WHERE id = $1",
        [runId, "d".repeat(64)],
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

  it("persists an immutable planning binding only under the current work-item lease", async () => {
    const runId = await createRun();
    const workItem = (await repository.getRun(runId))?.workItems[0];
    if (!workItem) throw new Error("fixture work item is missing");
    const now = new Date("2026-08-29T20:00:00.000Z");
    await repository.tryAcquireLease({ aggregateType: "work_item", aggregateId: workItem.id, ownerId: "planner-a", expiresAt: new Date("2026-08-29T20:01:00.000Z") }, now);
    const request = { workItemId: workItem.id, fingerprint: "a".repeat(64), evidence: { plan: "github://issue/81/comment/1" }, observedAt: now.toISOString(), expectedWorkItemRevision: workItem.revision, leaseOwnerId: "planner-a" };
    await expect(repository.savePlanningBinding?.(request, now)).resolves.toMatchObject({ duplicate: false, binding: { fingerprint: request.fingerprint, workItemRevision: 0 } });
    await expect(repository.savePlanningBinding?.(request, now)).resolves.toMatchObject({ duplicate: true });
    await expect(repository.savePlanningBinding?.({ ...request, fingerprint: "b".repeat(64) }, now)).rejects.toBeInstanceOf(ConcurrencyError);
    await expect(repository.getPlanningBinding?.(workItem.id)).resolves.toMatchObject({ evidence: request.evidence });
  });

  it("stores deterministic workflow node output exactly once", async () => {
    const runId = await createRun();
    const workItem = (await repository.getRun(runId))?.workItems[0];
    if (!workItem) throw new Error("fixture work item is missing");
    const result = { workItemId: workItem.id, node: "collect_plans", idempotencyKey: "node-result:collect-plans:81", inputFingerprint: "c".repeat(64), output: { status: "bound" }, recordedAt: "2026-08-29T20:00:00.000Z" };
    await expect(repository.recordWorkflowNodeResult?.(result)).resolves.toEqual({ duplicate: false });
    await expect(repository.recordWorkflowNodeResult?.(result)).resolves.toEqual({ duplicate: true });
    await expect(repository.getWorkflowNodeResult?.(workItem.id, result.node, result.idempotencyKey)).resolves.toMatchObject(result);
  });

  it("persists accepted dispatches only with canonical workflow evidence", async () => {
    const runId = await createRun();
    const workItem = (await repository.getRun(runId))?.workItems[0];
    if (!workItem) throw new Error("fixture work item is missing");
    const attempt = { workItemId: workItem.id, intentFingerprint: "d".repeat(64), status: "accepted" as const, workflowRunId: "123", evidenceUri: "github://workflow-runs/123", recordedAt: "2026-08-29T20:00:00.000Z" };
    await expect(repository.recordDispatchAttempt?.(attempt)).resolves.toEqual({ duplicate: false });
    await expect(repository.recordDispatchAttempt?.(attempt)).resolves.toEqual({ duplicate: true });
    await expect(repository.getDispatchAttempt?.(workItem.id, attempt.intentFingerprint)).resolves.toMatchObject(attempt);
    await expect(repository.recordDispatchAttempt?.({ workItemId: attempt.workItemId, intentFingerprint: "e".repeat(64), status: "accepted", recordedAt: attempt.recordedAt })).rejects.toThrow("requires canonical workflow evidence");
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
