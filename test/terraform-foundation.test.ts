import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const allTerraform = (directory: string) => readdirSync(join(root, directory)).filter((name) => name.endsWith(".tf")).map((name) => read(join(directory, name))).join("\n");

describe("Terraform foundation policy", () => {
  const bootstrap = allTerraform("infra/bootstrap");
  const pilot = allTerraform("infra/environments/pilot");
  const pilotIam = allTerraform("infra/environments/pilot-iam");
  const planWorkflow = read(".github/workflows/terraform-plan.yml");
  const applyWorkflow = read(".github/workflows/terraform-apply.yml");
  const destroyWorkflow = read(".github/workflows/terraform-destroy.yml");

  it("protects and versions native-locking remote state", () => {
    expect(read("infra/environments/pilot/backend.tf")).toContain("use_lockfile = true");
    expect(read("infra/environments/pilot-iam/backend.tf")).toContain("use_lockfile = true");
    expect(read("infra/environments/pilot/backend.tf")).toContain('key          = "pilot/terraform.tfstate"');
    expect(read("infra/environments/pilot-iam/backend.tf")).toContain('key          = "pilot-iam/terraform.tfstate"');
    expect(bootstrap).toContain("prevent_destroy = true");
    expect(bootstrap).toContain('status = "Enabled"');
    expect(bootstrap).toContain("aws_s3_bucket_public_access_block");
    expect(bootstrap).toContain('sse_algorithm = "AES256"');
    expect(bootstrap).toContain('variable = "aws:SecureTransport"');
  });

  it("restricts GitHub OIDC trust to this repository's pull requests", () => {
    expect(bootstrap).toMatch(/values\s*=\s*\["sts\.amazonaws\.com"\]/);
    expect(bootstrap).toContain('github_immutable_repository = "${local.github_repository_parts[0]}@${var.github_repository_owner_id}/${local.github_repository_parts[1]}@${var.github_repository_id}"');
    expect(bootstrap).toMatch(/values\s*=\s*\["repo:\$\{local\.github_immutable_repository\}:pull_request"\]/);
    expect(bootstrap).not.toContain('repo:${var.github_repository}:pull_request');
    expect(bootstrap).not.toMatch(/repo:\$\{local\.github_immutable_repository\}:\*/);
  });

  it("uses immutable scanned ECR and two-tier networking without compute or NAT", () => {
    expect(pilot).toContain('image_tag_mutability = "IMMUTABLE"');
    expect(pilot).toContain("scan_on_push = true");
    expect(pilot).toContain("force_delete         = true");
    expect(pilot).toContain('resource "aws_subnet" "public"');
    expect(pilot).toContain('resource "aws_subnet" "isolated"');
    expect(pilot).not.toMatch(/aws_nat_gateway|aws_ecs_|aws_rds_|aws_lambda_|aws_apigateway/);
  });

  it("requires common ownership tags", () => {
    for (const value of [bootstrap, pilot, pilotIam]) {
      expect(value).toMatch(/Project\s*=\s*"ai-delivery-orchestrator"/);
      expect(value).toMatch(/ManagedBy\s*=\s*"terraform"/);
    }
  });

  it("trusts apply only through the protected pilot environment", () => {
    expect(bootstrap).toContain('values   = ["repo:${local.github_immutable_repository}:environment:${var.pilot_environment_name}"]');
    expect(bootstrap).not.toContain('repo:${var.github_repository}:environment:');
    expect(bootstrap).not.toContain("environment:*");
    expect(applyWorkflow).toContain("environment: pilot");
    expect(applyWorkflow).toContain("role-to-assume: ${{ vars.AWS_TERRAFORM_APPLY_ROLE_ARN }}");
    expect(applyWorkflow).not.toMatch(/access-key-id|secret-access-key/);
  });

  it("validates immutable GitHub identity inputs without embedding live IDs", () => {
    expect(bootstrap).toContain('variable "github_repository_owner_id"');
    expect(bootstrap).toContain('variable "github_repository_id"');
    expect(bootstrap).toContain('regex("^[1-9][0-9]{0,19}$", var.github_repository_owner_id)');
    expect(bootstrap).toContain('regex("^[1-9][0-9]{0,19}$", var.github_repository_id)');
    expect(read("infra/bootstrap/terraform.tfvars.example")).toContain('github_repository_owner_id = "12345678"');
    expect(read("infra/bootstrap/terraform.tfvars.example")).toContain('github_repository_id       = "87654321"');
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
    expect(applyWorkflow).toContain("-out=pilot-iam.tfplan");
    expect(applyWorkflow).toContain("apply -input=false -lock-timeout=5m pilot-iam.tfplan");
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
    expect(pilotIam).toContain('["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]');
    expect(pilotIam).toContain("secret:ai-delivery-orchestrator/pilot/${name}-??????");
    expect(pilotIam).not.toMatch(/resources\s*=\s*\["\*"\][\s\S]{0,200}GetSecretValue/);
    expect(pilotIam).not.toMatch(/aws_iam_(role_)?policy_attachment/);
  });

  it("separates pilot IAM ownership behind an exact reference contract", () => {
    expect(pilot).not.toMatch(/resource\s+"aws_iam_/);
    expect(pilotIam).toContain('resource "aws_iam_policy" "runtime_secrets"');
    expect(pilot).toContain('variable "runtime_secret_policy_arn"');
    expect(pilot).toContain('var.runtime_secret_policy_arn == "arn:aws:iam::${var.aws_account_id}:policy/ai-delivery-orchestrator-pilot-runtime-secrets"');
    expect(pilot).not.toMatch(/terraform_remote_state/);
    expect(pilotIam).not.toMatch(/terraform_remote_state/);
  });

  it("fails closed and orders optional IAM provisioning before the main stack", () => {
    expect(applyWorkflow).toContain("provision_iam:");
    expect(applyWorkflow).toMatch(/provision_iam:[\s\S]*?default: false/);
    expect(applyWorkflow).toContain('test "$PILOT_IAM_STATE_ENABLED" = "true"');
    expect(applyWorkflow).toContain('test "$RUNTIME_SECRET_POLICY_ARN" = "arn:aws:iam::$AWS_ACCOUNT_ID:policy/ai-delivery-orchestrator-pilot-runtime-secrets"');
    expect(applyWorkflow.indexOf("Apply selected pilot IAM plan")).toBeLessThan(applyWorkflow.indexOf("Plan selected commit"));
    expect(applyWorkflow).toContain("TF_VAR_runtime_secret_policy_arn");
    expect(planWorkflow.indexOf("Create speculative pilot IAM plan")).toBeLessThan(planWorkflow.indexOf("Create speculative pilot plan"));
    expect(planWorkflow).toContain("vars.PILOT_IAM_STATE_ENABLED == 'true'");
    expect(planWorkflow).toContain("vars.PILOT_IAM_STATE_ENABLED != 'true'");
    expect(planWorkflow).toContain("mv infra/environments/pilot-iam/backend.tf infra/environments/pilot-iam/backend.tf.disabled");
    expect(planWorkflow).toContain("init -input=false -backend=false");
    expect(bootstrap).toContain("pilot-iam/terraform.tfstate");
    expect(bootstrap).toContain("pilot-iam/terraform.tfstate.tflock");
  });

  it("keeps pilot destruction manual, confirmed, and protected", () => {
    expect(destroyWorkflow).toContain("workflow_dispatch:");
    expect(destroyWorkflow).not.toMatch(/^\s*(pull_request|push|schedule):/m);
    expect(destroyWorkflow).toContain("environment: pilot");
    expect(destroyWorkflow).toContain('test "$CONFIRMATION" = "DESTROY PILOT"');
    expect(destroyWorkflow).toContain('test "$(git rev-parse origin/main)" = "$SELECTED_SHA"');
    expect(destroyWorkflow.indexOf("Verify commit is current main")).toBeLessThan(destroyWorkflow.indexOf("Assume protected apply role"));
    expect(destroyWorkflow).toContain("role-to-assume: ${{ vars.AWS_TERRAFORM_APPLY_ROLE_ARN }}");
    expect(destroyWorkflow).not.toMatch(/access-key-id|secret-access-key/);
  });

  it("applies saved destroy plans main-first with IAM retained by default", () => {
    expect(destroyWorkflow).toMatch(/destroy_iam:[\s\S]*?default: false/);
    expect(destroyWorkflow).toContain("plan -destroy -input=false -lock-timeout=5m -out=pilot-destroy.tfplan");
    expect(destroyWorkflow).toContain("apply -input=false -lock-timeout=5m pilot-destroy.tfplan");
    expect(destroyWorkflow).toContain("plan -destroy -input=false -lock-timeout=5m -out=pilot-iam-destroy.tfplan");
    expect(destroyWorkflow).toContain("apply -input=false -lock-timeout=5m pilot-iam-destroy.tfplan");
    expect(destroyWorkflow.indexOf("Apply saved pilot destroy plan")).toBeLessThan(destroyWorkflow.indexOf("Create saved pilot IAM destroy plan"));
    expect(destroyWorkflow).not.toContain("terraform destroy");
    expect(destroyWorkflow).not.toContain("infra/bootstrap");
    expect(destroyWorkflow).toContain("group: terraform-apply-pilot");
    expect(applyWorkflow).toContain("group: terraform-apply-pilot");
  });

  it("uses the exact ECR repository ARN for plan and apply permissions", () => {
    const expectedArn = "repository/ai-delivery-orchestrator-worker";
    expect(bootstrap.match(new RegExp(expectedArn, "g"))).toHaveLength(2);
    expect(bootstrap).not.toContain("repository/ai-delivery-orchestrator-pilot-worker");
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
