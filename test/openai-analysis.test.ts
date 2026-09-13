import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { OpenAiAnalysisAdapter } from "../src/providers/v1/index.js";
import { openAiResponseFailureReason, OpenAiAnalysisError } from "../src/providers/v1/openai-analysis.js";
import { supervisedFailureDiagnostic, withinSupervisedStage } from "../src/runtime/v1/supervised-diagnostics.js";

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
const result = { feasible: true, dependencies: [], conflicts: [], risk: { categories: ["ordinary"], confidence: "high", rationale: "bounded" }, unresolvedDecisions: [], evidenceUris: ["issue://69"], provenance };
const message = (text: string) => ({ id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const response = (text = JSON.stringify(result)) => ({ id: "resp_fixture", object: "response", model: "gpt-5.6-terra", status: "completed", error: null, incomplete_details: null, output: [message(text)] });
function fixture(body: unknown) {
  const transport = new FixtureTransport([{ status: 200, body }]);
  const adapter = new OpenAiAnalysisAdapter(config, { load: () => Promise.resolve("sk-abcdefghijklmnopqrstuvwxyz") }, { load: () => Promise.resolve({ kind: "issue_bundle", sha256: hash, bytes: "synthetic fixture" }) }, transport);
  return { adapter, transport };
}

describe("OpenAI Responses analysis adapter", () => {
  it.each([
    ["output_limit", { ...response(), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }],
    ["incomplete", { ...response(), status: "incomplete", incomplete_details: { reason: "private-sentinel" } }],
    ["response_envelope", { ...response(), output: [{ type: "function_call", arguments: "private-sentinel" }] }],
    ["refusal", { ...response(), output: [{ ...message(""), content: [{ type: "refusal", refusal: "private-sentinel" }] }] }],
    ["output_json", response("private-sentinel")],
    ["result_schema", response('{"private-sentinel":true}')],
    ["response_bounds", { ...response(), ignored: "x".repeat(1_000_001) }],
  ])("attributes %s without copying raw fields or relaxing rejection", async (reason, body) => {
    const { adapter, transport } = fixture(body);
    const error = await withinSupervisedStage("model_analysis", () => adapter.analyzeFeasibility(request())).catch((value: unknown) => value);
    const diagnostic = supervisedFailureDiagnostic(error);
    expect(diagnostic).toMatchObject({ stage: "model_analysis", category: "invalid_response", modelResponseReason: reason });
    expect(JSON.stringify(diagnostic)).not.toContain("private-sentinel");
    expect(transport.calls).toHaveLength(1);
  });
  it("does not accept forged reason properties", () => {
    expect(openAiResponseFailureReason(Object.assign(new OpenAiAnalysisError("invalid_response", "private-sentinel"), { modelResponseReason: "output_limit" }))).toBeUndefined();
  });
  it.each([false, true])("classifies timeout separately and keeps bounded transient retry: %s", async recover => {
    let calls = 0;
    const adapter = new OpenAiAnalysisAdapter(config, { load: () => Promise.resolve("sk-abcdefghijklmnopqrstuvwxyz") }, { load: () => Promise.resolve({ kind: "issue_bundle", sha256: hash, bytes: "fixture" }) }, { request: () => {
      calls += 1;
      if (recover && calls === 2) return Promise.resolve({ status: 200, body: JSON.stringify(response()) });
      throw new DOMException("private-sentinel", "TimeoutError");
    } });
    if (recover) await expect(adapter.analyzeFeasibility(request())).resolves.toEqual(result);
    else await expect(adapter.analyzeFeasibility(request())).rejects.toMatchObject({ code: "timeout", message: "OpenAI request timed out" });
    expect(calls).toBe(2);
  });
  it("uses strict, tool-free, non-stored requests and validates structured feasibility", async () => {
    const transport = new FixtureTransport([{ status: 200, body: response() }]);
    const adapter = new OpenAiAnalysisAdapter(config, { load: () => Promise.resolve("sk-abcdefghijklmnopqrstuvwxyz") }, { load: () => Promise.resolve({ kind: "issue_bundle", sha256: createHash("sha256").update("issue contents").digest("hex"), bytes: "issue contents" }) }, transport);
    await expect(adapter.analyzeFeasibility(request())).resolves.toEqual(result);
    const body = JSON.parse(transport.calls[0]!.body) as { store: boolean; tools: unknown[]; model: string; reasoning: { effort: string }; text: { format: { schema: { properties?: Record<string, unknown> } } } };
    expect(body).toMatchObject({ store: false, tools: [], model: "gpt-5.6-terra", reasoning: { effort: "medium" } });
    expect(Object.keys(body.text.format.schema.properties ?? {})).toContain("feasible");
    expect(transport.calls[0]!.headers.authorization).not.toContain("issue contents");
  });

  it("finds assistant text after reasoning and joins ordered text parts without exposing reasoning", async () => {
    const text = JSON.stringify(result);
    const body = { ...response(), output_text: "not authoritative", output: [
      { type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "private-reasoning-sentinel" }] },
      { ...message(text), content: [{ type: "output_text", text: text.slice(0, 20) }, { type: "output_text", text: text.slice(20) }] },
    ] };
    await expect(fixture(body).adapter.analyzeFeasibility(request())).resolves.toEqual(result);
  });

  it("handles the same REST envelope for review without changing the configured review model", async () => {
    const review = { verdict: "pass", findings: [], evidenceUris: [], provenance: { ...provenance, model: "gpt-5.6-sol" } };
    const { adapter, transport } = fixture({ ...response(JSON.stringify(review)), model: "gpt-5.6-sol" });
    await expect(adapter.reviewPullRequest({ version: "providers/v1", repository, pullRequestNumber: 1, baseSha: sha, headSha: "c".repeat(40), diffSha256: hash, planFingerprint: hash })).resolves.toEqual(review);
    expect(JSON.parse(transport.calls[0]!.body)).toMatchObject({ model: "gpt-5.6-sol", reasoning: { effort: "high" }, tools: [], store: false });
  });

  it.each([
    ["SDK-only shape", { model: "gpt-5.6-terra", status: "completed", output_text: JSON.stringify(result) }],
    ["incomplete", { ...response(), status: "incomplete" }],
    ["error", { ...response(), error: { message: "secret-sentinel" } }],
    ["incomplete details", { ...response(), incomplete_details: { reason: "max_output_tokens" } }],
    ["empty output", { ...response(), output: [] }],
    ["reasoning only", { ...response(), output: [{ type: "reasoning", summary: [{ text: "secret-sentinel" }] }] }],
    ["refusal", { ...response(), output: [{ ...message(""), content: [{ type: "refusal", refusal: "secret-sentinel" }] }] }],
    ["wrong role", { ...response(), output: [{ ...message(JSON.stringify(result)), role: "user" }] }],
    ["incomplete message", { ...response(), output: [{ ...message(JSON.stringify(result)), status: "in_progress" }] }],
    ["unexpected tool", { ...response(), output: [...response().output, { type: "function_call", arguments: "secret-sentinel" }] }],
    ["unknown content", { ...response(), output: [{ ...message(""), content: [{ type: "unknown", text: JSON.stringify(result) }] }] }],
    ["malformed JSON", response("secret-sentinel")],
    ["wrong result schema", response('{"secret-sentinel":true}')],
    ["oversized response", { ...response(), ignored: "x".repeat(1_000_001) }],
    ["ambiguous JSON answers", { ...response(), output: [message(JSON.stringify(result)), message(JSON.stringify(result))] }],
  ])("fails closed without retries or provider text for %s", async (_name, body) => {
    const { adapter, transport } = fixture(body);
    const error = await adapter.analyzeFeasibility(request()).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "invalid_response" });
    expect(String(error)).not.toContain("secret-sentinel");
    expect(transport.calls).toHaveLength(1);
  });

  it("retries only transient failures and rejects a resolved-model mismatch", async () => {
    const transport = new FixtureTransport([{ status: 429, body: {} }, { status: 200, body: { model: "unexpected", status: "completed", output_text: "{}" } }]);
    const adapter = new OpenAiAnalysisAdapter(config, { load: () => Promise.resolve("sk-abcdefghijklmnopqrstuvwxyz") }, { load: () => Promise.resolve({ kind: "issue_bundle", sha256: hash, bytes: "issue contents" }) }, transport);
    await expect(adapter.analyzeFeasibility(request())).rejects.toMatchObject({ code: "model_mismatch" });
    expect(transport.calls).toHaveLength(2);
  });
});
