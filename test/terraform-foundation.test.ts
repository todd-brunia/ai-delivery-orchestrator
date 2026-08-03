import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const allTerraform = (directory: string) => readdirSync(join(root, directory)).filter((name) => name.endsWith(".tf")).map((name) => read(join(directory, name))).join("\n");

describe("Terraform foundation policy", () => {
  const bootstrap = allTerraform("infra/bootstrap");
  const pilot = allTerraform("infra/environments/pilot");
  const planWorkflow = read(".github/workflows/terraform-plan.yml");
  const applyWorkflow = read(".github/workflows/terraform-apply.yml");

  it("protects and versions native-locking remote state", () => {
    expect(read("infra/environments/pilot/backend.tf")).toContain("use_lockfile = true");
    expect(bootstrap).toContain("prevent_destroy = true");
    expect(bootstrap).toContain('status = "Enabled"');
    expect(bootstrap).toContain("aws_s3_bucket_public_access_block");
    expect(bootstrap).toContain('sse_algorithm = "AES256"');
    expect(bootstrap).toContain('variable = "aws:SecureTransport"');
  });

  it("restricts GitHub OIDC trust to this repository's pull requests", () => {
    expect(bootstrap).toMatch(/values\s*=\s*\["sts\.amazonaws\.com"\]/);
    expect(bootstrap).toMatch(/values\s*=\s*\["repo:\$\{var\.github_repository\}:pull_request"\]/);
    expect(bootstrap).not.toMatch(/repo:\$\{var\.github_repository\}:\*/);
  });

  it("uses immutable scanned ECR and two-tier networking without compute or NAT", () => {
    expect(pilot).toContain('image_tag_mutability = "IMMUTABLE"');
    expect(pilot).toContain("scan_on_push = true");
    expect(pilot).toContain('resource "aws_subnet" "public"');
    expect(pilot).toContain('resource "aws_subnet" "isolated"');
    expect(pilot).not.toMatch(/aws_nat_gateway|aws_ecs_|aws_rds_|aws_lambda_|aws_apigateway/);
  });

  it("requires common ownership tags", () => {
    for (const value of [bootstrap, pilot]) {
      expect(value).toMatch(/Project\s*=\s*"ai-delivery-orchestrator"/);
      expect(value).toMatch(/ManagedBy\s*=\s*"terraform"/);
    }
  });

  it("trusts apply only through the protected pilot environment", () => {
    expect(bootstrap).toContain('values   = ["repo:${var.github_repository}:environment:${var.pilot_environment_name}"]');
    expect(bootstrap).not.toContain("environment:*");
    expect(applyWorkflow).toContain("environment: pilot");
    expect(applyWorkflow).toContain("role-to-assume: ${{ vars.AWS_TERRAFORM_APPLY_ROLE_ARN }}");
    expect(applyWorkflow).not.toMatch(/access-key-id|secret-access-key/);
  });

  it("plans pull requests without granting forked code AWS credentials", () => {
    expect(planWorkflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(planWorkflow).toContain("role-to-assume: ${{ vars.AWS_TERRAFORM_PLAN_ROLE_ARN }}");
    expect(planWorkflow).not.toContain("terraform apply");
  });

  it("applies an explicit reviewed main commit and its saved plan", () => {
    expect(applyWorkflow).toContain("workflow_dispatch:");
    expect(applyWorkflow).toContain("commit_sha:");
    expect(applyWorkflow).toContain('test "$(git rev-parse HEAD)" = "$SELECTED_SHA"');
    expect(applyWorkflow).toContain('test "$(git rev-parse origin/main)" = "$SELECTED_SHA"');
    expect(applyWorkflow).toContain("-out=pilot.tfplan");
    expect(applyWorkflow).toContain("apply -input=false -lock-timeout=5m pilot.tfplan");
  });

  it("creates named secret containers without managing values", () => {
    expect(pilot).toContain('resource "aws_secretsmanager_secret" "application"');
    for (const name of ["github-app-private-key", "github-webhook-secret", "openai-api-key"]) {
      expect(pilot).toContain(`"${name}"`);
    }
    expect(pilot).toContain("recovery_window_in_days = 30");
    expect(pilot).not.toMatch(/aws_secretsmanager_secret_version|secret_string|secret_binary/i);
  });

  it("keeps future runtime secret access scoped and unattached", () => {
    expect(pilot).toContain('["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]');
    expect(pilot).toContain("resources = values(aws_secretsmanager_secret.application)[*].arn");
    expect(pilot).not.toMatch(/resources\s*=\s*\["\*"\][\s\S]{0,200}GetSecretValue/);
    expect(pilot).not.toMatch(/aws_iam_(role_)?policy_attachment/);
  });

  it("bounds logs, alarms, and budget notifications", () => {
    expect(pilot).toContain("retention_in_days = var.log_retention_days");
    expect(pilot).toContain('namespace           = "AWS/Billing"');
    expect(pilot).toContain("alarm_actions       = var.alarm_action_arns");
    expect(pilot).toContain('resource "aws_budgets_budget" "monthly"');
    expect(pilot).toContain("subscriber_email_addresses = [var.budget_notification_email]");
    expect(pilot).not.toMatch(/aws_lambda_|aws_ecs_|aws_rds_|aws_sqs_|aws_dynamodb_/);
  });
});
