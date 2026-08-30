import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import {
  SprintRunEventSchema,
  ConflictDomainSchema,
  DependencyEdgeSchema,
  SprintRunInputSchema,
  SprintRunStateSchema,
  TransitionMetadataSchema,
  WorkItemEventSchema,
  WorkItemStateSchema,
  transitionSprintRun,
  transitionWorkItem,
  assertAcyclicDependencies,
  ReconciliationReportSchema,
  SchedulingDecisionSchema,
  RunAuthorizationSchema,
  fingerprintAuthorization,
} from "../domain/sprint-delivery/v1/index.js";
import {
  ConcurrencyError,
  type LeaseRequest,
  type PersistedSprintRun,
  type PersistedWorkItem,
  type SprintAnalysis,
  type WorkItemTransitionRequest,
  type WorkItemTransitionResult,
  type ClaimedOutboxAction,
  type RunTransitionRequest,
  type RunTransitionResult,
  type SprintRunRepository,
  type PersistedSchedulingState,
  type PersistSchedulingRequest,
  type GitHubMutationReceipt,
  type SavePlanningBindingRequest,
  type PersistedPlanningBinding,
  type WorkflowNodeResult,
  type DispatchAttempt,
} from "./contracts.js";

interface RunRow {
  id: string;
  workflow_version: string;
  repository: string;
  issue_numbers: number[];
  merge_policy: "human" | "automatic";
  run_authorization: unknown;
  authorization_fingerprint: string | null;
  state: string;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

interface WorkItemRow {
  id: string;
  issue_number: number;
  state: string;
  revision: number;
}

function zArray(value: unknown): ReturnType<typeof ConflictDomainSchema.parse>[] {
  if (!Array.isArray(value)) throw new Error("persisted conflict domains must be an array");
  return value.map((domain) => ConflictDomainSchema.parse(domain));
}

export class PostgresSprintRunRepository implements SprintRunRepository {
  constructor(private readonly pool: Pool) {}

