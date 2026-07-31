import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import {
  SprintRunEventSchema,
  SprintRunInputSchema,
  SprintRunStateSchema,
  TransitionMetadataSchema,
  WorkItemStateSchema,
  transitionSprintRun,
} from "../domain/sprint-delivery/v1/index.js";
import {
  ConcurrencyError,
  type LeaseRequest,
  type PersistedSprintRun,
  type RunTransitionRequest,
  type RunTransitionResult,
  type SprintRunRepository,
} from "./contracts.js";

interface RunRow {
  id: string;
  workflow_version: string;
  repository: string;
  issue_numbers: number[];
  merge_policy: "human";
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
          (id, workflow_version, repository, issue_numbers, merge_policy, state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'accepted', $6, $6)`,
        [id, input.workflowVersion, input.repository, input.issueNumbers, input.mergePolicy, now],
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
    return {
      id: row.id,
      input: SprintRunInputSchema.parse({
        workflowVersion: row.workflow_version,
        repository: row.repository,
        issueNumbers: row.issue_numbers,
        mergePolicy: row.merge_policy,
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
