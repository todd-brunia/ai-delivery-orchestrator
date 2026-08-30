import { createHash } from "node:crypto";

import { RepositoryAdapterConfigV1Schema, scheduleDryRun, validateFeasibilityForRun } from "../domain/sprint-delivery/v1/index.js";
import type { PersistedWorkItem, SprintRunRepository, WorkItemTransitionRequest } from "../persistence/index.js";
import type { ProviderSet } from "../providers/v1/index.js";
import { authorizeLiveBuild, collectLiveWorkItemBinding, queueImplementationDispatch } from "./live-dispatch.js";
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
      const currentItems = new Map<number, PersistedWorkItem>();
      for (const item of run.workItems) {
        const binding = bindings.get(item.id)!;
        const decision = await authorizeLiveBuild({ github: providers.githubRead, repository: run.input.repository, issueNumber: item.issueNumber, plan: binding.plan, analysis });
        (decision.authorized ? authorizedIssueNumbers : waitingIssueNumbers).push(item.issueNumber);
        let current = item;
        if (current.state === "discovered") current = await transitionLiveWorkItem(repository, current, "plan_available", request.occurredAt);
        if (current.state === "feasibility_review") current = await transitionLiveWorkItem(repository, current, decision.authorized ? "build_authorized" : "human_plan_approval_required", request.occurredAt);
        if (current.state === "human_plan_approval_required" && decision.authorized) current = await transitionLiveWorkItem(repository, current, "build_authorized", request.occurredAt);
        currentItems.set(current.issueNumber, current);
      }
      const items = [...currentItems.values()];
      const schedule = scheduleDryRun({ runId: run.id, candidates: items.filter((item) => authorizedIssueNumbers.includes(item.issueNumber)).map((item) => ({ issueNumber: item.issueNumber, state: item.state, conflictDomains: analysis.conflicts.find((entry) => entry.issueNumber === item.issueNumber)?.domains ?? [] })), dependencies: analysis.dependencies, mergedIssueNumbers: items.filter((item) => item.state === "merged").map((item) => item.issueNumber), activeImplementationCount: items.filter((item) => ["build_dispatched", "building", "pr_open", "checks_pending", "reviewing", "fixing", "ready_for_human_review"].includes(item.state)).length, maximumConcurrentImplementations: adapter.maxParallelImplementations as 1 | 2, evidence: items.map((item) => ({ kind: "issue" as const, uri: `github://issues/${run.input.repository}/${item.issueNumber}` })) });
      for (const issueNumber of schedule.selectedIssueNumbers) {
        const item = currentItems.get(issueNumber)!;
        const binding = bindings.get(item.id)!;
        await queueImplementationDispatch({ repository, workItem: item, preparation: { version: "live-dispatch-preparation/v1", binding, adapter, expectedAdapterFingerprint: binding.adapterFingerprint, expectedPlanSha256: binding.plan.bodySha256, expectedDefaultBranchSha: request.defaultBranchSha, now: request.occurredAt, expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString() } });
      }
      return LiveWorkflowResultSchema.parse({ workflowVersion: run.input.workflowVersion, providerContractVersion: "providers/v1", runId: run.id, threadId: request.threadId, status: "bindings_collected", bindingFingerprints, authorizedIssueNumbers, waitingIssueNumbers, scheduledIssueNumbers: schedule.selectedIssueNumbers });
    },
  };
}

async function transitionLiveWorkItem(repository: SprintRunRepository, item: PersistedWorkItem, event: WorkItemTransitionRequest["event"], occurredAt: string): Promise<PersistedWorkItem> {
  const scope = `sprint-delivery/v1:${item.id}:${event}:${item.revision}`;
  const uuid = (part: string) => { const hash = createHash("sha256").update(`${scope}:${part}`).digest("hex"); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`; };
  return (await repository.transitionWorkItem({ workItemId: item.id, event, metadata: { transitionId: uuid("transition"), aggregateId: item.id, expectedRevision: item.revision, idempotencyKey: `workflow:${scope}`, occurredAt, actor: { kind: "system", id: "sprint-delivery/v1" }, evidence: [{ kind: "issue", uri: `work-item://${item.id}` }] }, outbox: { id: uuid("outbox"), type: "projection.update", payload: { workItemId: item.id, event }, idempotencyKey: `outbox:${scope}` } })).workItem;
}