  async createRun(
    id: string,
    rawInput: Parameters<typeof SprintRunInputSchema.parse>[0],
    now = new Date(),
  ): Promise<PersistedSprintRun> {
    const input = SprintRunInputSchema.parse(rawInput);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO orchestrator.sprint_runs
          (id, workflow_version, repository, issue_numbers, merge_policy,
           run_authorization, authorization_fingerprint, state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'accepted', $8, $8)`,
        [
          id,
          input.workflowVersion,
          input.repository,
          input.issueNumbers,
          input.mergePolicy,
          input.mergePolicy === "automatic" ? JSON.stringify(input.authorization) : null,
          input.mergePolicy === "automatic" ? input.authorizationFingerprint : null,
          now,
        ],
      );
      for (const issueNumber of input.issueNumbers) {
        await client.query(
          `INSERT INTO orchestrator.work_items
            (id, sprint_run_id, issue_number, state, created_at, updated_at)
           VALUES ($1, $2, $3, 'discovered', $4, $4)`,
          [randomUUID(), id, issueNumber, now],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.requireRun(id);
  }

  async getRun(id: string): Promise<PersistedSprintRun | undefined> {
    const client = await this.pool.connect();
    try {
      return await this.loadRun(client, id);
    } finally {
      client.release();
    }
  }

  async transitionRun(request: RunTransitionRequest): Promise<RunTransitionResult> {
    const event = SprintRunEventSchema.parse(request.event);
    const metadata = TransitionMetadataSchema.parse(request.metadata);
    if (metadata.aggregateId !== request.runId) {
      throw new ConcurrencyError("transition aggregateId does not match runId");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const duplicate = await client.query<{ aggregate_id: string }>(
        "SELECT aggregate_id FROM orchestrator.transitions WHERE idempotency_key = $1",
        [metadata.idempotencyKey],
      );
      if (duplicate.rowCount === 1) {
        if (duplicate.rows[0]?.aggregate_id !== request.runId) {
          throw new ConcurrencyError("idempotency key belongs to another aggregate");
        }
        const run = await this.requireRunWithClient(client, request.runId);
        await client.query("COMMIT");
        return { run, duplicate: true };
      }

      const currentResult = await client.query<RunRow>(
        "SELECT * FROM orchestrator.sprint_runs WHERE id = $1 FOR UPDATE",
        [request.runId],
      );
      const current = currentResult.rows[0];
      if (!current) throw new Error(`sprint run not found: ${request.runId}`);
      if (current.revision !== metadata.expectedRevision) {
        throw new ConcurrencyError(
          `expected revision ${metadata.expectedRevision}, found ${current.revision}`,
        );
      }

      const fromState = SprintRunStateSchema.parse(current.state);
      const toState = transitionSprintRun(fromState, event);
      const nextRevision = current.revision + 1;
      await client.query(
        `INSERT INTO orchestrator.transitions
          (id, aggregate_type, aggregate_id, aggregate_revision, from_state, to_state,
           event, actor, evidence, idempotency_key, occurred_at)
         VALUES ($1, 'sprint_run', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          metadata.transitionId,
          request.runId,
          nextRevision,
          fromState,
          toState,
          JSON.stringify(event),
          JSON.stringify(metadata.actor),
          JSON.stringify(metadata.evidence),
          metadata.idempotencyKey,
          metadata.occurredAt,
        ],
      );
      await client.query(
        `UPDATE orchestrator.sprint_runs
         SET state = $2, revision = $3, updated_at = $4
         WHERE id = $1`,
        [request.runId, toState, nextRevision, metadata.occurredAt],
      );
      await client.query(
        `INSERT INTO orchestrator.outbox
          (id, transition_id, action_type, payload, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          request.outbox.id,
          metadata.transitionId,
          request.outbox.type,
          JSON.stringify(request.outbox.payload),
          request.outbox.idempotencyKey,
          metadata.occurredAt,
        ],
      );
      const run = await this.requireRunWithClient(client, request.runId);
      await client.query("COMMIT");
      return { run, duplicate: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async tryAcquireLease(request: LeaseRequest, now = new Date()): Promise<boolean> {
    if (request.expiresAt <= now) throw new Error("lease expiry must be in the future");
    const result = await this.pool.query(
      `INSERT INTO orchestrator.leases
        (aggregate_type, aggregate_id, owner_id, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (aggregate_type, aggregate_id) DO UPDATE
       SET owner_id = EXCLUDED.owner_id,
           expires_at = EXCLUDED.expires_at,
           updated_at = EXCLUDED.updated_at
       WHERE orchestrator.leases.expires_at <= $5
          OR orchestrator.leases.owner_id = EXCLUDED.owner_id
       RETURNING aggregate_id`,
      [
        request.aggregateType,
        request.aggregateId,
        request.ownerId,
        request.expiresAt,
        now,
      ],
    );
    return result.rowCount === 1;
  }

  async saveAnalysis(runId: string, analysis: SprintAnalysis): Promise<void> {
    const run = await this.requireRun(runId);
    const dependencies = analysis.dependencies.map((edge) => DependencyEdgeSchema.parse(edge));
    const conflicts = analysis.conflicts.map((entry) => ({
      issueNumber: entry.issueNumber,
      domains: entry.domains.map((domain) => ConflictDomainSchema.parse(domain)),
    }));
    assertAcyclicDependencies(run.input.issueNumbers, dependencies);
    const analyzedIssues = new Set(conflicts.map((entry) => entry.issueNumber));
    if (analyzedIssues.size !== conflicts.length ||
        [...analyzedIssues].some((issue) => !run.input.issueNumbers.includes(issue))) {
      throw new Error("conflict analysis must uniquely reference in-sprint issues");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM orchestrator.dependency_edges WHERE sprint_run_id = $1", [runId]);
      await client.query(`DELETE FROM orchestrator.conflict_domains
        WHERE work_item_id IN (SELECT id FROM orchestrator.work_items WHERE sprint_run_id = $1)`, [runId]);
      for (const edge of dependencies) await client.query(
        `INSERT INTO orchestrator.dependency_edges
         (sprint_run_id, prerequisite_issue_number, dependent_issue_number, kind)
         VALUES ($1, $2, $3, $4)`,
        [runId, edge.prerequisiteIssueNumber, edge.dependentIssueNumber, edge.kind],
      );
      for (const entry of conflicts) for (const domain of entry.domains) await client.query(
        `INSERT INTO orchestrator.conflict_domains (id, work_item_id, kind, value, confidence)
         SELECT $1, id, $2, $3, $4 FROM orchestrator.work_items
         WHERE sprint_run_id = $5 AND issue_number = $6`,
        [randomUUID(), domain.kind, domain.value, domain.confidence, runId, entry.issueNumber],
      );
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async transitionWorkItem(request: WorkItemTransitionRequest): Promise<WorkItemTransitionResult> {
    const event = WorkItemEventSchema.parse(request.event);
    const metadata = TransitionMetadataSchema.parse(request.metadata);
    if (metadata.aggregateId !== request.workItemId) throw new ConcurrencyError("transition aggregateId does not match workItemId");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const prior = await client.query<{ aggregate_id: string; aggregate_type: string }>("SELECT aggregate_id, aggregate_type FROM orchestrator.transitions WHERE idempotency_key = $1", [metadata.idempotencyKey]);
      if (prior.rowCount === 1) {
        if (prior.rows[0]?.aggregate_id !== request.workItemId || prior.rows[0]?.aggregate_type !== "work_item") throw new ConcurrencyError("idempotency key belongs to another aggregate");
        const workItem = await this.requireWorkItem(client, request.workItemId);
        await client.query("COMMIT");
        return { workItem, duplicate: true };
      }
      const result = await client.query<WorkItemRow>("SELECT id, issue_number, state, revision FROM orchestrator.work_items WHERE id = $1 FOR UPDATE", [request.workItemId]);
      const row = result.rows[0];
      if (!row) throw new Error(`work item not found: ${request.workItemId}`);
      if (row.revision !== metadata.expectedRevision) throw new ConcurrencyError(`expected revision ${metadata.expectedRevision}, found ${row.revision}`);
      const from = WorkItemStateSchema.parse(row.state);
      const to = transitionWorkItem(from, event);
      const revision = row.revision + 1;
      await client.query(`INSERT INTO orchestrator.transitions
        (id, aggregate_type, aggregate_id, aggregate_revision, from_state, to_state, event, actor, evidence, idempotency_key, occurred_at)
        VALUES ($1, 'work_item', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [metadata.transitionId, request.workItemId, revision, from, to, JSON.stringify(event), JSON.stringify(metadata.actor), JSON.stringify(metadata.evidence), metadata.idempotencyKey, metadata.occurredAt]);
      await client.query("UPDATE orchestrator.work_items SET state = $2, revision = $3, updated_at = $4 WHERE id = $1", [request.workItemId, to, revision, metadata.occurredAt]);
      await client.query(`INSERT INTO orchestrator.outbox (id, transition_id, action_type, payload, idempotency_key, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)`, [request.outbox.id, metadata.transitionId, request.outbox.type, JSON.stringify(request.outbox.payload), request.outbox.idempotencyKey, metadata.occurredAt]);
      const workItem = await this.requireWorkItem(client, request.workItemId);
      await client.query("COMMIT");
      return { workItem, duplicate: false };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async listRunnableWorkItems(runId: string): Promise<readonly PersistedWorkItem[]> {
    const result = await this.pool.query<WorkItemRow>(`SELECT wi.id, wi.issue_number, wi.state, wi.revision
      FROM orchestrator.work_items wi WHERE wi.sprint_run_id = $1 AND wi.state = 'ready_to_build'
      AND NOT EXISTS (SELECT 1 FROM orchestrator.dependency_edges de
        JOIN orchestrator.work_items prerequisite ON prerequisite.sprint_run_id = de.sprint_run_id
          AND prerequisite.issue_number = de.prerequisite_issue_number
        WHERE de.sprint_run_id = wi.sprint_run_id AND de.dependent_issue_number = wi.issue_number
          AND prerequisite.state <> 'merged') ORDER BY wi.issue_number`, [runId]);
    return result.rows.map((row) => this.mapWorkItem(row));
  }

  async loadSchedulingState(runId: string): Promise<PersistedSchedulingState> {
    await this.requireRun(runId);
    const [dependencies, items] = await Promise.all([
      this.pool.query<{ prerequisite_issue_number: number; dependent_issue_number: number; kind: "blocks" }>(
        "SELECT prerequisite_issue_number, dependent_issue_number, kind FROM orchestrator.dependency_edges WHERE sprint_run_id = $1 ORDER BY prerequisite_issue_number, dependent_issue_number", [runId]),
      this.pool.query<WorkItemRow & { domains: unknown }>(`SELECT wi.id, wi.issue_number, wi.state, wi.revision,
        COALESCE(jsonb_agg(jsonb_build_object('kind', cd.kind, 'value', cd.value, 'confidence', cd.confidence))
          FILTER (WHERE cd.id IS NOT NULL), '[]'::jsonb) AS domains
        FROM orchestrator.work_items wi LEFT JOIN orchestrator.conflict_domains cd ON cd.work_item_id = wi.id
        WHERE wi.sprint_run_id = $1 GROUP BY wi.id ORDER BY wi.issue_number`, [runId]),
    ]);
    return {
      dependencies: dependencies.rows.map((row) => DependencyEdgeSchema.parse({ prerequisiteIssueNumber: row.prerequisite_issue_number, dependentIssueNumber: row.dependent_issue_number, kind: row.kind })),
      conflicts: items.rows.map((row) => ({ issueNumber: row.issue_number, domains: zArray(row.domains) })),
      workItems: items.rows.map((row) => ({ ...this.mapWorkItem(row), conflictDomains: zArray(row.domains) })),
    };
  }

  async persistDryRunScheduling(raw: PersistSchedulingRequest): Promise<{ readonly duplicate: boolean }> {
    const decision = SchedulingDecisionSchema.parse(raw.decision);
    const reconciliation = ReconciliationReportSchema.parse(raw.reconciliation);
    if (decision.runId !== reconciliation.runId) throw new Error("schedule and reconciliation run ids must match");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const run = await client.query<{ revision: number }>("SELECT revision FROM orchestrator.sprint_runs WHERE id = $1 FOR UPDATE", [decision.runId]);
      if (!run.rows[0]) throw new Error(`sprint run not found: ${decision.runId}`);
      const existing = await client.query("SELECT run_id FROM orchestrator.schedule_decisions WHERE run_id = $1", [decision.runId]);
      if (existing.rowCount === 1) { await client.query("COMMIT"); return { duplicate: true }; }
      if (run.rows[0].revision !== raw.expectedRunRevision) throw new ConcurrencyError(`expected revision ${raw.expectedRunRevision}, found ${run.rows[0].revision}`);
      await client.query("INSERT INTO orchestrator.schedule_decisions (run_id, run_revision, decision, created_at) VALUES ($1, $2, $3, $4)", [decision.runId, raw.expectedRunRevision, JSON.stringify(decision), reconciliation.reconciledAt]);
      await client.query("INSERT INTO orchestrator.reconciliation_reports (run_id, report, created_at) VALUES ($1, $2, $3)", [decision.runId, JSON.stringify(reconciliation), reconciliation.reconciledAt]);
      for (const action of decision.proposedActions) await client.query(`INSERT INTO orchestrator.proposed_actions
        (idempotency_key, run_id, issue_number, action_type, payload, created_at) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (idempotency_key) DO NOTHING`, [action.idempotencyKey, decision.runId, action.issueNumber, action.type, JSON.stringify(action.parameters), reconciliation.reconciledAt]);
      await client.query("COMMIT");
      return { duplicate: false };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async claimOutbox(ownerId: string, limit: number, expiresAt: Date, now = new Date(), actionTypes?: readonly string[]): Promise<readonly ClaimedOutboxAction[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || expiresAt <= now || (actionTypes && (actionTypes.length === 0 || actionTypes.some((type) => !/^[a-z][a-z0-9._-]{1,100}$/.test(type))))) throw new Error("invalid outbox claim");
    const result = await this.pool.query<{ id: string; action_type: string; payload: Record<string, unknown>; idempotency_key: string; attempt_count: number; claim_expires_at: Date }>(`WITH candidates AS (
      SELECT id FROM orchestrator.outbox WHERE (status = 'pending' OR (status = 'claimed' AND claim_expires_at <= $3)) AND ($5::text[] IS NULL OR action_type = ANY($5))
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1)
      UPDATE orchestrator.outbox o SET status = 'claimed', claimed_by = $2, claim_expires_at = $4,
        attempt_count = attempt_count + 1 FROM candidates WHERE o.id = candidates.id
      RETURNING o.id, o.action_type, o.payload, o.idempotency_key, o.attempt_count, o.claim_expires_at`, [limit, ownerId, now, expiresAt, actionTypes ? [...actionTypes] : null]);
    return result.rows.map((row) => ({ id: row.id, type: row.action_type, payload: row.payload, idempotencyKey: row.idempotency_key, attemptCount: row.attempt_count, claimExpiresAt: row.claim_expires_at.toISOString() }));
  }

  async completeOutbox(id: string, ownerId: string, now = new Date()): Promise<boolean> {
    const result = await this.pool.query("UPDATE orchestrator.outbox SET status = 'completed', completed_at = $3, claimed_by = NULL, claim_expires_at = NULL WHERE id = $1 AND status = 'claimed' AND claimed_by = $2 AND claim_expires_at > $3", [id, ownerId, now]);
    return result.rowCount === 1;
  }

  async retryOutbox(id: string, ownerId: string, error: string, now = new Date()): Promise<boolean> {
    const result = await this.pool.query("UPDATE orchestrator.outbox SET status = 'pending', last_error = $3, claimed_by = NULL, claim_expires_at = NULL WHERE id = $1 AND status = 'claimed' AND claimed_by = $2 AND claim_expires_at > $4", [id, ownerId, error.slice(0, 4000), now]);
    return result.rowCount === 1;
  }

  async blockOutbox(id: string, ownerId: string, error: string, now = new Date()): Promise<boolean> {
    const result = await this.pool.query("UPDATE orchestrator.outbox SET status = 'failed', last_error = $3, claimed_by = NULL, claim_expires_at = NULL WHERE id = $1 AND status = 'claimed' AND claimed_by = $2 AND claim_expires_at > $4", [id, ownerId, error.slice(0, 4000), now]);
    return result.rowCount === 1;
  }

  async recordGitHubMutationReceipt(receipt: GitHubMutationReceipt): Promise<void> {
    await this.pool.query(`INSERT INTO orchestrator.github_mutation_receipts
      (outbox_id, attempt, operation, actor_role, intent_sha256, outcome, request_id, error_class, recorded_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (outbox_id, attempt) DO NOTHING`, [receipt.outboxId, receipt.attempt, receipt.operation, receipt.actorRole, receipt.intentSha256, receipt.outcome, receipt.requestId ?? null, receipt.errorClass ?? null, receipt.recordedAt]);
  }

  async savePlanningBinding(raw: SavePlanningBindingRequest, now = new Date()): Promise<{ readonly binding: PersistedPlanningBinding; readonly duplicate: boolean }> {
    if (!/^[a-f0-9]{64}$/.test(raw.fingerprint)) throw new Error("planning binding fingerprint is invalid");
    const observedAt = new Date(raw.observedAt);
    if (!Number.isFinite(observedAt.getTime())) throw new Error("planning binding observation time is invalid");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const item = await client.query<WorkItemRow>("SELECT id, issue_number, state, revision FROM orchestrator.work_items WHERE id = $1 FOR UPDATE", [raw.workItemId]);
      const row = item.rows[0];
      if (!row) throw new Error(`work item not found: ${raw.workItemId}`);
      if (row.revision !== raw.expectedWorkItemRevision) throw new ConcurrencyError(`expected revision ${raw.expectedWorkItemRevision}, found ${row.revision}`);
      const lease = await client.query("SELECT 1 FROM orchestrator.leases WHERE aggregate_type = 'work_item' AND aggregate_id = $1 AND owner_id = $2 AND expires_at > $3", [raw.workItemId, raw.leaseOwnerId, now]);
      if (lease.rowCount !== 1) throw new ConcurrencyError("planning binding lease is absent or expired");
      const existing = await client.query<{ fingerprint: string; evidence: Record<string, unknown>; observed_at: Date; work_item_revision: number; created_at: Date }>("SELECT fingerprint, evidence, observed_at, work_item_revision, created_at FROM orchestrator.work_item_planning_bindings WHERE work_item_id = $1", [raw.workItemId]);
      if (existing.rowCount === 1) {
        const value = existing.rows[0]!;
        if (value.fingerprint !== raw.fingerprint) throw new ConcurrencyError("immutable planning binding already exists with another fingerprint");
        await client.query("COMMIT");
        return { duplicate: true, binding: { workItemId: raw.workItemId, fingerprint: value.fingerprint, evidence: value.evidence, observedAt: value.observed_at.toISOString(), workItemRevision: value.work_item_revision, createdAt: value.created_at.toISOString() } };
      }
      await client.query("INSERT INTO orchestrator.work_item_planning_bindings (work_item_id, fingerprint, evidence, observed_at, work_item_revision, created_at) VALUES ($1,$2,$3,$4,$5,$6)", [raw.workItemId, raw.fingerprint, JSON.stringify(raw.evidence), observedAt, row.revision, now]);
      await client.query("COMMIT");
      return { duplicate: false, binding: { workItemId: raw.workItemId, fingerprint: raw.fingerprint, evidence: raw.evidence, observedAt: observedAt.toISOString(), workItemRevision: row.revision, createdAt: now.toISOString() } };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async getPlanningBinding(workItemId: string): Promise<PersistedPlanningBinding | undefined> {
    const result = await this.pool.query<{ fingerprint: string; evidence: Record<string, unknown>; observed_at: Date; work_item_revision: number; created_at: Date }>("SELECT fingerprint, evidence, observed_at, work_item_revision, created_at FROM orchestrator.work_item_planning_bindings WHERE work_item_id = $1", [workItemId]);
    const row = result.rows[0];
    return row ? { workItemId, fingerprint: row.fingerprint, evidence: row.evidence, observedAt: row.observed_at.toISOString(), workItemRevision: row.work_item_revision, createdAt: row.created_at.toISOString() } : undefined;
  }

  async recordWorkflowNodeResult(raw: WorkflowNodeResult): Promise<{ readonly duplicate: boolean }> {
    if (!/^[a-f0-9]{64}$/.test(raw.inputFingerprint) || !/^[a-z][a-z0-9_]{1,100}$/.test(raw.node)) throw new Error("workflow node result is invalid");
    const result = await this.pool.query(`INSERT INTO orchestrator.workflow_node_results (work_item_id, node, idempotency_key, input_fingerprint, output, recorded_at)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (work_item_id, node, idempotency_key) DO NOTHING`, [raw.workItemId, raw.node, raw.idempotencyKey, raw.inputFingerprint, JSON.stringify(raw.output), raw.recordedAt]);
    return { duplicate: result.rowCount === 0 };
  }

  async getWorkflowNodeResult(workItemId: string, node: string, idempotencyKey: string): Promise<WorkflowNodeResult | undefined> {
    const result = await this.pool.query<{ input_fingerprint: string; output: Record<string, unknown>; recorded_at: Date }>("SELECT input_fingerprint, output, recorded_at FROM orchestrator.workflow_node_results WHERE work_item_id = $1 AND node = $2 AND idempotency_key = $3", [workItemId, node, idempotencyKey]);
    const row = result.rows[0];
    return row ? { workItemId, node, idempotencyKey, inputFingerprint: row.input_fingerprint, output: row.output, recordedAt: row.recorded_at.toISOString() } : undefined;
  }

  async recordDispatchAttempt(raw: DispatchAttempt): Promise<{ readonly duplicate: boolean }> {
    if (!/^[a-f0-9]{64}$/.test(raw.intentFingerprint)) throw new Error("dispatch intent fingerprint is invalid");
    if (raw.status === "accepted" && (!raw.workflowRunId || !raw.evidenceUri)) throw new Error("accepted dispatch requires canonical workflow evidence");
    if (raw.status !== "accepted" && (raw.workflowRunId || raw.evidenceUri)) throw new Error("only accepted dispatches may retain workflow evidence");
    const result = await this.pool.query(`INSERT INTO orchestrator.dispatch_attempts
      (work_item_id, intent_fingerprint, status, workflow_run_id, evidence_uri, recorded_at)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (work_item_id, intent_fingerprint) DO UPDATE SET
        status = EXCLUDED.status, workflow_run_id = EXCLUDED.workflow_run_id,
        evidence_uri = EXCLUDED.evidence_uri, recorded_at = EXCLUDED.recorded_at
      WHERE orchestrator.dispatch_attempts.status <> 'accepted'
        AND NOT (orchestrator.dispatch_attempts.status IN ('ambiguous', 'blocked') AND EXCLUDED.status IN ('proposed', 'claimed'))`, [raw.workItemId, raw.intentFingerprint, raw.status, raw.workflowRunId ?? null, raw.evidenceUri ?? null, raw.recordedAt]);
    return { duplicate: result.rowCount === 0 };
  }

  async getDispatchAttempt(workItemId: string, intentFingerprint: string): Promise<DispatchAttempt | undefined> {
    const result = await this.pool.query<{ status: DispatchAttempt["status"]; workflow_run_id: string | null; evidence_uri: string | null; recorded_at: Date }>("SELECT status, workflow_run_id, evidence_uri, recorded_at FROM orchestrator.dispatch_attempts WHERE work_item_id = $1 AND intent_fingerprint = $2", [workItemId, intentFingerprint]);
    const row = result.rows[0];
    return row ? { workItemId, intentFingerprint, status: row.status, ...(row.workflow_run_id ? { workflowRunId: row.workflow_run_id } : {}), ...(row.evidence_uri ? { evidenceUri: row.evidence_uri } : {}), recordedAt: row.recorded_at.toISOString() } : undefined;
  }

  private mapWorkItem(row: WorkItemRow): PersistedWorkItem {
    return { id: row.id, issueNumber: row.issue_number, state: WorkItemStateSchema.parse(row.state), revision: row.revision };
  }

  private async requireWorkItem(client: PoolClient, id: string): Promise<PersistedWorkItem> {
    const result = await client.query<WorkItemRow>("SELECT id, issue_number, state, revision FROM orchestrator.work_items WHERE id = $1", [id]);
    const row = result.rows[0];
    if (!row) throw new Error(`work item not found: ${id}`);
    return this.mapWorkItem(row);
  }

  private async requireRun(id: string): Promise<PersistedSprintRun> {
    const run = await this.getRun(id);
    if (!run) throw new Error(`sprint run not found: ${id}`);
    return run;
  }

  private async requireRunWithClient(
    client: PoolClient,
    id: string,
  ): Promise<PersistedSprintRun> {
    const run = await this.loadRun(client, id);
    if (!run) throw new Error(`sprint run not found: ${id}`);
    return run;
  }

  private async loadRun(
    client: PoolClient,
    id: string,
  ): Promise<PersistedSprintRun | undefined> {
    const result = await client.query<RunRow>(
      "SELECT * FROM orchestrator.sprint_runs WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const workItems = await client.query<WorkItemRow>(
      `SELECT id, issue_number, state, revision
       FROM orchestrator.work_items WHERE sprint_run_id = $1 ORDER BY issue_number`,
      [id],
    );
    const automaticFields = (() => {
      if (row.merge_policy === "human") {
        if (row.run_authorization !== null || row.authorization_fingerprint !== null) {
          throw new Error("persisted human run contains automatic authorization");
        }
        return { mergePolicy: "human" as const };
      }
      const authorization = RunAuthorizationSchema.parse(row.run_authorization);
      const fingerprint = fingerprintAuthorization(authorization);
      if (row.authorization_fingerprint !== fingerprint) {
        throw new Error("persisted authorization fingerprint mismatch");
      }
      return {
        mergePolicy: "automatic" as const,
        authorization,
        authorizationFingerprint: fingerprint,
      };
    })();
    return {
      id: row.id,
      input: SprintRunInputSchema.parse({
        workflowVersion: row.workflow_version,
        repository: row.repository,
        issueNumbers: row.issue_numbers,
        ...automaticFields,
      }),
      state: SprintRunStateSchema.parse(row.state),
      revision: row.revision,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      workItems: workItems.rows.map((item) => ({
        id: item.id,
        issueNumber: item.issue_number,
        state: WorkItemStateSchema.parse(item.state),
        revision: item.revision,
      })),
    };
  }
}
