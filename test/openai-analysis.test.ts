import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { OpenAiAnalysisAdapter } from "../src/providers/v1/index.js";

const repository = "todd-brunia/ai-consulting-client-portal";
const sha = "a".repeat(40);
const hash = "b".repeat(64);
const config = { version: "openai-analysis/v1", projectId: "proj_abcdefgh", credentialReference: "ai-delivery-orchestrator/pilot/portal-openai-reviewer-api-key", timeoutMilliseconds: 1_000, maxRetries: 1, maxOutputTokens: 1_000 } as const;
const provenance = { model: "gpt-5.6-terra", modelVersion: "fixture", policyVersion: "providers/v1", artifactSha256: hash, usage: { inputTokens: 1, outputTokens: 1 } };

class FixtureTransport {
  readonly calls: Array<{ headers: Readonly<Record<string, string>>; body: string }> = [];
  constructor(private readonly responses: { status: number; body: unknown }[]) {}
  request(input: { headers: Readonly<Record<string, string>>; body: string }): Promise<{ status: number; body: string }> {
    this.calls.push(input); const response = this.responses.shift() ?? { status: 500, body: {} };
    return Promise.resolve({ status: response.status, body: JSON.stringify(response.body) });
  }
}

function request() { return { version: "providers/v1" as const, repository, issueNumbers: [69], planFingerprints: { "69": hash }, defaultBranchSha: sha }; }

describe("OpenAI Responses analysis adapter", () => {
  it("uses strict, tool-free, non-stored requests and validates structured feasibility", async () => {
    const result = { feasible: true, dependencies: [], conflicts: [], risk: { categories: ["ordinary"], confidence: "high", rationale: "bounded" }, unresolvedDecisions: [], evidenceUris: ["issue://69"], provenance };
    const transport = new FixtureTransport([{ status: 200, body: { model: "gpt-5.6-terra", status: "completed", output_text: JSON.stringify(result) } }]);
    const adapter = new OpenAiAnalysisAdapter(config, { load: () => Promise.resolve("sk-abcdefghijklmnopqrstuvwxyz") }, { load: () => Promise.resolve({ kind: "issue_bundle", sha256: createHash("sha256").update("issue contents").digest("hex"), bytes: "issue contents" }) }, transport);
    await expect(adapter.analyzeFeasibility(request())).resolves.toEqual(result);
    const body = JSON.parse(transport.calls[0]!.body) as { store: boolean; tools: unknown[]; model: string; reasoning: { effort: string } };
    expect(body).toMatchObject({ store: false, tools: [], model: "gpt-5.6-terra", reasoning: { effort: "medium" } });
    expect(transport.calls[0]!.headers.authorization).not.toContain("issue contents");
  });

  it("retries only transient failures and rejects a resolved-model mismatch", async () => {
    const transport = new FixtureTransport([{ status: 429, body: {} }, { status: 200, body: { model: "unexpected", status: "completed", output_text: "{}" } }]);
    const adapter = new OpenAiAnalysisAdapter(config, { load: () => Promise.resolve("sk-abcdefghijklmnopqrstuvwxyz") }, { load: () => Promise.resolve({ kind: "issue_bundle", sha256: hash, bytes: "issue contents" }) }, transport);
    await expect(adapter.analyzeFeasibility(request())).rejects.toMatchObject({ code: "model_mismatch" });
    expect(transport.calls).toHaveLength(2);
  });
});
