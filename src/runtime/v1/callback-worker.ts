import { randomUUID, createHash } from "node:crypto";
import { decideCallback } from "../../domain/sprint-delivery/v1/index.js";
import { toCallbackRoutingMetadata, type NormalizedGitHubEvent } from "../../github/webhooks/v1/index.js";
import type { CallbackDisposition, CommitCallbackResultRequest, LeaseRequest } from "../../persistence/index.js";
import type { RuntimeGenerationControl } from "./queue-consumer.js";
import { CallbackResolutionError, type ResolvedCallback } from "./canonical-callback-resolver.js";

export interface CallbackInboxPort {
  claim(ownerId: string, limit: number, expiresAt: Date, maxAttempts: number, now?: Date): Promise<readonly { event: NormalizedGitHubEvent; attemptCount: number }[]>;
  retry(deliveryId: string, ownerId: string, error: string, maxAttempts: number, now?: Date): Promise<"pending" | "dead_letter" | "not_owned">;
}
export interface CallbackLeasePort {
  tryAcquireLease(request: LeaseRequest, now?: Date): Promise<boolean>;
  releaseCallbackLease?(workItemId: string, ownerId: string): Promise<void>;
}
export interface CallbackCommitPort { commit(request: CommitCallbackResultRequest & { readonly events: readonly string[] }, now?: Date): Promise<{ readonly duplicate: boolean }>; }
export interface CallbackResolver {
  locate(event: NormalizedGitHubEvent): Promise<string | undefined>;
  resolve(input: { readonly event: NormalizedGitHubEvent; readonly configurationVersion: string; readonly workItemId: string }): Promise<ResolvedCallback>;
}
export interface CallbackWorkerOptions {
  readonly ownerId: string;
  readonly configurationVersion: string;
  readonly maxBatch: number;
  readonly maxAttempts: number;
  readonly leaseMilliseconds: number;
}

/** A delivery has a hard deadline; slow reads cannot extend authority past its lease. */
export class CallbackWorker {
  constructor(private readonly control: RuntimeGenerationControl, private readonly inbox: CallbackInboxPort, private readonly leases: CallbackLeasePort,
    private readonly resolver: CallbackResolver, private readonly commits: CallbackCommitPort, private readonly options: CallbackWorkerOptions, private readonly now: () => Date = () => new Date()) {
    if (!options.ownerId || !Number.isInteger(options.maxBatch) || options.maxBatch < 1 || options.maxBatch > 100 || !Number.isInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 10 || options.leaseMilliseconds < 1000 || options.leaseMilliseconds > 300_000) throw new Error("invalid_callback_worker_configuration");
  }

