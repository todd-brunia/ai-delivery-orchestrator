import { createHash } from "node:crypto";
import type { Pool } from "pg";

import { NormalizedGitHubEventSchema, type NormalizedGitHubEvent } from "../github/webhooks/v1/index.js";
import type { CommitCallbackResultRequest } from "./contracts.js";
import { WorkItemStateSchema, transitionWorkItem, type WorkItemEvent } from "../domain/sprint-delivery/v1/index.js";

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

  /** Atomically preserves sanitized decision evidence and completes a valid claim. */
  async commitResult(raw: CommitCallbackResultRequest, now = new Date()): Promise<{ readonly duplicate: boolean }> {
    const result = validateCallbackResult(raw);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query(`SELECT 1 FROM orchestrator.github_webhook_inbox
        WHERE delivery_id = $1 AND status = 'claimed' AND claimed_by = $2 AND claim_expires_at > $3 FOR UPDATE`,
      [result.deliveryId, result.deliveryLeaseOwner, now]);
      if (claimed.rowCount !== 1) throw new Error("callback delivery lease is absent or expired");
      if (result.workItemId && result.workItemLeaseOwner) {
        const lease = await client.query(`SELECT 1 FROM orchestrator.leases
          WHERE aggregate_type = 'work_item' AND aggregate_id = $1 AND owner_id = $2 AND expires_at > $3`,
        [result.workItemId, result.workItemLeaseOwner, now]);
        if (lease.rowCount !== 1) throw new Error("callback work-item lease is absent or expired");
      }
      const inserted = await client.query(`INSERT INTO orchestrator.github_callback_results
        (delivery_id, work_item_id, semantic_key, disposition, reason_class, evidence, recorded_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`,
      [result.deliveryId, result.workItemId ?? null, result.semanticKey ?? null, result.disposition,
        result.reasonClass, JSON.stringify(result.evidence), result.recordedAt]);
      if (inserted.rowCount === 1) {
        await client.query(`UPDATE orchestrator.github_webhook_inbox
          SET status = 'completed', completed_at = $3, claimed_by = NULL, claim_expires_at = NULL
          WHERE delivery_id = $1 AND claimed_by = $2`, [result.deliveryId, result.deliveryLeaseOwner, now]);
      }
      await client.query("COMMIT");
      return { duplicate: inserted.rowCount === 0 };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  /** Atomic callback boundary: transitions, projection outbox, evidence, and inbox completion commit together. */
  async commit(raw: CommitCallbackResultRequest & { readonly events: readonly string[] }, now = new Date()): Promise<{ readonly duplicate: boolean }> {
    const result = validateCallbackResult(raw);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query("SELECT 1 FROM orchestrator.github_webhook_inbox WHERE delivery_id=$1 AND status='claimed' AND claimed_by=$2 AND claim_expires_at>$3 FOR UPDATE", [result.deliveryId, result.deliveryLeaseOwner, now]);
      if (claimed.rowCount !== 1) throw new Error("callback delivery lease is absent or expired");
      const prior = await client.query("SELECT 1 FROM orchestrator.github_callback_results WHERE delivery_id=$1 OR (semantic_key IS NOT NULL AND semantic_key=$2)", [result.deliveryId, result.semanticKey ?? null]);
      if (prior.rowCount === 1) { await client.query("COMMIT"); return { duplicate: true }; }
      if (result.workItemId && result.workItemLeaseOwner) {
        const lease = await client.query("SELECT 1 FROM orchestrator.leases WHERE aggregate_type='work_item' AND aggregate_id=$1 AND owner_id=$2 AND expires_at>$3", [result.workItemId, result.workItemLeaseOwner, now]);
        if (lease.rowCount !== 1) throw new Error("callback work-item lease is absent or expired");
        const item = await client.query<{ state: string; revision: number }>("SELECT state, revision FROM orchestrator.work_items WHERE id=$1 FOR UPDATE", [result.workItemId]);
        let state = WorkItemStateSchema.parse(item.rows[0]?.state); let revision = item.rows[0]?.revision;
        if (revision === undefined) throw new Error("callback work item is missing");
        for (const rawEvent of raw.events) {
          const event = rawEvent as WorkItemEvent; const next = transitionWorkItem(state, event); revision += 1;
          const key = `${result.semanticKey ?? result.deliveryId}:${event}`; const id = deterministicUuid(key);
          await client.query("INSERT INTO orchestrator.transitions (id, aggregate_type, aggregate_id, aggregate_revision, from_state, to_state, event, actor, evidence, idempotency_key, occurred_at) VALUES ($1,'work_item',$2,$3,$4,$5,$6,$7,$8,$9,$10)", [id, result.workItemId, revision, state, next, JSON.stringify(event), JSON.stringify({ kind: "system", id: "callback-worker" }), JSON.stringify([{ kind: "policy", uri: "callback://canonical" }]), key, result.recordedAt]);
          await client.query("INSERT INTO orchestrator.outbox (id, transition_id, action_type, payload, idempotency_key, created_at) VALUES ($1,$2,'projection.update',$3,$4,$5)", [deterministicUuid(`${key}:outbox`), id, JSON.stringify({ workItemId: result.workItemId, event }), `${key}:outbox`, result.recordedAt]);
          state = next;
        }
        await client.query("UPDATE orchestrator.work_items SET state=$2, revision=$3, updated_at=$4 WHERE id=$1", [result.workItemId, state, revision, result.recordedAt]);
      }
      await client.query("INSERT INTO orchestrator.github_callback_results (delivery_id, work_item_id, semantic_key, disposition, reason_class, evidence, recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [result.deliveryId, result.workItemId ?? null, result.semanticKey ?? null, result.disposition, result.reasonClass, JSON.stringify(result.evidence), result.recordedAt]);
      await client.query("UPDATE orchestrator.github_webhook_inbox SET status='completed', completed_at=$3, claimed_by=NULL, claim_expires_at=NULL WHERE delivery_id=$1 AND claimed_by=$2", [result.deliveryId, result.deliveryLeaseOwner, now]);
      await client.query("COMMIT"); return { duplicate: false };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
}

function deterministicUuid(value: string): string { const hash = createHash("sha256").update(value).digest("hex"); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`; }

function validateCallbackResult(raw: CommitCallbackResultRequest): CommitCallbackResultRequest {
  if (!raw.deliveryLeaseOwner || !/^[a-z][a-z0-9_]{1,100}$/.test(raw.reasonClass) ||
      !["pending", "retrying", "completed", "ignored", "blocked", "dead_letter"].includes(raw.disposition) ||
      (raw.workItemLeaseOwner !== undefined && !raw.workItemId) ||
      (raw.semanticKey !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/.test(raw.semanticKey)) ||
      !Number.isFinite(new Date(raw.recordedAt).getTime()) || !isSanitizedCallbackEvidence(raw.evidence)) throw new Error("invalid callback result");
  return raw;
}

const callbackEvidenceKeys = new Set([
  "eventName", "action", "hookId", "installationId", "repository", "runId", "workItemId", "revision",
  "issueNodeId", "pullRequestNodeId", "workflowRunId", "checkRunId", "checkSuiteId", "reviewId",
  "headSha", "baseSha", "planningFingerprint", "payloadSha256", "semanticKey", "transitionKey", "outboxKey",
  "canonicalObservedAt", "attemptCount", "leaseCount", "configurationVersion",
]);

function isSanitizedCallbackEvidence(evidence: Readonly<Record<string, unknown>>): boolean {
  const entries = Object.entries(evidence);
  return entries.length <= 32 && entries.every(([key, value]) => callbackEvidenceKeys.has(key) &&
    ((typeof value === "string" && value.length <= 200) || (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean"));
}
