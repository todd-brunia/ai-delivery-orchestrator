import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { WORKFLOW_VERSION, type WorkItemEvent } from "../../src/domain/sprint-delivery/v1/index.js";
import { migrate, PostgresSprintRunRepository, type WorkItemTransitionRequest } from "../../src/persistence/index.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");
const pool = new Pool({ connectionString });
const repository = new PostgresSprintRunRepository(pool);

async function createRun() {
  const id = randomUUID();
  return repository.createRun(id, { workflowVersion: WORKFLOW_VERSION, repository: "todd-brunia/ai-consulting-client-portal", issueNumbers: [81, 82], mergePolicy: "human" });
}

function request(itemId: string, revision: number, event: WorkItemEvent): WorkItemTransitionRequest {
  return { workItemId: itemId, event, metadata: { transitionId: randomUUID(), aggregateId: itemId, expectedRevision: revision, idempotencyKey: `work-item:${randomUUID()}`, occurredAt: new Date().toISOString(), actor: { kind: "system", id: "integration-test" }, evidence: [{ kind: "policy", uri: "test://policy/v1" }] }, outbox: { id: randomUUID(), type: "projection.update", payload: { itemId }, idempotencyKey: `outbox:${randomUUID()}` } };
}

async function advance(itemId: string, events: readonly WorkItemEvent[], startRevision = 0) {
  let revision = startRevision;
  for (const event of events) {
    await repository.transitionWorkItem(request(itemId, revision, event));
    revision += 1;
  }
}

beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query(`TRUNCATE orchestrator.outbox, orchestrator.transitions, orchestrator.leases, orchestrator.conflict_domains, orchestrator.dependency_edges, orchestrator.work_items, orchestrator.sprint_runs CASCADE`));
afterAll(async () => pool.end());

describe("orchestration persistence primitives", () => {
  it("rejects cyclic analysis and atomically replaces valid analysis", async () => {
    const run = await createRun();
    await expect(repository.saveAnalysis(run.id, { dependencies: [
      { prerequisiteIssueNumber: 81, dependentIssueNumber: 82, kind: "blocks" },
      { prerequisiteIssueNumber: 82, dependentIssueNumber: 81, kind: "blocks" },
    ], conflicts: [] })).rejects.toThrow("cycle");
    await repository.saveAnalysis(run.id, { dependencies: [{ prerequisiteIssueNumber: 81, dependentIssueNumber: 82, kind: "blocks" }], conflicts: [{ issueNumber: 81, domains: [{ kind: "path", value: "src/auth", confidence: "high" }] }] });
    await repository.saveAnalysis(run.id, { dependencies: [], conflicts: [] });
    const counts = await pool.query<{ edges: string; domains: string }>(`SELECT (SELECT count(*) FROM orchestrator.dependency_edges)::text edges, (SELECT count(*) FROM orchestrator.conflict_domains)::text domains`);
    expect(counts.rows[0]).toEqual({ edges: "0", domains: "0" });
  });

  it("persists idempotent fail-closed work-item transitions", async () => {
    const run = await createRun();
    const item = run.workItems[0]!;
    const first = request(item.id, 0, "plan_available");
    await expect(repository.transitionWorkItem(first)).resolves.toMatchObject({ duplicate: false, workItem: { state: "feasibility_review", revision: 1 } });
    await expect(repository.transitionWorkItem(first)).resolves.toMatchObject({ duplicate: true, workItem: { revision: 1 } });
    await expect(repository.transitionWorkItem(request(item.id, 0, "build_authorized"))).rejects.toThrow("expected revision");
  });

  it("returns dependents only after every prerequisite merges", async () => {
    const run = await createRun();
    const [first, second] = run.workItems;
    await repository.saveAnalysis(run.id, { dependencies: [{ prerequisiteIssueNumber: 81, dependentIssueNumber: 82, kind: "blocks" }], conflicts: [] });
    const readyEvents: WorkItemEvent[] = ["plan_available", "build_authorized"];
    await advance(first!.id, readyEvents);
    await advance(second!.id, readyEvents);
    await expect(repository.listRunnableWorkItems(run.id)).resolves.toEqual([expect.objectContaining({ issueNumber: 81 })]);
    await advance(first!.id, ["build_dispatched", "build_started", "pull_request_opened", "checks_awaited", "review_started", "human_review_ready", "merged"], 2);
    await expect(repository.listRunnableWorkItems(run.id)).resolves.toEqual([expect.objectContaining({ issueNumber: 82 })]);
  });

  it("claims outbox actions exclusively and recovers retries and expired claims", async () => {
    const run = await createRun();
    await repository.transitionWorkItem(request(run.workItems[0]!.id, 0, "plan_available"));
    const now = new Date("2026-07-31T20:00:00Z");
    const claimed = await repository.claimOutbox("worker-a", 1, new Date("2026-07-31T20:01:00Z"), now);
    expect(claimed).toHaveLength(1);
    await expect(repository.claimOutbox("worker-b", 1, new Date("2026-07-31T20:01:00Z"), now)).resolves.toHaveLength(0);
    expect(await repository.retryOutbox(claimed[0]!.id, "worker-b", "wrong owner", now)).toBe(false);
    expect(await repository.retryOutbox(claimed[0]!.id, "worker-a", "temporary", now)).toBe(true);
    const retried = await repository.claimOutbox("worker-b", 1, new Date("2026-07-31T20:03:00Z"), new Date("2026-07-31T20:02:00Z"));
    expect(retried[0]?.attemptCount).toBe(2);
    expect(await repository.completeOutbox(retried[0]!.id, "worker-b", new Date("2026-07-31T20:02:30Z"))).toBe(true);
    await expect(repository.claimOutbox("worker-c", 1, new Date("2026-07-31T20:04:00Z"), new Date("2026-07-31T20:03:00Z"))).resolves.toHaveLength(0);
  });
});
