import { describe, expect, it } from "vitest";

import type { RepositoryAdapterConfigV1 } from "../src/domain/sprint-delivery/v1/index.js";
import type { PersistedSprintRun, WorkflowNodeResult } from "../src/persistence/index.js";
import { SupervisedDispatchOperator } from "../src/runtime/v1/index.js";

const repositoryName = "todd-brunia/ai-consulting-client-portal";
const issueNumber = 142;
const branchSha = "a".repeat(40);
const planSha = "b".repeat(64);
const adapter = {
  version: 1,
  repository: repositoryName,
  defaultBranch: "main",
  enabled: true,
  orchestratorAppSlug: "ai-delivery-orchestrator",
  workflows: { implementation: "implementation.yml", repair: "repair.yml", sync: "sync.yml" },
  labels: { needsPlanning: "needs-planning", planReady: "plan-ready", approvedForBuild: "approved-for-build", approvedForAiBuild: "approved-for-ai-build", inProgress: "in-progress", previewReady: "preview-ready", needsDecision: "needs-decision", blocked: "blocked" },
  requiredChecks: ["CI Gate"],
  maxParallelImplementations: 1,
  risk: { humanApprovalCategories: ["security"], humanApprovalLabels: ["approved-for-build"], humanApprovalPathPatterns: [".github/**"] },
} satisfies RepositoryAdapterConfigV1;

function fixture(executionEnabled = true) {
  let run: PersistedSprintRun | undefined;
  let creates = 0;
  let workflowCalls = 0;
  const claimed: string[] = [];
  const nodeResults = new Map<string, WorkflowNodeResult>();
  const githubRead = {
    getIssue: () => Promise.resolve({ version: "providers/v1" as const, repository: repositoryName, number: issueNumber, nodeId: "I_142", title: "Supervised fixture", body: "untrusted", state: "open" as const, labels: ["approved-for-build"], updatedAt: "2026-08-31T21:32:16Z" }),
    getMarkedPlan: () => Promise.resolve({ issueNumber, commentId: "5484908830", bodySha256: planSha, createdAt: "2026-08-31T21:31:51Z", updatedAt: "2026-08-31T21:31:51Z", evidence: { uri: "github://issues/142/comments/5484908830", observedAt: "2026-08-31T21:33:00Z" } }),
    getRepositoryConfiguration: () => Promise.resolve({ repository: repositoryName, repositoryId: "1308170964", defaultBranch: "main", visibility: "public" as const, allowSquashMerge: true, archive: false, configurationSha256: "c".repeat(64), evidence: { uri: "github://repositories/1308170964/configuration", observedAt: "2026-08-31T21:33:00Z" } }),
    getInstallation: () => Promise.resolve({ appId: "123", installationId: "456", accountLogin: "todd-brunia", repositoryId: "1308170964", repository: repositoryName, permissions: { actions: "write", issues: "write" }, evidence: { uri: "github://installations/456", observedAt: "2026-08-31T21:33:00Z" } }),
    getHumanBuildApprovals: () => Promise.resolve([{ issueNumber, label: "approved-for-build" as const, actorLogin: "todd-brunia", actorType: "User" as const, occurredAt: "2026-08-31T21:32:16Z", evidence: { uri: "github://issues/142/events/1", observedAt: "2026-08-31T21:33:00Z" } }]),
  };
  const persistence = {
    getRun: () => Promise.resolve(run),
    createRun: (id: string, input: PersistedSprintRun["input"], now: Date) => {
      creates += 1;
      run = { id, input, state: "accepted", revision: 0, createdAt: now.toISOString(), updatedAt: now.toISOString(), workItems: [{ id: "00000000-0000-4000-8000-000000000142", issueNumber, state: "discovered", revision: 0 }] };
      return Promise.resolve(run);
    },
    getWorkflowNodeResult: (workItemId: string, node: string, key: string) => Promise.resolve(nodeResults.get(`${workItemId}:${node}:${key}`)),
    recordWorkflowNodeResult: (result: WorkflowNodeResult) => {
      const key = `${result.workItemId}:${result.node}:${result.idempotencyKey}`;
      const duplicate = nodeResults.has(key);
      nodeResults.set(key, result);
      return Promise.resolve({ duplicate });
    },
  };
  const operator = new SupervisedDispatchOperator({ executionEnabled, adapter }, {
    repository: persistence as never,
    githubRead: githubRead as never,
    modelAnalysis: { analyzeFeasibility: () => Promise.resolve({ feasible: true, dependencies: [], conflicts: [{ issueNumber, domains: [] }], risk: { categories: ["ordinary"] as const, confidence: "high" as const, rationale: "fixture" }, unresolvedDecisions: [], evidenceUris: [], provenance: { model: "stub", modelVersion: "v1", policyVersion: "v1", artifactSha256: "d".repeat(64), usage: { inputTokens: 0, outputTokens: 0 } } }) } as never,
    canonicalControl: { getDefaultBranchHead: () => Promise.resolve({ sha: branchSha, evidenceUri: "github://refs/main" }), assertWorkflowAtRef: () => Promise.resolve({ evidenceUri: "github://workflow/implementation.yml" }) },
    workflow: { execute: (request) => { workflowCalls += 1; if (!run || request.runId !== run.id) throw new Error("wrong durable run"); run = { ...run, workItems: [{ ...run.workItems[0]!, state: "dispatch_queued", revision: 4 }] }; return Promise.resolve({ workflowVersion: "sprint-delivery/v1", providerContractVersion: "providers/v1", runId: request.runId, threadId: request.threadId, status: "bindings_collected", bindingFingerprints: { [run.workItems[0]!.id]: "e".repeat(64) }, authorizedIssueNumbers: [issueNumber], waitingIssueNumbers: [], scheduledIssueNumbers: [issueNumber], dispatchOutboxIds: { [String(issueNumber)]: "00000000-0000-4000-8000-000000000999" } }); } },
    dispatchWorker: { drainExact: (actionId: string) => { claimed.push(actionId); return Promise.resolve([{ id: actionId, outcome: "completed" as const }]); } },
  });
  return { operator, counts: () => ({ creates, workflowCalls, claimed, nodeResults: nodeResults.size }) };
}

