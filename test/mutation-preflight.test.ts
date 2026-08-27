import { describe, expect, it } from "vitest";

import { CanonicalMutationPreflight, NoBlindRetryReconciler, fingerprintCanonicalMutationState, type GitHubExecutionIntent, type GitHubReadPort } from "../src/providers/v1/index.js";

const repository = "todd-brunia/ai-consulting-client-portal";
const hash = "b".repeat(64);
const now = "2026-08-27T12:00:00.000Z";
const policy = { version: "github-mutation-policy/v1", repository, repositoryId: "1308170964", appId: "4545788", installationId: "152627422", enabledOperations: ["set_labels"], workflowLabels: ["implementation-proposed"], workflows: [] } as const;

function github(): GitHubReadPort {
  const fixture: Pick<GitHubReadPort, "getInstallation" | "getRepositoryConfiguration" | "getIssue" | "getMarkedPlan"> = {
    getInstallation: async () => { await Promise.resolve(); return { appId: "4545788", installationId: "152627422", accountLogin: "todd-brunia", repositoryId: "1308170964", repository, permissions: { actions: "read" }, evidence: { uri: "github://installation", observedAt: now } }; },
    getRepositoryConfiguration: async () => { await Promise.resolve(); return { repository, repositoryId: "1308170964", defaultBranch: "main", visibility: "public" as const, allowSquashMerge: true, archive: false, configurationSha256: hash, evidence: { uri: "github://repository", observedAt: now, sha256: hash } }; },
    getIssue: async () => { await Promise.resolve(); return { version: "providers/v1" as const, repository, number: 69, nodeId: "I_69", title: "Issue", body: "body", state: "open" as const, labels: ["implementation-proposed"], updatedAt: now }; },
    getMarkedPlan: async () => { await Promise.resolve(); return { issueNumber: 69, commentId: "69", bodySha256: hash, createdAt: now, updatedAt: now, evidence: { uri: "github://plan", observedAt: now, sha256: hash } }; },
  };
  return fixture as GitHubReadPort;
}

describe("canonical mutation preflight", () => {
  it("allows only an exact fresh, allowlisted snapshot", async () => {
    const expectedStateSha256 = fingerprintCanonicalMutationState({ installation: { appId: "4545788", installationId: "152627422", permissions: { actions: "read" } }, configuration: hash, issue: { number: 69, state: "open", labels: ["implementation-proposed"], updatedAt: now, plan: hash } });
    const intent: GitHubExecutionIntent = { version: "github-mutation/v1", idempotencyKey: "mutation:12345678", repository, repositoryId: "1308170964", actorRole: "builder", type: "set_labels", issueNumber: 69, labels: ["implementation-proposed"], expectedStateSha256, expiresAt: "2026-08-27T13:00:00.000Z" };
    await expect(new CanonicalMutationPreflight(policy, github()).assertCurrent(intent)).resolves.toBeUndefined();
  });

  it("rejects unallowlisted labels and never turns an ambiguous result into permission to resend", async () => {
    const preflight = new CanonicalMutationPreflight(policy, github());
    const intent: GitHubExecutionIntent = { version: "github-mutation/v1", idempotencyKey: "mutation:12345678", repository, repositoryId: "1308170964", actorRole: "builder", type: "set_labels", issueNumber: 69, labels: ["owner"], expectedStateSha256: hash, expiresAt: "2026-08-27T13:00:00.000Z" };
    await expect(preflight.assertCurrent(intent)).rejects.toThrow("allowlisted");
    await expect(new NoBlindRetryReconciler({ assertCurrent: () => Promise.resolve() }).reconcile(intent)).resolves.toBe("ambiguous");
  });
});
