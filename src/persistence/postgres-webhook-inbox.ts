import { createHash } from "node:crypto";
import type { Pool } from "pg";

import { NormalizedGitHubEventSchema, type NormalizedGitHubEvent } from "../github/webhooks/v1/index.js";
import type { CommitCallbackResultRequest } from "./contracts.js";
import { WorkItemStateSchema, transitionWorkItem, type WorkItemEvent } from "../domain/sprint-delivery/v1/index.js";

export interface InboxAcceptance { readonly event: NormalizedGitHubEvent; readonly duplicate: boolean; }
export interface ClaimedInboxEvent { readonly event: NormalizedGitHubEvent; readonly attemptCount: number; readonly claimExpiresAt: string; }

interface InboxRow { normalized_event: unknown; attempt_count: number; claim_expires_at: Date; }

export class PostgresWebhookInbox {
  constructor(private readonly pool: Pool, private readonly callbackRepository?: string, private readonly enabledEvents?: readonly string[], private readonly deliveryIds?: readonly string[]) {}

  /** Claimed work remains pending until completion, even before lease expiry. */
  async hasPendingWork(): Promise<boolean> {
    const result = await this.pool.query<{ pending: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM orchestrator.github_webhook_inbox WHERE status IN ('pending','claimed')
      AND ($1::text IS NULL OR repository=$1 OR repository IS NULL)
      AND ($2::text[] IS NULL OR event_name=ANY($2))
      AND ($3::uuid[] IS NULL OR delivery_id=ANY($3))) AS pending`,
    [this.callbackRepository ?? null, this.enabledEvents ?? null, this.deliveryIds ?? null]);
    if (typeof result.rows[0]?.pending !== "boolean") throw new Error("callback_progress_unavailable");
    return result.rows[0].pending;
  }

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
    await this.pool.query(`WITH exhausted AS (UPDATE orchestrator.github_webhook_inbox SET status = 'dead_letter',
      claimed_by = NULL, claim_expires_at = NULL, dead_lettered_at = $1
      WHERE status IN ('pending','claimed') AND attempt_count >= $2
        AND (status = 'pending' OR claim_expires_at <= $1)
        AND ($3::text IS NULL OR repository=$3 OR repository IS NULL)
        AND ($4::text[] IS NULL OR event_name=ANY($4))
        AND ($5::uuid[] IS NULL OR delivery_id=ANY($5)) RETURNING delivery_id)
      INSERT INTO orchestrator.github_callback_notifications(delivery_id,kind,reason_class,recorded_at)
      SELECT delivery_id,'reconciliation','callback_dead_letter',$1 FROM exhausted ON CONFLICT DO NOTHING`, [now, maxAttempts, this.callbackRepository ?? null, this.enabledEvents ?? null, this.deliveryIds ?? null]);
    const result = await this.pool.query<InboxRow>(`WITH candidates AS (
      SELECT delivery_id FROM orchestrator.github_webhook_inbox
      WHERE attempt_count < $5 AND (status = 'pending' OR (status = 'claimed' AND claim_expires_at <= $3))
        AND ($6::text IS NULL OR repository=$6 OR repository IS NULL)
        AND ($7::text[] IS NULL OR event_name=ANY($7))
        AND ($8::uuid[] IS NULL OR delivery_id=ANY($8))
      ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT $1)
      UPDATE orchestrator.github_webhook_inbox i SET status = 'claimed', claimed_by = $2,
        claim_expires_at = $4, attempt_count = attempt_count + 1
      FROM candidates WHERE i.delivery_id = candidates.delivery_id
      RETURNING i.normalized_event, i.attempt_count, i.claim_expires_at`,
      [limit, ownerId, now, expiresAt, maxAttempts, this.callbackRepository ?? null, this.enabledEvents ?? null, this.deliveryIds ?? null]);
    return result.rows.map((row) => ({ event: NormalizedGitHubEventSchema.parse(row.normalized_event), attemptCount: row.attempt_count, claimExpiresAt: row.claim_expires_at.toISOString() }));
  }

  async complete(deliveryId: string, ownerId: string, now = new Date()): Promise<boolean> {
    const result = await this.pool.query(`UPDATE orchestrator.github_webhook_inbox
      SET status='completed', completed_at=$3, claimed_by=NULL, claim_expires_at=NULL
      WHERE delivery_id=$1 AND status='claimed' AND claimed_by=$2 AND claim_expires_at>$3`, [deliveryId, ownerId, now]);
    return result.rowCount === 1;
  }

  async retry(deliveryId: string, ownerId: string, error: string, maxAttempts: number, now = new Date()): Promise<"pending" | "dead_letter" | "not_owned"> {
    const category = ["identity_mismatch","correlation_absent","correlation_ambiguous","canonical_binding_invalid","automation_disabled","callback_processing_failed","failed"].includes(error) ? error : "callback_processing_failed";
    const result = await this.pool.query<{ status: "pending" | "dead_letter" }>(`WITH updated AS (UPDATE orchestrator.github_webhook_inbox
      SET status=CASE WHEN attempt_count >= $4 THEN 'dead_letter' ELSE 'pending' END,
        last_error=$3, dead_lettered_at=CASE WHEN attempt_count >= $4 THEN $5 ELSE NULL END,
        claimed_by=NULL, claim_expires_at=NULL
      WHERE delivery_id=$1 AND status='claimed' AND claimed_by=$2 AND claim_expires_at>$5
      RETURNING status, delivery_id), notification AS (
        INSERT INTO orchestrator.github_callback_notifications (delivery_id,kind,reason_class,recorded_at)
        SELECT delivery_id,'reconciliation','callback_dead_letter',$5 FROM updated WHERE status='dead_letter'
        ON CONFLICT DO NOTHING)
      SELECT status FROM updated`, [deliveryId, ownerId, category, maxAttempts, now]);
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
    let persistedEvidence = result.evidence;
    if (raw.events.some((event) => !["build_started", "pull_request_opened", "checks_awaited"].includes(event)) ||
      (raw.events.length > 0 && result.disposition !== "completed")) throw new Error("invalid callback transitions");
    const connectionStarted = performance.now();
    const client = await this.pool.connect();
    now = new Date(now.getTime() + performance.now() - connectionStarted);
    try {
      await client.query("BEGIN");
      const claimed = await client.query("SELECT 1 FROM orchestrator.github_webhook_inbox WHERE delivery_id=$1 AND status='claimed' AND claimed_by=$2 AND claim_expires_at>$3 FOR UPDATE", [result.deliveryId, result.deliveryLeaseOwner, now]);
      if (claimed.rowCount !== 1) throw new Error("callback delivery lease is absent or expired");
      if (this.callbackRepository) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`callback-repository:${this.callbackRepository}`]);
      // Serialize semantic observations, including concurrent deliveries for the same artifact.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [result.semanticKey ?? result.deliveryId]);
      const prior = await client.query("SELECT 1 FROM orchestrator.github_callback_results WHERE semantic_key=$1 LIMIT 1", [result.semanticKey ?? null]);
      const duplicate = prior.rowCount === 1;
      if (raw.events.length && (!result.workItemId || !result.workItemLeaseOwner || result.expectedRevision === undefined || result.expectedRunRevision === undefined)) throw new Error("callback commit requires bound revisions and lease");
      if (result.workItemId && result.workItemLeaseOwner) {
        const lease = await client.query("SELECT 1 FROM orchestrator.leases WHERE aggregate_type='work_item' AND aggregate_id=$1 AND owner_id=$2 AND expires_at>$3 FOR UPDATE", [result.workItemId, result.workItemLeaseOwner, now]);
        if (lease.rowCount !== 1) throw new Error("callback work-item lease is absent or expired");
        const run = await client.query<{ state: string; revision: number; repository: string }>("SELECT r.state,r.revision,r.repository FROM orchestrator.sprint_runs r JOIN orchestrator.work_items w ON w.sprint_run_id=r.id WHERE w.id=$1 FOR UPDATE OF r", [result.workItemId]);
        if (run.rows[0]?.revision !== result.expectedRunRevision) throw new Error("callback run revision conflict");
        const blocked = await client.query("SELECT 1 FROM orchestrator.github_callback_repository_blocks WHERE repository=$1", [run.rows[0]?.repository]);
        if (raw.events.length && (blocked.rowCount || ["paused","blocked","cancelled","superseded","completed","failed"].includes(run.rows[0]!.state))) throw new Error("callback run disabled");
        const item = await client.query<{ state: string; revision: number }>("SELECT state, revision FROM orchestrator.work_items WHERE id=$1 FOR UPDATE", [result.workItemId]);
        let state = WorkItemStateSchema.parse(item.rows[0]?.state); let revision = item.rows[0]?.revision;
        if (revision === undefined) throw new Error("callback work item is missing");
        if (revision !== result.expectedRevision) throw new Error("callback work-item revision conflict");
        for (const artifact of result.artifacts ?? []) {
          const saved = await client.query("INSERT INTO orchestrator.github_callback_artifacts(repository,kind,external_id,work_item_id,fingerprint) VALUES($1,$2,$3,$4,$5) ON CONFLICT(repository,kind,external_id) DO UPDATE SET fingerprint=orchestrator.github_callback_artifacts.fingerprint WHERE orchestrator.github_callback_artifacts.work_item_id=EXCLUDED.work_item_id AND orchestrator.github_callback_artifacts.fingerprint=EXCLUDED.fingerprint RETURNING external_id", [run.rows[0]!.repository, artifact.kind, artifact.id, result.workItemId, artifact.fingerprint]);
          if (saved.rowCount !== 1) throw new Error("callback artifact conflict");
        }
        if (result.correlation) {
          const c = result.correlation;
          if (c.workItemId !== result.workItemId || c.repository !== run.rows[0]!.repository) throw new Error("callback correlation mismatch");
          const saved = await client.query(`INSERT INTO orchestrator.work_item_callback_correlations(work_item_id,repository,issue_node_id,planning_fingerprint,automation_marker,expected_branch,expected_base_sha,accepted_workflow_run_id,pull_request_node_id,pull_request_number,current_head_sha,recorded_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            ON CONFLICT(work_item_id) DO UPDATE SET pull_request_node_id=COALESCE(orchestrator.work_item_callback_correlations.pull_request_node_id,EXCLUDED.pull_request_node_id),pull_request_number=COALESCE(orchestrator.work_item_callback_correlations.pull_request_number,EXCLUDED.pull_request_number),current_head_sha=COALESCE(orchestrator.work_item_callback_correlations.current_head_sha,EXCLUDED.current_head_sha)
            WHERE orchestrator.work_item_callback_correlations.automation_marker=EXCLUDED.automation_marker AND orchestrator.work_item_callback_correlations.accepted_workflow_run_id=EXCLUDED.accepted_workflow_run_id AND (orchestrator.work_item_callback_correlations.current_head_sha IS NULL OR orchestrator.work_item_callback_correlations.current_head_sha=EXCLUDED.current_head_sha)
            RETURNING work_item_id`, [c.workItemId,c.repository,c.issueNodeId,c.planningFingerprint,c.automationMarker,c.expectedBranch,c.expectedBaseSha,c.acceptedWorkflowRunId,c.pullRequestNodeId ?? null,c.pullRequestNumber ?? null,c.currentHeadSha ?? null,c.recordedAt]);
          if (saved.rowCount !== 1) throw new Error("callback correlation conflict");
        }
        const events = duplicate ? [] : result.disposition === "blocked" && !["blocked","merged","failed","cancelled","superseded"].includes(state) ? ["blocked"] : raw.events;
        for (const rawEvent of events) {
          const event = rawEvent as WorkItemEvent; const next = transitionWorkItem(state, event); revision += 1;
          const key = `${result.semanticKey ?? result.deliveryId}:${event}`; const id = deterministicUuid(key);
          await client.query("INSERT INTO orchestrator.transitions (id, aggregate_type, aggregate_id, aggregate_revision, from_state, to_state, event, actor, evidence, idempotency_key, occurred_at) VALUES ($1,'work_item',$2,$3,$4,$5,$6,$7,$8,$9,$10)", [id, result.workItemId, revision, state, next, JSON.stringify(event), JSON.stringify({ kind: "system", id: "callback-worker" }), JSON.stringify([{ kind: "policy", uri: "callback://canonical" }]), key, result.recordedAt]);
          await client.query("INSERT INTO orchestrator.outbox (id, transition_id, action_type, payload, idempotency_key, created_at) VALUES ($1,$2,'projection.update',$3,$4,$5)", [deterministicUuid(`${key}:outbox`), id, JSON.stringify({ workItemId: result.workItemId, event }), `${key}:outbox`, result.recordedAt]);
          state = next;
        }
        await client.query("UPDATE orchestrator.work_items SET state=$2, revision=$3, updated_at=$4 WHERE id=$1", [result.workItemId, state, revision, result.recordedAt]);
        persistedEvidence = { ...result.evidence, state, revision };
      }
      if (result.notification) await client.query("INSERT INTO orchestrator.github_callback_notifications(delivery_id,work_item_id,kind,reason_class,recorded_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [result.deliveryId,result.workItemId ?? null,result.notification,result.reasonClass,result.recordedAt]);
      if (result.reasonClass === "installation_reconciliation_required") {
        if (!this.callbackRepository) throw new Error("callback repository scope required");
        await client.query("INSERT INTO orchestrator.github_callback_repository_blocks(repository,delivery_id,reason_class,recorded_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [this.callbackRepository,result.deliveryId,result.reasonClass,result.recordedAt]);
      }
      await client.query("INSERT INTO orchestrator.github_callback_results (delivery_id, work_item_id, semantic_key, disposition, reason_class, evidence, recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [result.deliveryId, result.workItemId ?? null, result.semanticKey ?? null, result.disposition, result.reasonClass, JSON.stringify(persistedEvidence), result.recordedAt]);
      const completed = await client.query("UPDATE orchestrator.github_webhook_inbox SET status='completed', completed_at=$3, claimed_by=NULL, claim_expires_at=NULL WHERE delivery_id=$1 AND claimed_by=$2 AND claim_expires_at > $3::timestamptz + (clock_timestamp()-transaction_timestamp())", [result.deliveryId, result.deliveryLeaseOwner, now]);
      if (completed.rowCount !== 1) throw new Error("callback delivery expired during commit");
      if (result.workItemId) {
        const held = await client.query("SELECT 1 FROM orchestrator.leases WHERE aggregate_type='work_item' AND aggregate_id=$1 AND owner_id=$2 AND expires_at > $3::timestamptz + (clock_timestamp()-transaction_timestamp())", [result.workItemId,result.workItemLeaseOwner,now]);
        if (held.rowCount !== 1) throw new Error("callback item lease expired during commit");
      }
      await client.query("COMMIT"); return { duplicate };
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
  "checksFingerprint",
  "checksStatus", "reviewFactsFingerprint",
]);

function isSanitizedCallbackEvidence(evidence: Readonly<Record<string, unknown>>): boolean {
  const entries = Object.entries(evidence);
  return entries.length <= 32 && entries.every(([key, value]) => {
    if (!callbackEvidenceKeys.has(key)) return false;
    if (["revision", "attemptCount", "leaseCount", "hookId", "installationId"].includes(key)) return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    if (typeof value !== "string" || value.length > 200) return false;
    if (key.endsWith("Sha256") || key.endsWith("Fingerprint")) return /^[a-f0-9]{64}$/.test(value);
    if (key === "headSha" || key === "baseSha") return /^[a-f0-9]{40}$/.test(value);
    if (key === "canonicalObservedAt") return Number.isFinite(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value);
    if (key === "checksStatus") return ["success", "pending", "failure"].includes(value);
    if (key === "eventName") return ["issues", "issue_comment", "workflow_run", "pull_request", "check_run", "check_suite", "pull_request_review", "installation", "installation_repositories"].includes(value);
    return /^[A-Za-z0-9._:/=-]+$/.test(value);
  });
}
