import { describe, expect, it } from "vitest";

import { PROVIDER_CONTRACT_VERSION, StubGitHubMutationAdapter, StubGitHubReadAdapter, StubModelAnalysisAdapter, createProviderSet } from "../src/providers/v1/index.js";

const repository = "todd-brunia/ai-consulting-client-portal";
const sha = "a".repeat(40);
const hash = "b".repeat(64);

describe("local provider foundation", () => {
  it("permits only stub composition", () => {
    expect(createProviderSet("stub")).toBeDefined();
    expect(() => createProviderSet("github")).toThrow();
  });

  it("returns isolated deterministic GitHub fixtures and fails closed", async () => {
    const stub = new StubGitHubReadAdapter();
    stub.registerIssue({ version: PROVIDER_CONTRACT_VERSION, repository, number: 81, nodeId: "I_81", title: "Issue", body: "Plan", state: "open", labels: ["plan-ready"], updatedAt: "2026-08-01T12:00:00Z" });
    const first = await stub.getIssue(repository, 81);
    first.labels.push("mutated");
    expect((await stub.getIssue(repository, 81)).labels).toEqual(["plan-ready"]);
    await expect(stub.getIssue(repository, 82)).rejects.toThrow("missing");
    expect(() => stub.registerIssue({ repository, number: 81 })).toThrow();
    stub.registerPullRequest({ version: PROVIDER_CONTRACT_VERSION, repository, number: 91, nodeId: "PR_91", issueNumber: 81, state: "open", draft: true, baseSha: sha, headSha: "c".repeat(40), changedFiles: ["src/index.ts"], updatedAt: "2026-08-01T12:00:00Z" });
    await expect(stub.getPullRequest(repository, 91)).resolves.toMatchObject({ issueNumber: 81 });
    await expect(stub.getPullRequest(repository, 92)).rejects.toThrow("missing");
  });

  it("captures proposed writes without executing them", async () => {
    const stub = new StubGitHubMutationAdapter();
    await stub.propose({ version: PROVIDER_CONTRACT_VERSION, idempotencyKey: "intent:12345678", repository, actorId: "run-1", type: "set_labels", issueNumber: 81, parameters: { labels: ["approved-for-build"] } });
    expect(stub.invocations()).toEqual([expect.objectContaining({ type: "set_labels" })]);
  });

  it("validates structured model fixtures without reasoning text", async () => {
    const stub = new StubModelAnalysisAdapter();
    const result = { feasible: true, dependencies: [], conflicts: [], risk: { categories: ["ordinary"], confidence: "high", rationale: "bounded" }, unresolvedDecisions: [], evidenceUris: ["issue://81"], provenance: { model: "stub", modelVersion: "fixture-v1", policyVersion: "sprint-delivery/v1", artifactSha256: hash, usage: { inputTokens: 0, outputTokens: 0 } } };
    stub.registerFeasibility(hash, result);
    const request = { version: PROVIDER_CONTRACT_VERSION, repository, issueNumbers: [81], planFingerprints: { "81": hash }, defaultBranchSha: sha };
    await expect(stub.analyzeFeasibility(request)).resolves.toEqual(result);
    expect(JSON.stringify(await stub.analyzeFeasibility(request))).not.toContain("reasoning");
    await expect(new StubModelAnalysisAdapter().analyzeFeasibility(request)).rejects.toThrow("missing");
    const review = { verdict: "pass", findings: [], evidenceUris: ["pr://91"], provenance: result.provenance };
    stub.registerReview(hash, review);
    await expect(stub.reviewPullRequest({ version: PROVIDER_CONTRACT_VERSION, repository, pullRequestNumber: 91, baseSha: sha, headSha: "c".repeat(40), diffSha256: hash, planFingerprint: hash })).resolves.toEqual(review);
    expect(stub.invocations()).toHaveLength(3);
    await expect(new StubModelAnalysisAdapter().reviewPullRequest({ version: PROVIDER_CONTRACT_VERSION, repository, pullRequestNumber: 91, baseSha: sha, headSha: "c".repeat(40), diffSha256: hash, planFingerprint: hash })).rejects.toThrow("missing");
  });
});
