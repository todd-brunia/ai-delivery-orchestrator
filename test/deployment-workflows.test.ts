import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(join(process.cwd(), ".github/workflows", name), "utf8");
const deploy = read("deploy-pilot.yml");
const rollback = read("rollback-pilot.yml");
const terraformApply = read("terraform-apply.yml");

describe("protected pilot deployment workflows", () => {
  it("dispatches only through the protected non-cancelling environment", () => {
    for (const workflow of [deploy, rollback]) {
      expect(workflow).toContain("workflow_dispatch:");
      expect(workflow).not.toMatch(/^\s*(push|pull_request|schedule):/m);
      expect(workflow).toContain("environment: pilot");
      expect(workflow).toContain("group: terraform-apply-pilot");
      expect(workflow).toContain("cancel-in-progress: false");
      expect(workflow).toContain("AWS_RUNTIME_DEPLOY_ROLE_ARN");
      expect(workflow).toContain("ai-delivery-orchestrator-pilot-runtime-deploy");
      expect(workflow).not.toMatch(/access-key-id|secret-access-key/);
    }
  });
  it("binds deploy to current main and an expected immutable digest", () => {
    expect(deploy).toContain('test "$(git rev-parse origin/main)" = "$SELECTED_SHA"');
    expect(deploy).toContain("EXPECTED_DIGEST");
    expect(deploy).toContain("imageDigest");
    expect(deploy).toContain("pilot-deploy.tfplan");
    expect(deploy).toContain('index("delete")');
    expect(deploy).not.toMatch(/:latest|terraform destroy|force-unlock/);
  });
  it("allows only exact ECS task-definition revision replacements", () => {
    for (const workflow of [terraformApply, deploy, rollback]) {
      expect(workflow).toContain("allowed_task_definition_replacement");
      expect(workflow).toContain('aws_ecs_task_definition.worker');
      expect(workflow).toContain('aws_ecs_task_definition.migration');
      expect(workflow).toContain('["delete", "create"]');
      expect(workflow).toContain('select(allowed_task_definition_replacement | not)');
    }
    for (const workflow of [deploy, rollback]) {
      expect(workflow).toContain("disallowed_destructive");
      expect(workflow).toContain("unexpected");
    }
  });
  it("fails migration and smoke on nonzero results and returns capacity to zero", () => {
    expect(deploy).toContain("aws ecs wait tasks-stopped");
    expect(deploy.match(/containers\[0\]\.exitCode/g)).toHaveLength(2);
    expect(deploy).toContain('OBSERVABILITY_READY }}" = "true"');
    expect(deploy).toContain("--desired-count 0");
    expect(deploy).not.toMatch(/GITHUB_TOKEN|OPENAI_API_KEY/);
  });
  it("rolls back only application images without reversing migrations", () => {
    expect(rollback).toContain('test "$CURRENT_SHA" != "$ROLLBACK_SHA"');
    expect(rollback).toContain("pilot-rollback.tfplan");
    expect(rollback).toContain("without reverting migrations");
    expect(rollback).toContain("Migrations reverted: \\`false\\`");
    expect(rollback).not.toMatch(/db_cluster_snapshot|restore|terraform destroy|state rm|force-unlock/);
  });
  it("pins every third-party action to a full commit", () => {
    for (const workflow of [deploy, rollback]) {
      const references = [...workflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)].map((match) => match[1]);
      expect(references.length).toBeGreaterThan(0);
      expect(references.every((reference) => reference && /^[0-9a-f]{40}$/.test(reference))).toBe(true);
    }
  });
  it("bootstraps and then converges IAM without preconfigured generated identifiers", () => {
    expect(terraformApply).toContain("secret:rds!cluster:bootstrap");
    expect(terraformApply).toContain("github-webhook-secret-bootstrap");
    expect(terraformApply).not.toContain("vars.DATABASE_SECRET_ARN");
    expect(terraformApply).not.toContain("vars.WEBHOOK_SECRET_ARN");
    expect(terraformApply).toContain("Export concrete main-stack references");
    expect(terraformApply).toContain("database_master_secret_arn");
    expect(terraformApply).toContain("application_secret_arns");
    expect(terraformApply).toContain("pilot-iam-converged.tfplan");
    expect(terraformApply).toContain("Reject destructive converged pilot IAM plan");
    expect(terraformApply).toContain("Apply converged pilot IAM plan");
  });
});
