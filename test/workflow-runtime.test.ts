import { randomUUID } from "node:crypto";

import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import { transitionSprintRun, transitionWorkItem, WORKFLOW_VERSION } from "../src/domain/sprint-delivery/v1/index.js";
import type { PersistedPlanningBinding, PersistedSprintRun, SavePlanningBindingRequest, SprintAnalysis, SprintRunRepository } from "../src/persistence/index.js";
import {
  PROVIDER_CONTRACT_VERSION,
  StubGitHubMutationAdapter,
  StubGitHubReadAdapter,
  StubModelAnalysisAdapter,
} from "../src/providers/v1/index.js";
import { createSprintDeliveryV1Runtime, DryRunWorkflowRequestSchema } from "../src/workflows/index.js";

const repositoryName = "todd-brunia/ai-consulting-client-portal";
const hash = "b".repeat(64);
const sha = "a".repeat(40);

class MemoryRepository implements SprintRunRepository {
  analysis?: SprintAnalysis;
  bindings = new Map<string, PersistedPlanningBinding>();
  run: PersistedSprintRun = {
    id: randomUUID(),
    input: { workflowVersion: WORKFLOW_VERSION, repository: repositoryName, issueNumbers: [81], mergePolicy: "human" },
    state: "accepted",
    revision: 0,
    createdAt: "2026-08-05T12:00:00.000Z",
    updatedAt: "2026-08-05T12:00:00.000Z",
    workItems: [{ id: randomUUID(), issueNumber: 81, state: "discovered", revision: 0 }],
  };

  getRun(id: string) { return Promise.resolve(id === this.run.id ? structuredClone(this.run) : undefined); }
  saveAnalysis(_id: string, analysis: SprintAnalysis) { this.analysis = structuredClone(analysis); return Promise.resolve(); }
  transitionRun(request: Parameters<SprintRunRepository["transitionRun"]>[0]) {
    this.run = { ...this.run, state: transitionSprintRun(this.run.state, request.event), revision: this.run.revision + 1 };
    return Promise.resolve({ run: structuredClone(this.run), duplicate: false });
  }
  transitionWorkItem(request: Parameters<SprintRunRepository["transitionWorkItem"]>[0]) {
    const current = this.run.workItems[0]!;
    const workItem = { ...current, state: transitionWorkItem(current.state, request.event), revision: current.revision + 1 };
    this.run = { ...this.run, workItems: [workItem] };
    return Promise.resolve({ workItem: structuredClone(workItem), duplicate: false });
  }
  createRun(): Promise<PersistedSprintRun> { return Promise.reject(new Error("not implemented")); }
  listRunnableWorkItems() { return Promise.resolve([]); }
  claimOutbox() { return Promise.resolve([]); }
  completeOutbox() { return Promise.resolve(false); }
  retryOutbox() { return Promise.resolve(false); }
  blockOutbox() { return Promise.resolve(false); }
  tryAcquireLease() { return Promise.resolve(true); }
  savePlanningBinding(request: SavePlanningBindingRequest, now = new Date()) {
    const prior = this.bindings.get(request.workItemId);
    if (prior && prior.fingerprint !== request.fingerprint) return Promise.reject(new Error("immutable planning binding already exists with another fingerprint"));
    const binding = prior ?? { workItemId: request.workItemId, fingerprint: request.fingerprint, evidence: request.evidence, observedAt: request.observedAt, workItemRevision: request.expectedWorkItemRevision, createdAt: now.toISOString() };
    this.bindings.set(request.workItemId, binding);
    return Promise.resolve({ binding, duplicate: !!prior });
  }
  getPlanningBinding(workItemId: string) { return Promise.resolve(this.bindings.get(workItemId)); }
}

function providers(risk: "ordinary" | "security" = "ordinary") {
  const githubRead = new StubGitHubReadAdapter();
  githubRead.registerIssue({ version: PROVIDER_CONTRACT_VERSION, repository: repositoryName, number: 81, nodeId: "I_81", title: "Issue", body: "Plan", state: "open", labels: ["plan-ready"], updatedAt: "2026-08-05T12:00:00Z" });
  githubRead.registerMarkedPlan({ issueNumber: 81, commentId: "81", bodySha256: hash, createdAt: "2026-08-05T12:00:00Z", updatedAt: "2026-08-05T12:00:00Z", evidence: { uri: "github://issue/81/comment/81", observedAt: "2026-08-05T12:00:00Z" } });
  const modelAnalysis = new StubModelAnalysisAdapter();
  modelAnalysis.registerFeasibility(hash, { feasible: true, dependencies: [], conflicts: [{ issueNumber: 81, domains: [] }], risk: { categories: [risk], confidence: "high", rationale: "fixture" }, unresolvedDecisions: [], evidenceUris: ["issue://81"], provenance: { model: "stub", modelVersion: "fixture-v1", policyVersion: WORKFLOW_VERSION, artifactSha256: hash, usage: { inputTokens: 0, outputTokens: 0 } } });
  return { githubRead, githubMutation: new StubGitHubMutationAdapter(), modelAnalysis };
}

function request(runId: string) {
  return { workflowVersion: WORKFLOW_VERSION, providerMode: "stub" as const, runId, threadId: `run:${runId}`, defaultBranchSha: sha, planFingerprints: { "81": hash }, occurredAt: "2026-08-05T12:00:00Z" };
}

describe("sprint-delivery/v1 dry-run runtime", () => {
  it("executes a policy-authorized graph without calling a mutation provider", async () => {
    const repository = new MemoryRepository();
    const providerSet = providers();
    const result = await createSprintDeliveryV1Runtime(repository, providerSet, new MemorySaver()).execute(request(repository.run.id));
    expect(result).toMatchObject({ status: "active", issueNumbers: [81] });
    expect(repository.analysis).toEqual({ dependencies: [], conflicts: [{ issueNumber: 81, domains: [] }] });
    expect(providerSet.githubMutation.invocations()).toEqual([]);
    expect(repository.run.workItems[0]?.state).toBe("ready_to_build");
    expect(repository.bindings.get(repository.run.workItems[0]!.id)).toMatchObject({ evidence: { defaultBranchSha: sha, plan: { bodySha256: hash } } });
  });

  it("routes sensitive analysis to human approval", async () => {
    const repository = new MemoryRepository();
    const result = await createSprintDeliveryV1Runtime(repository, providers("security"), new MemorySaver()).execute(request(repository.run.id));
    expect(result.status).toBe("waiting_for_human");
    expect(repository.run.workItems[0]?.state).toBe("human_plan_approval_required");
  });

  it("fails closed on unsupported providers and mismatched issue fingerprints", async () => {
    const repository = new MemoryRepository();
    expect(() => DryRunWorkflowRequestSchema.parse({ ...request(repository.run.id), providerMode: "github" })).toThrow();
    await expect(createSprintDeliveryV1Runtime(repository, providers(), new MemorySaver()).execute({ ...request(repository.run.id), planFingerprints: { "82": hash } })).rejects.toThrow("exactly match");
  });

  it("fails closed when the canonical marked plan no longer matches the immutable request", async () => {
    const repository = new MemoryRepository();
    await expect(createSprintDeliveryV1Runtime(repository, providers(), new MemorySaver()).execute({ ...request(repository.run.id), planFingerprints: { "81": "c".repeat(64) } })).rejects.toThrow("canonical marked plan drifted");
  });
});