describe("supervised dispatch operator", () => {
  it("produces a stable, redacted, externally read-only preflight", async () => {
    const state = fixture();
    const first = await state.operator.run({ version: "supervised-dispatch-command/v1", mode: "preflight", repository: repositoryName, issueNumber, occurredAt: "2026-08-31T21:40:00Z" });
    const second = await state.operator.run({ version: "supervised-dispatch-command/v1", mode: "preflight", repository: repositoryName, issueNumber, occurredAt: "2026-08-31T21:41:00Z" });
    expect(first).toMatchObject({ mode: "preflight", preflight: { ready: true, issueNumber, defaultBranchSha: branchSha, workflow: "implementation.yml" } });
    expect(second.preflight.digest).toBe(first.preflight.digest);
    expect(JSON.stringify(first)).not.toContain("untrusted");
    expect(state.counts()).toEqual({ creates: 0, workflowCalls: 0, claimed: [], nodeResults: 0 });
  });

  it("binds one short-lived authorization to one durable run and exact outbox claim", async () => {
    const state = fixture();
    const checked = await state.operator.run({ version: "supervised-dispatch-command/v1", mode: "preflight", repository: repositoryName, issueNumber, occurredAt: "2026-08-31T21:40:00Z" });
    const result = await state.operator.run({ version: "supervised-dispatch-command/v1", mode: "execute", repository: repositoryName, issueNumber, occurredAt: "2026-08-31T21:42:00Z", authorization: { id: "owner-checkpoint-142", preflightDigest: checked.preflight.digest, authorizedAt: "2026-08-31T21:41:00Z", expiresAt: "2026-08-31T21:45:00Z" } });
    expect(result).toMatchObject({ mode: "execute", dispatchOutcome: "completed", workItemState: "dispatch_queued" });
    expect(state.counts()).toEqual({ creates: 1, workflowCalls: 1, claimed: ["00000000-0000-4000-8000-000000000999"], nodeResults: 1 });
  });

  it("fails closed on disabled execution, digest drift, and an outside repository", async () => {
    const state = fixture(false);
    const checked = await state.operator.run({ version: "supervised-dispatch-command/v1", mode: "preflight", repository: repositoryName, issueNumber, occurredAt: "2026-08-31T21:40:00Z" });
    expect(checked.preflight).toMatchObject({ ready: true, executionEnabled: false, blockers: [] });
    await expect(state.operator.run({ version: "supervised-dispatch-command/v1", mode: "execute", repository: repositoryName, issueNumber, occurredAt: "2026-08-31T21:42:00Z", authorization: { id: "owner-checkpoint-142", preflightDigest: "f".repeat(64), authorizedAt: "2026-08-31T21:41:00Z", expiresAt: "2026-08-31T21:45:00Z" } })).rejects.toThrow("execution is disabled");
    await expect(state.operator.run({ version: "supervised-dispatch-command/v1", mode: "preflight", repository: "other/repository", issueNumber, occurredAt: "2026-08-31T21:40:00Z" })).rejects.toThrow("outside supervised adapter audience");
  });
});
