import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { WORKFLOW_VERSION } from "../../src/domain/sprint-delivery/v1/index.js";
import { migrate, PostgresSprintRunRepository } from "../../src/persistence/index.js";
import { PROVIDER_CONTRACT_VERSION, StubGitHubMutationAdapter, StubGitHubReadAdapter, StubModelAnalysisAdapter } from "../../src/providers/v1/index.js";
import { CHECKPOINT_SCHEMA, createSprintDeliveryV1Runtime, setupPostgresCheckpoints } from "../../src/workflows/index.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");
const pool = new Pool({ connectionString });
const repository = new PostgresSprintRunRepository(pool);
const repositoryName = "todd-brunia/ai-consulting-client-portal";
const hash = "b".repeat(64);
const sha = "a".repeat(40);

function providers(issueNumbers: readonly number[]) {
  const githubRead = new StubGitHubReadAdapter();
  for (const number of issueNumbers) githubRead.registerIssue({ version: PROVIDER_CONTRACT_VERSION, repository: repositoryName, number, nodeId: `I_${number}`, title: `Issue ${number}`, body: "Plan", state: "open", labels: ["plan-ready"], updatedAt: "2026-08-05T12:00:00Z" });
  const modelAnalysis = new StubModelAnalysisAdapter();
  const fingerprints = Object.fromEntries(issueNumbers.map((number) => [String(number), hash]));
  const key = Object.values(fingerprints).sort().join(":");
  modelAnalysis.registerFeasibility(key, { feasible: true, dependencies: [], conflicts: issueNumbers.map((issueNumber) => ({ issueNumber, domains: [] })), risk: { categories: ["ordinary"], confidence: "high", rationale: "fixture" }, unresolvedDecisions: [], evidenceUris: issueNumbers.map((number) => `issue://${number}`), provenance: { model: "stub", modelVersion: "fixture-v1", policyVersion: WORKFLOW_VERSION, artifactSha256: hash, usage: { inputTokens: 0, outputTokens: 0 } } });
  return { providerSet: { githubRead, githubMutation: new StubGitHubMutationAdapter(), modelAnalysis }, fingerprints };
}

async function createRun(issueNumbers: readonly number[]) {
  const runId = randomUUID();
  await repository.createRun(runId, { workflowVersion: WORKFLOW_VERSION, repository: repositoryName, issueNumbers: [...issueNumbers], mergePolicy: "human" });
  return runId;
}

function request(runId: string, threadId: string, fingerprints: Record<string, string>) {
  return { workflowVersion: WORKFLOW_VERSION, providerMode: "stub" as const, runId, threadId, defaultBranchSha: sha, planFingerprints: fingerprints, occurredAt: "2026-08-05T12:00:00Z" };
}

beforeAll(async () => {
  await migrate(pool);
  await setupPostgresCheckpoints(pool);
  await setupPostgresCheckpoints(pool);
});
beforeEach(async () => {
  await pool.query(`TRUNCATE orchestrator.outbox, orchestrator.transitions, orchestrator.leases, orchestrator.conflict_domains, orchestrator.dependency_edges, orchestrator.work_items, orchestrator.sprint_runs CASCADE`);
  await pool.query(`TRUNCATE ${CHECKPOINT_SCHEMA}.checkpoints, ${CHECKPOINT_SCHEMA}.checkpoint_blobs, ${CHECKPOINT_SCHEMA}.checkpoint_writes CASCADE`);
});
afterAll(async () => pool.end());

describe("PostgreSQL LangGraph checkpoints", () => {
  it("sets up a separate checkpoint schema repeatably", async () => {
    const schemas = await pool.query<{ schema_name: string }>("SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1", [CHECKPOINT_SCHEMA]);
    expect(schemas.rows).toEqual([{ schema_name: CHECKPOINT_SCHEMA }]);
  });

  it("resumes after every node boundary and persists application effects once", async () => {
    const runId = await createRun([81]);
    const fixture = providers([81]);
    const checkpointer = await setupPostgresCheckpoints(pool);
    const runtime = createSprintDeliveryV1Runtime(repository, fixture.providerSet, checkpointer, { interruptAfter: ["load_run", "collect_issues", "analyze"] });
    await expect(runtime.execute(request(runId, `resume:${runId}`, fixture.fingerprints))).rejects.toThrow("interrupted");
    await expect(runtime.resume(`resume:${runId}`)).rejects.toThrow("interrupted");
    await expect(runtime.resume(`resume:${runId}`)).rejects.toThrow("interrupted");
    await expect(runtime.resume(`resume:${runId}`)).resolves.toMatchObject({ status: "active" });
    const counts = await pool.query<{ transitions: string; outbox: string }>("SELECT (SELECT count(*) FROM orchestrator.transitions)::text transitions, (SELECT count(*) FROM orchestrator.outbox)::text outbox");
    expect(counts.rows[0]).toEqual({ transitions: "5", outbox: "5" });
    await expect(runtime.resume(`resume:${runId}`)).resolves.toMatchObject({ status: "active" });
    const replayCounts = await pool.query<{ transitions: string; outbox: string }>("SELECT (SELECT count(*) FROM orchestrator.transitions)::text transitions, (SELECT count(*) FROM orchestrator.outbox)::text outbox");
    expect(replayCounts.rows[0]).toEqual(counts.rows[0]);
  });

  it("isolates concurrent sprint threads", async () => {
    const first = await createRun([81]);
    const second = await createRun([82]);
    const firstFixture = providers([81]);
    const secondFixture = providers([82]);
    const [firstResult, secondResult] = await Promise.all([
      createSprintDeliveryV1Runtime(repository, firstFixture.providerSet, await setupPostgresCheckpoints(pool)).execute(request(first, `run:${first}`, firstFixture.fingerprints)),
      createSprintDeliveryV1Runtime(repository, secondFixture.providerSet, await setupPostgresCheckpoints(pool)).execute(request(second, `run:${second}`, secondFixture.fingerprints)),
    ]);
    expect(new Set([firstResult.runId, secondResult.runId])).toEqual(new Set([first, second]));
    const threadCount = await pool.query<{ count: string }>(`SELECT count(DISTINCT thread_id)::text count FROM ${CHECKPOINT_SCHEMA}.checkpoints`);
    expect(threadCount.rows[0]?.count).toBe("2");
  });
});