  async drainOnce(): Promise<readonly CallbackDisposition[]> {
    const outcomes: CallbackDisposition[] = [];
    for (let index = 0; index < this.options.maxBatch && this.control.mayClaim; index++) {
      const started = this.now();
      const expiresAt = new Date(started.getTime() + this.options.leaseMilliseconds);
      const item = (await this.inbox.claim(this.options.ownerId, 1, expiresAt, this.options.maxAttempts, started))[0];
      if (!item) break;
      let workItemId: string | undefined;
      const leaseOwner = `callback:${randomUUID()}`;
      try {
        toCallbackRoutingMetadata(item.event, this.options.configurationVersion);
        workItemId = await this.resolver.locate(item.event);
        if (!workItemId) {
          const installation = item.event.eventName.startsWith("installation");
          if (!this.control.mayClaim || this.now() >= expiresAt) throw new Error("callback_deadline_or_drain");
          await this.commits.commit({ deliveryId: item.event.deliveryId, deliveryLeaseOwner: this.options.ownerId, disposition: installation ? "blocked" : "ignored", reasonClass: installation ? "installation_reconciliation_required" : "unsupported_action", evidence: { eventName: item.event.eventName, configurationVersion: this.options.configurationVersion }, recordedAt: this.now().toISOString(), events: [], ...(installation ? { notification: "reconciliation" as const } : {}) }, this.now());
          outcomes.push(installation ? "blocked" : "ignored");
          continue;
        }
        const acquired = await this.leases.tryAcquireLease({ aggregateType: "work_item", aggregateId: workItemId, ownerId: leaseOwner, expiresAt }, this.now());
        if (!acquired) throw new Error("lease_unavailable");
        const resolved = await this.resolver.resolve({ event: item.event, configurationVersion: this.options.configurationVersion, workItemId });
        if (!this.control.mayClaim || this.now() >= expiresAt) throw new Error("callback_deadline_or_drain");
        const decision = decideCallback(item.event, resolved.binding, resolved.observation, resolved.state);
        const disposition = decision.disposition === "ready" ? "completed" : decision.disposition;
        const semanticKey = `callback:v1:${workItemId}:${createHash("sha256").update(JSON.stringify({ observation: resolved.observation, reason: decision.reason })).digest("hex")}`;
        const bound = resolved.binding;
        await this.commits.commit({ deliveryId: item.event.deliveryId, deliveryLeaseOwner: this.options.ownerId, workItemId, workItemLeaseOwner: leaseOwner,
          expectedRevision: resolved.revision, expectedRunRevision: resolved.runRevision, disposition, reasonClass: decision.reason, semanticKey,
          evidence: { eventName: item.event.eventName, repository: bound.repository, workItemId, runId: resolved.runId, revision: resolved.revision, payloadSha256: item.event.payloadSha256, configurationVersion: this.options.configurationVersion, attemptCount: item.attemptCount, canonicalObservedAt: resolved.observedAt,
            ...(resolved.checksStatus ? { checksStatus: resolved.checksStatus } : {}), ...(resolved.reviewFactsFingerprint ? { reviewFactsFingerprint: resolved.reviewFactsFingerprint } : {}),
            ...(bound.currentHeadSha ? { headSha: bound.currentHeadSha } : {}), ...(bound.acceptedWorkflowRunId ? { workflowRunId: bound.acceptedWorkflowRunId } : {}), checksFingerprint: createHash("sha256").update(JSON.stringify(resolved.observation.requiredChecks ?? {})).digest("hex") },
          recordedAt: this.now().toISOString(), events: decision.events, artifacts: disposition === "blocked" ? [] : resolved.artifacts,
          ...(disposition === "completed" && bound.acceptedWorkflowRunId ? { correlation: { workItemId, repository: bound.repository, issueNodeId: bound.issueNodeId, planningFingerprint: bound.planningFingerprint, automationMarker: bound.automationMarker, expectedBranch: bound.expectedBranch, expectedBaseSha: bound.expectedBaseSha, acceptedWorkflowRunId: bound.acceptedWorkflowRunId, ...(bound.pullRequestNodeId ? { pullRequestNodeId: bound.pullRequestNodeId, pullRequestNumber: bound.pullRequestNumber!, currentHeadSha: bound.currentHeadSha! } : {}), recordedAt: resolved.observedAt } } : {}),
          ...(disposition === "blocked" ? { notification: "reconciliation" as const } : decision.route === "plan_authorization" ? { notification: "plan_authorization" as const } : {}),
        }, this.now());
        outcomes.push(disposition);
      } catch (error) {
        const reason = error instanceof CallbackResolutionError ? error.reason : "callback_processing_failed";
        const result = await this.inbox.retry(item.event.deliveryId, this.options.ownerId, reason, this.options.maxAttempts, this.now());
        outcomes.push(result === "dead_letter" ? "dead_letter" : "retrying");
        break;
      } finally {
        if (workItemId) await this.leases.releaseCallbackLease?.(workItemId, leaseOwner);
      }
    }
    return outcomes;
  }
}
export function callbackWorkerId(): string { return `callback-worker:${randomUUID()}`; }
