import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, PostgresSprintRunRepository } from "../../src/persistence/index.js";
import { PostgresCheckpointReceiptReader } from "../../src/persistence/checkpoint-receipts.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const repository = new PostgresSprintRunRepository(pool);
const name = "todd-brunia/ai-consulting-client-portal";
const reader = new PostgresCheckpointReceiptReader(pool);
beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE orchestrator.outbox, orchestrator.transitions, orchestrator.leases, orchestrator.conflict_domains, orchestrator.dependency_edges, orchestrator.work_items, orchestrator.sprint_runs CASCADE"));
afterAll(async () => pool.end());

it("reads all six record families from exact repository/issue lineage without writes", async () => {
  const zero = { work_items: "0", bindings: "0", dispatch_attempts: "0", accepted_dispatches: "0", outbox_intents: "0", mutation_receipts: "0" };
  await repository.createRun(randomUUID(), { workflowVersion: "sprint-delivery/v1", repository: "other/repository", issueNumbers: [142], mergePolicy: "human" });
  await repository.createRun(randomUUID(), { workflowVersion: "sprint-delivery/v1", repository: name, issueNumbers: [74], mergePolicy: "human" });
  expect(await reader.observe(name, 142)).toMatchObject({ status: "clear_at_observation", counts: zero });
  const run = await repository.createRun(randomUUID(), { workflowVersion: "sprint-delivery/v1", repository: name, issueNumbers: [142], mergePolicy: "human" });
  const item = run.workItems[0]!;
  expect((await reader.observe(name, 142)).counts).toEqual({ ...zero, work_items: "1" });
  await pool.query("INSERT INTO orchestrator.work_item_planning_bindings (work_item_id,fingerprint,evidence,observed_at,work_item_revision,created_at) VALUES ($1,$2,'{}',now(),0,now())", [item.id, "a".repeat(64)]);
  await pool.query("INSERT INTO orchestrator.dispatch_attempts (work_item_id,intent_fingerprint,status,workflow_run_id,evidence_uri,recorded_at) VALUES ($1,$2,'accepted','123','github://runs/123',now())", [item.id, "b".repeat(64)]);
  const outboxId = randomUUID();
  await repository.transitionWorkItem({ workItemId: item.id, event: "plan_available", metadata: { transitionId: randomUUID(), aggregateId: item.id, expectedRevision: 0, idempotencyKey: randomUUID(), occurredAt: new Date().toISOString(), actor: { kind: "system", id: "test" }, evidence: [{ kind: "policy", uri: "test://checkpoint" }] }, outbox: { id: outboxId, type: "projection.update", payload: {}, idempotencyKey: randomUUID() } });
  await pool.query("INSERT INTO orchestrator.github_mutation_receipts (outbox_id,attempt,operation,actor_role,intent_sha256,outcome,recorded_at) VALUES ($1,1,'set_labels','builder',$2,'completed',now())", [outboxId, "c".repeat(64)]);
  const first = await reader.observe(name, 142);
  expect(first).toMatchObject({ status: "records_present", counts: Object.fromEntries(Object.keys(zero).map(key => [key, "1"])) });
  expect((await reader.observe(name, 142)).counts).toEqual(first.counts);
  expect((await pool.query("SELECT count(*)::text AS count FROM orchestrator.work_items")).rows[0]).toEqual({ count: "3" });
});
