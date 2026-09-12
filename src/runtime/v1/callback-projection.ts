import { PutItemCommand } from "@aws-sdk/client-dynamodb";
import type { Pool } from "pg";
import type { DynamoProjectionClient } from "./dynamo-projection-writer.js";

/** Idempotent delivery-keyed events; a failed publication remains pending in PostgreSQL. */
export async function publishCallbackEvents(pool: Pool, client: DynamoProjectionClient, tableName: string): Promise<number> {
  const rows = await pool.query<{ delivery_id: string; run_id: string; disposition: string; reason_class: string; evidence: unknown; recorded_at: Date }>(
    `SELECT c.delivery_id,w.sprint_run_id AS run_id,c.disposition,c.reason_class,c.evidence,c.recorded_at
     FROM orchestrator.github_callback_results c JOIN orchestrator.work_items w ON w.id=c.work_item_id
     WHERE c.projected_at IS NULL ORDER BY c.recorded_at,c.delivery_id LIMIT 100`);
  for (const row of rows.rows) {
    await client.send(new PutItemCommand({ TableName: tableName, Item: {
      purposeKey: { S: `operator-read:GET /v1/runs/${row.run_id}/events` }, entityKey: { S: `callback:${row.delivery_id}` },
      sourceEventId: { S: row.delivery_id }, projectionAsOf: { S: row.recorded_at.toISOString() },
      valueJson: { S: JSON.stringify({ version: "callback-result/v1", deliveryId: row.delivery_id, disposition: row.disposition, reasonClass: row.reason_class, evidence: row.evidence }) },
    } }));
    await pool.query(`WITH published AS (
      UPDATE orchestrator.github_callback_results SET projected_at=clock_timestamp() WHERE delivery_id=$1 RETURNING semantic_key)
      UPDATE orchestrator.outbox SET status='completed',completed_at=clock_timestamp(),claimed_by=NULL,claim_expires_at=NULL
      WHERE action_type='projection.update' AND transition_id IN (
        SELECT t.id FROM orchestrator.transitions t,published p
        WHERE t.idempotency_key=ANY(ARRAY[p.semantic_key || ':build_started',p.semantic_key || ':pull_request_opened',p.semantic_key || ':checks_awaited',p.semantic_key || ':blocked']))`, [row.delivery_id]);
  }
  return rows.rowCount ?? 0;
}
