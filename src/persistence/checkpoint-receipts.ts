import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { RepositoryNameSchema } from "../domain/sprint-delivery/v1/contracts.js";
import { ReceiptCountsSchema, type CheckpointReceiptPort, type ReceiptObservation } from "../domain/sprint-delivery/v1/checkpoint-evidence.js";

/** Exact fixture lineage, matching the reviewed six-family diagnostic. Never writes. */
export class PostgresCheckpointReceiptReader implements CheckpointReceiptPort {
  constructor(private readonly pool: Pick<Pool, "connect">, private readonly now: () => Date = () => new Date()) {}
  async observe(repository: string, issueNumber: number): Promise<ReceiptObservation> {
    RepositoryNameSchema.parse(repository); z.number().int().positive().parse(issueNumber);
    let client: PoolClient | undefined;
    let clean = false;
    try {
      client = await this.pool.connect();
      const observedAt = this.now().toISOString();
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout = '10000ms'");
      const result = await client.query(`WITH fixture AS (
        SELECT wi.id FROM orchestrator.work_items wi JOIN orchestrator.sprint_runs sr ON sr.id=wi.sprint_run_id
        WHERE sr.repository=$1 AND wi.issue_number=$2
      ), intents AS (
        SELECT o.id FROM orchestrator.outbox o JOIN orchestrator.transitions t ON t.id=o.transition_id
        JOIN fixture f ON f.id=t.aggregate_id AND t.aggregate_type='work_item'
      ) SELECT
        (SELECT count(*) FROM fixture)::text AS work_items,
        (SELECT count(*) FROM orchestrator.work_item_planning_bindings b JOIN fixture f ON f.id=b.work_item_id)::text AS bindings,
        (SELECT count(*) FROM orchestrator.dispatch_attempts a JOIN fixture f ON f.id=a.work_item_id)::text AS dispatch_attempts,
        (SELECT count(*) FROM orchestrator.dispatch_attempts a JOIN fixture f ON f.id=a.work_item_id WHERE a.status='accepted')::text AS accepted_dispatches,
        (SELECT count(*) FROM intents)::text AS outbox_intents,
        (SELECT count(*) FROM orchestrator.github_mutation_receipts r JOIN intents i ON i.id=r.outbox_id)::text AS mutation_receipts`, [repository, issueNumber]);
      const counts = ReceiptCountsSchema.parse(result.rows[0]);
      if (result.rows.length !== 1) throw new Error();
      await client.query("ROLLBACK"); clean = true;
      return { repository, issueNumber, observedAt, counts, status: Object.values(counts).every(value => value === "0") ? "clear_at_observation" : "records_present" };
    } catch { throw new Error("checkpoint receipt observation unavailable"); }
    finally { client?.release(!clean); }
  }
}
