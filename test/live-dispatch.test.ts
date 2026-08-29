import { describe, expect, it } from "vitest";

import type { RepositoryAdapterConfigV1 } from "../src/domain/sprint-delivery/v1/index.js";
import type { FeasibilityResult } from "../src/providers/v1/index.js";
import { advanceAcceptedImplementationDispatch, adapterFingerprint, authorizeLiveBuild, collectLiveWorkItemBinding, prepareImplementationDispatch, verifyAcceptedImplementationDispatch } from "../src/workflows/index.js";

const sha = "a".repeat(40);
const plan = "b".repeat(64);
const repository = "todd-brunia/ai-consulting-client-portal";
const adapter = {
  version: 1, repository, defaultBranch: "main", enabled: true, orchestratorAppSlug: "ai-delivery-orchestrator",
  workflows: { implementation: "implementation.yml", repair: "repair.yml", sync: "sync.yml" },
  labels: { needsPlanning: "needs-planning", planReady: "plan-ready", approvedForBuild: "approved-for-build", approvedForAiBuild: "approved-for-ai-build", inProgress: "in-progress", previewReady: "preview-ready", needsDecision: "needs-decision", blocked: "blocked" },
  requiredChecks: ["CI Gate"], maxParallelImplementations: 2,
  risk: { humanApprovalCategories: ["security"], humanApprovalLabels: ["approved-for-build"], humanApprovalPathPatterns: [".github/**"] },
} satisfies RepositoryAdapterConfigV1;
const binding = {
  version: "live-work-item-binding/v1" as const, runId: "00000000-0000-4000-8000-000000000001", workItemId: "00000000-0000-4000-8000-000000000002",
  issue: { version: "providers/v1" as const, repository, number: 72, nodeId: "I_72", title: "Test", body: "untrusted", state: "open" as const, labels: ["approved-for-ai-build"], updatedAt: "2026-08-29T12:00:00Z" },
  plan: { issueNumber: 72, commentId: "72", bodySha256: plan, createdAt: "2026-08-29T11:00:00Z", updatedAt: "2026-08-29T11:00:00Z", evidence: { uri: "github://issue/72/comment/72", observedAt: "2026-08-29T12:00:00Z" } },
  defaultBranchSha: sha,
  repositoryConfiguration: { repository, repositoryId: "123", defaultBranch: "main", visibility: "private" as const, allowSquashMerge: true, archive: false, configurationSha256: "c".repeat(64), evidence: { uri: "github://repo/123", observedAt: "2026-08-29T12:00:00Z" } },
  installation: { appId: "456", installationId: "789", accountLogin: "todd-brunia", repositoryId: "123", repository, permissions: { actions: "write", issues: "write" }, evidence: { uri: "github://installation/789", observedAt: "2026-08-29T12:00:00Z" } },
  adapterFingerprint: adapterFingerprint(adapter), observedAt: "2026-08-29T12:00:00Z",
};
const input = { version: "live-dispatch-preparation/v1" as const, binding, adapter, expectedAdapterFingerprint: binding.adapterFingerprint, expectedPlanSha256: plan, expectedDefaultBranchSha: sha, now: "2026-08-29T12:00:00Z", expiresAt: "2026-08-29T12:05:00Z" };

