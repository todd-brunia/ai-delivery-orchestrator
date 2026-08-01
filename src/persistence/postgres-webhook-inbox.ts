import type { Pool } from "pg";

import { NormalizedGitHubEventSchema, type NormalizedGitHubEvent } from "../github/webhooks/v1/index.js";

export interface InboxAcceptance { readonly event: NormalizedGitHubEvent; readonly duplicate: boolean; }
export interface ClaimedInboxEvent { readonly event: NormalizedGitHubEvent; readonly attemptCount: number; readonly claimExpiresAt: string; }

interface InboxRow { normalized_event: unknown; attempt_count: number; claim_expires_at: Date; }

export class PostgresWebhookInbox {
  constructor(private readonly pool: Pool) {}

  async accept(rawEvent: NormalizedGitHubEvent): Promise<InboxAcceptance> {
    const event = NormalizedGitHubEventSchema.parse(rawEvent);
    const result = await this.pool.query(
      `INSERT INTO orchestrator.github_webhook_inbox
       (delivery_id, event_name, action, hook_id, installation_id, repository,
        sender_login, payload_sha256, normalized_event, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`,
      [event.deliveryId, event.eventName, event.action, event.hookId, event.installationId,
       event.repository ?? null, event.senderLogin, event.payloadSha256,
       JSON.stringify(event), event.receivedAt],
    );
    if (result.rowCount === 1) return { event, duplicate: false };
    const existing = await this.pool.query<{ normalized_event: unknown }>(
      "SELECT normalized_event FROM orchestrator.github_webhook_inbox WHERE delivery_id = $1", [event.deliveryId],
    );
    const prior = NormalizedGitHubEventSchema.parse(existing.rows[0]?.normalized_event);
    if (prior.payloadSha256 !== event.payloadSha256) throw new Error("delivery ID payload fingerprint mismatch");
    return { event: prior, duplicate: true };
  }

  async claim(ownerId: string, limit: number, expiresAt: Date, maxAttempts: number, now = new Date()): Promise<readonly ClaimedInboxEvent[]> {
    if (!ownerId || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isInteger(maxAttempts) || maxAttempts < 1 || expiresAt <= now) throw new Error("invalid inbox claim");
    await this.pool.query(`UPDATE orchestrator.github_webhook_inbox SET status = 'dead_letter',
      claimed_by = NULL, claim_expires_at = NULL, dead_lettered_at = $1
      WHERE status IN ('pending','claimed') AND attempt_count >= $2
        AND (status = 'pending' OR claim_expires_at <= $1)`, [now, maxAttempts]);
    const result = await this.pool.query<InboxRow>(`WITH candidates AS (
      SELECT delivery_id FROM orchestrator.github_webhook_inbox
      WHERE attempt_count < $5 AND (status = 'pending' OR (status = 'claimed' AND claim_expires_at <= $3))
      ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT $1)
      UPDATE orchestrator.github_webhook_inbox i SET status = 'claimed', claimed_by = $2,
        claim_expires_at = $4, attempt_count = attempt_count + 1
      FROM candidates WHERE i.delivery_id = candidates.delivery_id
      RETURNING i.normalized_event, i.attempt_count, i.claim_expires_at`,
      [limit, ownerId, now, expiresAt, maxAttempts]);
    return result.rows.map((row) => ({ event: NormalizedGitHubEventSchema.parse(row.normalized_event), attemptCount: row.attempt_count, claimExpiresAt: row.claim_expires_at.toISOString() }));
  }

  async complete(deliveryId: string, ownerId: string, now = new Date()): Promise<boolean> {
    const result = await this.pool.query(`UPDATE orchestrator.github_webhook_inbox
      SET status='completed', completed_at=$3, claimed_by=NULL, claim_expires_at=NULL
      WHERE delivery_id=$1 AND status='claimed' AND claimed_by=$2 AND claim_expires_at>$3`, [deliveryId, ownerId, now]);
    return result.rowCount === 1;
  }

  async retry(deliveryId: string, ownerId: string, error: string, maxAttempts: number, now = new Date()): Promise<"pending" | "dead_letter" | "not_owned"> {
    const result = await this.pool.query<{ status: "pending" | "dead_letter" }>(`UPDATE orchestrator.github_webhook_inbox
      SET status=CASE WHEN attempt_count >= $4 THEN 'dead_letter' ELSE 'pending' END,
        last_error=$3, dead_lettered_at=CASE WHEN attempt_count >= $4 THEN $5 ELSE NULL END,
        claimed_by=NULL, claim_expires_at=NULL
      WHERE delivery_id=$1 AND status='claimed' AND claimed_by=$2 AND claim_expires_at>$5
      RETURNING status`, [deliveryId, ownerId, error.slice(0, 4000), maxAttempts, now]);
    return result.rows[0]?.status ?? "not_owned";
  }
}
