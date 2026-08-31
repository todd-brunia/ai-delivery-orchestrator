import { randomUUID } from "node:crypto";

import { decideCallback, type CallbackAuthorityBinding, type CanonicalCallbackObservation, type WorkItemState } from "../../domain/sprint-delivery/v1/index.js";
import { toCallbackRoutingMetadata, type NormalizedGitHubEvent } from "../../github/webhooks/v1/index.js";
import type { CallbackDisposition, CommitCallbackResultRequest, LeaseRequest } from "../../persistence/index.js";
import type { RuntimeGenerationControl } from "./queue-consumer.js";

export interface CallbackInboxPort {
  claim(ownerId: string, limit: number, expiresAt: Date, maxAttempts: number, now?: Date): Promise<readonly { event: NormalizedGitHubEvent; attemptCount: number }[]>;
  retry(deliveryId: string, ownerId: string, error: string, maxAttempts: number, now?: Date): Promise<"pending" | "dead_letter" | "not_owned">;
}

export interface CallbackLeasePort { tryAcquireLease(request: LeaseRequest, now?: Date): Promise<boolean>; }
export interface CallbackCommitPort { commit(request: CommitCallbackResultRequest & { readonly events: readonly string[] }, now?: Date): Promise<{ readonly duplicate: boolean }>; }
export interface CallbackResolver {
  resolve(input: { readonly event: NormalizedGitHubEvent; readonly configurationVersion: string }): Promise<{ readonly workItemId: string; readonly state: WorkItemState; readonly binding: CallbackAuthorityBinding; readonly observation: CanonicalCallbackObservation }>;
}

export interface CallbackWorkerOptions {
  readonly ownerId: string;
  readonly configurationVersion: string;
  readonly maxBatch: number;
  readonly maxAttempts: number;
  readonly leaseMilliseconds: number;
}

/** Bounded, FIFO-at-claim worker; the resolver is the canonical authority boundary. */
export class CallbackWorker {
  constructor(private readonly control: RuntimeGenerationControl, private readonly inbox: CallbackInboxPort, private readonly leases: CallbackLeasePort, private readonly resolver: CallbackResolver, private readonly commits: CallbackCommitPort, private readonly options: CallbackWorkerOptions, private readonly now: () => Date = () => new Date()) {}

  async drainOnce(): Promise<readonly CallbackDisposition[]> {
    if (!this.control.mayClaim) return [];
    const now = this.now();
    const claimed = await this.inbox.claim(this.options.ownerId, this.options.maxBatch, new Date(now.getTime() + this.options.leaseMilliseconds), this.options.maxAttempts, now);
    const outcomes: CallbackDisposition[] = [];
    for (const item of claimed) {
      if (!this.control.mayClaim) break;
      try {
        const resolved = await this.resolver.resolve({ event: item.event, configurationVersion: this.options.configurationVersion });
        const leaseOwner = `callback:${this.options.ownerId}`;
        const acquired = await this.leases.tryAcquireLease({ aggregateType: "work_item", aggregateId: resolved.workItemId, ownerId: leaseOwner, expiresAt: new Date(now.getTime() + this.options.leaseMilliseconds) }, now);
        if (!acquired) throw new Error("work_item_lease_unavailable");
        const routing = toCallbackRoutingMetadata(item.event, this.options.configurationVersion);
        const decision = decideCallback({ eventName: routing.eventName, action: routing.action, hookId: routing.hookId, installationId: routing.installationId, ...(routing.repository ? { repository: routing.repository } : {}) }, resolved.binding, resolved.observation, resolved.state);
        if (!this.control.mayClaim) throw new Error("draining_before_commit");
        await this.commits.commit({ deliveryId: item.event.deliveryId, deliveryLeaseOwner: this.options.ownerId, workItemId: resolved.workItemId, workItemLeaseOwner: leaseOwner, disposition: decision.disposition === "ready" ? "completed" : decision.disposition, reasonClass: decision.reason, ...(decision.semanticKeys[0] ? { semanticKey: decision.semanticKeys[0] } : {}), evidence: { eventName: item.event.eventName, action: item.event.action, repository: resolved.binding.repository, workItemId: resolved.workItemId, payloadSha256: item.event.payloadSha256, configurationVersion: this.options.configurationVersion, attemptCount: item.attemptCount }, recordedAt: now.toISOString(), events: decision.events }, now);
        outcomes.push(decision.disposition === "ready" ? "completed" : decision.disposition);
      } catch (error) {
        const result = await this.inbox.retry(item.event.deliveryId, this.options.ownerId, error instanceof Error ? error.message : "callback_processing_failed", this.options.maxAttempts, now);
        outcomes.push(result === "dead_letter" ? "dead_letter" : "retrying");
      }
    }
    return outcomes;
  }
}

export function callbackWorkerId(): string { return `callback-worker:${randomUUID()}`; }
