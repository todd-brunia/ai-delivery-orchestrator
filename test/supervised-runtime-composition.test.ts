import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("protected supervised runtime composition", () => {
  const cli = read("src/runtime/v1/supervised-dispatch-cli.ts");
  const compute = read("infra/environments/pilot/compute.tf");
  const iam = read("infra/environments/pilot-iam/runtime-roles.tf");

  it("loads only exact role-specific provider secrets and emits redacted failures", () => {
    expect(cli).toContain('ai-delivery-orchestrator/pilot/github-app-builder-private-key');
    expect(cli).toContain('ai-delivery-orchestrator/pilot/portal-openai-builder-api-key');
    expect(cli).not.toMatch(/github-app-(?:reviewer|merger)|portal-openai-reviewer/);
    expect(cli).toContain('new Set([githubKeyReference, openAiKeyReference])');
    expect(cli).toContain("supervisedFailureDiagnostic(error)");
    expect(cli).not.toContain("error.message");
    expect(cli).not.toContain("error.stack");
  });

  it("keeps execution off in the task and requires an explicit bounded command", () => {
    expect(compute).toContain('{ name = "SUPERVISED_DISPATCH_ENABLED", value = "false" }');
    expect(compute).not.toContain('name = "SUPERVISED_COMMAND_JSON"');
    expect(cli).toContain("SUPERVISED_COMMAND_JSON: z.string().min(2).max(16_384)");
    expect(cli).toContain("SupervisedDispatchCommandSchema.parse");
  });

  it("keeps trusted setup and PostgreSQL certificate validation inside the configuration boundary", () => {
    expect(cli).toContain('withinSupervisedStageSync("configuration"');
    expect(cli).toContain("loadSupervisedTlsCertificate()");
    expect(cli).toContain("rejectUnauthorized: true");
    expect(cli).not.toContain("us-east-1-bundle.pem");
  });

  it("attributes canonical reads through the static operation decorator", () => {
    expect(cli).toContain("instrumentSupervisedCanonicalReads(new GitHubAppReadAdapter");
    expect(cli).not.toContain("operation: error");
  });

  it("grants no queue, review, merge, or generic secret authority", () => {
    const policy = iam.slice(iam.indexOf('data "aws_iam_policy_document" "supervised_dispatch"'), iam.indexOf('data "aws_iam_policy_document" "worker_execution"'));
    expect(policy).toContain("secretsmanager:GetSecretValue");
    expect(policy).not.toMatch(/sqs:|github-app-reviewer|github-app-merger|openai-reviewer|\*"/);
  });
});
