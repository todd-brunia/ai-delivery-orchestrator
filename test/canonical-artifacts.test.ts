import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CanonicalGitHubArtifactSource, type GitHubReadPort } from "../src/providers/v1/index.js";

const repository = "todd-brunia/ai-consulting-client-portal";
const sha = "a".repeat(40);
const planHash = "b".repeat(64);
const diffHash = "c".repeat(64);
const now = "2026-08-26T12:00:00.000Z";

function source(): CanonicalGitHubArtifactSource {
  const github: Pick<GitHubReadPort, "getIssue" | "getMarkedPlan" | "getPullRequest" | "getExactDiff"> = {
    getIssue: async () => { await Promise.resolve(); return { version: "providers/v1" as const, repository, number: 70, nodeId: "I_70", title: "Issue", body: "Untrusted issue text", state: "open" as const, labels: ["approved"], updatedAt: now }; },
    getMarkedPlan: async () => { await Promise.resolve(); return { issueNumber: 70, commentId: "70", bodySha256: planHash, createdAt: now, updatedAt: now, evidence: { uri: "github://plan", observedAt: now, sha256: planHash } }; },
    getPullRequest: async () => { await Promise.resolve(); return { version: "providers/v1" as const, repository, number: 71, nodeId: "PR_71", issueNumber: 70, state: "open" as const, draft: false, baseSha: sha, headSha: "d".repeat(40), changedFiles: [], updatedAt: now }; },
    getExactDiff: async () => { await Promise.resolve(); return { repository, baseSha: sha, headSha: "d".repeat(40), sha256: diffHash, files: [{ path: "src/file.ts", status: "modified" as const, patch: "@@" }], evidence: { uri: "github://diff", observedAt: now, sha256: diffHash } }; },
  };
  return new CanonicalGitHubArtifactSource(github as GitHubReadPort);
}

describe("canonical model artifacts", () => {
  it("builds a deterministic issue bundle only after fresh plan validation", async () => {
    const artifact = await source().load({ version: "providers/v1", repository, issueNumbers: [70], planFingerprints: { "70": planHash }, defaultBranchSha: sha });
    expect(artifact.kind).toBe("issue_bundle");
    expect(artifact.sha256).toBe(createHash("sha256").update(artifact.bytes).digest("hex"));
    expect(artifact.bytes).toContain("Untrusted issue text");
  });

  it("rejects a changed exact diff before review material reaches the model", async () => {
    await expect(source().load({ version: "providers/v1", repository, pullRequestNumber: 71, baseSha: sha, headSha: "d".repeat(40), diffSha256: "e".repeat(64), planFingerprint: planHash })).rejects.toThrow("drifted");
  });
});
