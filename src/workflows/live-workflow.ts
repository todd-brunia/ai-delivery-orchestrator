import { createHash } from "node:crypto";

import { RepositoryAdapterConfigV1Schema } from "../domain/sprint-delivery/v1/index.js";
import type { SprintRunRepository } from "../persistence/index.js";
import type { ProviderSet } from "../providers/v1/index.js";
import { collectLiveWorkItemBinding } from "./live-dispatch.js";
import { LiveWorkflowRequestSchema, LiveWorkflowResultSchema, type LiveWorkflowRuntime } from "./contracts.js";

/** Bounded live entry point: collect and durably bind canonical evidence before later nodes may authorize work. */
export function createLiveBindingWorkflowRuntime(repository: SprintRunRepository, providers: Pick<ProviderSet, "githubRead">): LiveWorkflowRuntime {
  return {
    execute: async (raw) => {
      const request = LiveWorkflowRequestSchema.parse(raw);
      if (!repository.savePlanningBinding) throw new Error("live workflow requires planning-binding persistence");
      const run = await repository.getRun(request.runId);
      if (!run) throw new Error(`sprint run not found: ${request.runId}`);
      const adapter = RepositoryAdapterConfigV1Schema.parse(request.adapter);
      if (adapter.repository !== run.input.repository) throw new Error("live workflow adapter repository mismatch");
      const now = new Date(request.occurredAt);
      const bindingFingerprints: Record<string, string> = {};
      for (const item of run.workItems) {
        const ownerId = `live-binding:${request.threadId}`;
        const acquired = await repository.tryAcquireLease({ aggregateType: "work_item", aggregateId: item.id, ownerId, expiresAt: new Date(now.getTime() + 60_000) }, now);
        if (!acquired) throw new Error(`live binding lease contention for work item ${item.id}`);
        const binding = await collectLiveWorkItemBinding({ github: providers.githubRead, adapter, runId: run.id, workItemId: item.id, issueNumber: item.issueNumber, defaultBranchSha: request.defaultBranchSha, observedAt: request.occurredAt });
        const fingerprint = createHash("sha256").update(JSON.stringify(binding), "utf8").digest("hex");
        const saved = await repository.savePlanningBinding({ workItemId: item.id, fingerprint, evidence: binding, observedAt: request.occurredAt, expectedWorkItemRevision: item.revision, leaseOwnerId: ownerId }, now);
        if (saved.binding.fingerprint !== fingerprint) throw new Error(`live planning binding drifted for work item ${item.id}`);
        bindingFingerprints[item.id] = fingerprint;
      }
      return LiveWorkflowResultSchema.parse({ workflowVersion: run.input.workflowVersion, providerContractVersion: "providers/v1", runId: run.id, threadId: request.threadId, status: "bindings_collected", bindingFingerprints });
    },
  };
}
