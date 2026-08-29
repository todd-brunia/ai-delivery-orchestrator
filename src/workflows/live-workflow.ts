import { createHash } from "node:crypto";

import { RepositoryAdapterConfigV1Schema, scheduleDryRun, validateFeasibilityForRun } from "../domain/sprint-delivery/v1/index.js";
import type { SprintRunRepository } from "../persistence/index.js";
import type { ProviderSet } from "../providers/v1/index.js";
import { authorizeLiveBuild, collectLiveWorkItemBinding } from "./live-dispatch.js";
import { LiveWorkflowRequestSchema, LiveWorkflowResultSchema, type LiveWorkflowRuntime } from "./contracts.js";

/** Bounded live entry point: collect and durably bind canonical evidence before later nodes may authorize work. */
export function createLiveBindingWorkflowRuntime(repository: SprintRunRepository, providers: Pick<ProviderSet, "githubRead" | "modelAnalysis">): LiveWorkflowRuntime {
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
      const bindings = new Map<string, Awaited<ReturnType<typeof collectLiveWorkItemBinding>>>();
      for (const item of run.workItems) {
        const ownerId = `live-binding:${request.threadId}`;
        const acquired = await repository.tryAcquireLease({ aggregateType: "work_item", aggregateId: item.id, ownerId, expiresAt: new Date(now.getTime() + 60_000) }, now);
        if (!acquired) throw new Error(`live binding lease contention for work item ${item.id}`);
        const binding = await collectLiveWorkItemBinding({ github: providers.githubRead, adapter, runId: run.id, workItemId: item.id, issueNumber: item.issueNumber, defaultBranchSha: request.defaultBranchSha, observedAt: request.occurredAt });
        const fingerprint = createHash("sha256").update(JSON.stringify(binding), "utf8").digest("hex");
        const saved = await repository.savePlanningBinding({ workItemId: item.id, fingerprint, evidence: binding, observedAt: request.occurredAt, expectedWorkItemRevision: item.revision, leaseOwnerId: ownerId }, now);
        if (saved.binding.fingerprint !== fingerprint) throw new Error(`live planning binding drifted for work item ${item.id}`);
        bindingFingerprints[item.id] = fingerprint;
        bindings.set(item.id, binding);
      }
      const analysis = validateFeasibilityForRun(await providers.modelAnalysis.analyzeFeasibility({ version: "providers/v1", repository: run.input.repository, issueNumbers: run.input.issueNumbers, planFingerprints: Object.fromEntries(run.workItems.map((item) => [String(item.issueNumber), bindings.get(item.id)!.plan.bodySha256])), defaultBranchSha: request.defaultBranchSha }), run.input.issueNumbers);
      await repository.saveAnalysis(run.id, { dependencies: analysis.dependencies, conflicts: analysis.conflicts });
      const authorizedIssueNumbers: number[] = [];
      const waitingIssueNumbers: number[] = [];
      for (const item of run.workItems) {
        const binding = bindings.get(item.id)!;
        const decision = await authorizeLiveBuild({ github: providers.githubRead, repository: run.input.repository, issueNumber: item.issueNumber, plan: binding.plan, analysis });
        (decision.authorized ? authorizedIssueNumbers : waitingIssueNumbers).push(item.issueNumber);
      }
      const schedule = scheduleDryRun({ runId: run.id, candidates: run.workItems.filter((item) => authorizedIssueNumbers.includes(item.issueNumber)).map((item) => ({ issueNumber: item.issueNumber, state: item.state, conflictDomains: analysis.conflicts.find((entry) => entry.issueNumber === item.issueNumber)?.domains ?? [] })), dependencies: analysis.dependencies, mergedIssueNumbers: run.workItems.filter((item) => item.state === "merged").map((item) => item.issueNumber), activeImplementationCount: run.workItems.filter((item) => ["build_dispatched", "building", "pr_open", "checks_pending", "reviewing", "fixing", "ready_for_human_review"].includes(item.state)).length, maximumConcurrentImplementations: adapter.maxParallelImplementations as 1 | 2, evidence: run.workItems.map((item) => ({ kind: "issue" as const, uri: `github://issues/${run.input.repository}/${item.issueNumber}` })) });
      return LiveWorkflowResultSchema.parse({ workflowVersion: run.input.workflowVersion, providerContractVersion: "providers/v1", runId: run.id, threadId: request.threadId, status: "bindings_collected", bindingFingerprints, authorizedIssueNumbers, waitingIssueNumbers, scheduledIssueNumbers: schedule.selectedIssueNumbers });
    },
  };
}
