import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { OpenAiAnalysisAdapter } from "../dist/providers/v1/openai-analysis.js";

const run = (extra = {}) => spawnSync(process.execPath, ["dist/index.js", "--check"], {
  encoding: "utf8", timeout: 10_000,
  env: { PATH: process.env.PATH, NODE_ENV: "test", PROVIDER_MODE: "stub", ...extra },
});
assert.equal(run().status, 0);
for (const settings of [
  { CALLBACK_PROCESSING_ENABLED: "true" },
  { CALLBACK_PROCESSING_ENABLED: "false", CALLBACK_RUNTIME_MODE: "processor" },
  { CALLBACK_PROCESSING_ENABLED: "sk-fake-secret hostile input" },
]) {
  const result = run(settings);
  if (settings.CALLBACK_PROCESSING_ENABLED === "false") { assert.equal(result.status, 0); continue; }
  assert.notEqual(result.status, 0);
  assert.ok(!`${result.stdout}${result.stderr}`.includes("sk-fake-secret"));
}
// Load the actual compiled dependency graph in Node, without TypeScript transforms.
const imported = spawnSync(process.execPath, ["--input-type=module", "-e",
  "await import('./dist/runtime/v1/canonical-callback-resolver.js'); await import('./dist/runtime/v1/callback-runtime.js'); await import('./dist/runtime/v1/callback-projection.js');"],
{ encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH } });
assert.equal(imported.status, 0, "compiled callback modules must load");
process.stdout.write("Compiled callback startup and module checks passed.\n");

// Exercise the supervised prerequisite through compiled code, entirely offline.
const hash = "b".repeat(64);
const feasibility = { feasible: true, dependencies: [], conflicts: [], risk: { categories: ["ordinary"], confidence: "high", rationale: "fixture" },
  unresolvedDecisions: [], evidenceUris: [], provenance: { model: "gpt-5.6-terra", modelVersion: "fixture", policyVersion: "providers/v1", artifactSha256: hash, usage: { inputTokens: 1, outputTokens: 1 } } };
const adapter = new OpenAiAnalysisAdapter({ version: "openai-analysis/v1", projectId: "proj_abcdefgh",
  credentialReference: "ai-delivery-orchestrator/pilot/portal-openai-builder-api-key", timeoutMilliseconds: 1000, maxRetries: 0, maxOutputTokens: 1000 },
{ load: () => Promise.resolve("sk-abcdefghijklmnopqrstuvwxyz") },
{ load: () => Promise.resolve({ kind: "issue_bundle", sha256: hash, bytes: "synthetic fixture" }) },
{ request: () => Promise.resolve({ status: 200, body: JSON.stringify({ model: "gpt-5.6-terra", status: "completed", output: [
  { type: "reasoning", summary: [] },
  { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(feasibility) }] },
] }) }) });
assert.deepEqual(await adapter.analyzeFeasibility({ version: "providers/v1", repository: "todd-brunia/ai-consulting-client-portal", issueNumbers: [142], planFingerprints: { 142: hash }, defaultBranchSha: "a".repeat(40) }), feasibility);
process.stdout.write("Compiled offline Responses REST fixture passed.\n");