describe("live implementation dispatch preparation", () => {
  it("creates one bounded implementation-workflow intent from immutable evidence", () => {
    const result = prepareImplementationDispatch(input);
    expect(result).toMatchObject({ ready: true, intent: { type: "dispatch_workflow", workflow: "implementation.yml", ref: sha, issueNumber: 72 } });
    if (result.ready && result.intent.type === "dispatch_workflow") expect(result.intent.inputs).toMatchObject({ issue_number: "72", plan_sha256: plan });
  });

  it("fails closed on plan and installation-permission drift", () => {
    expect(prepareImplementationDispatch({ ...input, expectedPlanSha256: "d".repeat(64) })).toEqual({ ready: false, reason: "plan_drift" });
    expect(prepareImplementationDispatch({ ...input, binding: { ...binding, installation: { ...binding.installation, permissions: { actions: "read", issues: "write" } } } })).toEqual({ ready: false, reason: "installation_permission_missing" });
  });

  it("collects repository and installation identity into a canonical live binding", async () => {
    const github = { getIssue: () => Promise.resolve(binding.issue), getMarkedPlan: () => Promise.resolve(binding.plan), getRepositoryConfiguration: () => Promise.resolve(binding.repositoryConfiguration), getInstallation: () => Promise.resolve(binding.installation) };
    await expect(collectLiveWorkItemBinding({ github: github as never, adapter, runId: binding.runId, workItemId: binding.workItemId, issueNumber: 72, defaultBranchSha: sha, observedAt: binding.observedAt })).resolves.toMatchObject({ issue: binding.issue, plan: binding.plan, installation: binding.installation, adapterFingerprint: binding.adapterFingerprint });
    await expect(collectLiveWorkItemBinding({ github: { ...github, getRepositoryConfiguration: () => Promise.resolve({ ...binding.repositoryConfiguration, defaultBranch: "trunk" }) } as never, adapter, runId: binding.runId, workItemId: binding.workItemId, issueNumber: 72, defaultBranchSha: sha, observedAt: binding.observedAt })).rejects.toThrow("default branch drifted");
  });

  it("accepts a sensitive approval only when a human applied it after the current plan", async () => {
    const github = { getHumanBuildApprovals: () => Promise.resolve([{ issueNumber: 72, label: "approved-for-build" as const, actorLogin: "owner", actorType: "User" as const, occurredAt: "2026-08-29T12:01:00Z", evidence: { uri: "github://issue/72/event/1", observedAt: "2026-08-29T12:01:01Z" } }]) };
    const analysis: FeasibilityResult = { feasible: true, dependencies: [], conflicts: [{ issueNumber: 72, domains: [] }], risk: { categories: ["security"], confidence: "high", rationale: "fixture" }, unresolvedDecisions: [], evidenceUris: [], provenance: { model: "stub", modelVersion: "v1", policyVersion: "v1", artifactSha256: "f".repeat(64), usage: { inputTokens: 0, outputTokens: 0 } } };
    await expect(authorizeLiveBuild({ github: github as never, repository, issueNumber: 72, plan: binding.plan, analysis })).resolves.toEqual({ authorized: true });
  });

  it("requires canonical workflow-run acceptance evidence before marking a build dispatched", () => {
    const preparation = prepareImplementationDispatch(input);
    if (!preparation.ready || preparation.intent.type !== "dispatch_workflow") throw new Error("fixture intent is missing");
    const evidence = { intent: preparation.intent, acceptedAt: "2026-08-29T12:00:00Z", workflowRuns: [{ id: "99", workflowId: "11", workflowPath: ".github/workflows/implementation.yml", event: "workflow_dispatch", status: "queued", conclusion: null, headSha: sha, createdAt: "2026-08-29T12:00:01Z", updatedAt: "2026-08-29T12:00:01Z", evidence: { uri: "github://workflow-runs/99", observedAt: "2026-08-29T12:00:02Z" } }] };
    expect(verifyAcceptedImplementationDispatch(evidence)).toEqual({ accepted: true, workflowRunId: "99", evidenceUri: "github://workflow-runs/99" });
    expect(verifyAcceptedImplementationDispatch({ ...evidence, workflowRuns: [{ ...evidence.workflowRuns[0]!, headSha: "b".repeat(40) }] })).toEqual({ accepted: false, reason: "workflow_run_not_found" });
  });

  it("records accepted evidence before advancing the work item", async () => {
    const preparation = prepareImplementationDispatch(input);
    if (!preparation.ready) throw new Error("fixture intent is missing");
    const calls: string[] = [];
    const repository = { recordDispatchAttempt: async () => { await Promise.resolve(); calls.push("attempt"); return { duplicate: false }; }, transitionWorkItem: async () => { await Promise.resolve(); calls.push("transition"); return { workItem: { id: binding.workItemId, issueNumber: 72, state: "build_dispatched" as const, revision: 1 }, duplicate: false }; } };
    const result = await advanceAcceptedImplementationDispatch({ repository: repository as never, workItem: { id: binding.workItemId, issueNumber: 72, state: "ready_to_build", revision: 0 }, intent: preparation.intent, acceptedAt: "2026-08-29T12:00:00Z", workflowRuns: [{ id: "99", workflowId: "11", workflowPath: ".github/workflows/implementation.yml", event: "workflow_dispatch", status: "queued", conclusion: null, headSha: sha, createdAt: "2026-08-29T12:00:01Z", updatedAt: "2026-08-29T12:00:01Z", evidence: { uri: "github://workflow-runs/99", observedAt: "2026-08-29T12:00:02Z" } }] });
    expect(result).toEqual({ advanced: true });
    expect(calls).toEqual(["attempt", "transition"]);
  });
});
