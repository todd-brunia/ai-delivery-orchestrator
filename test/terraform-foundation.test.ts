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
  const publishWorkflow = read(".github/workflows/publish-worker-image.yml");
  const bootstrapRunbook = read("docs/terraform-bootstrap.md");

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
    expect(pilot).not.toMatch(/aws_nat_gateway/);
  });

  it("provisions a protected isolated Aurora Serverless v2 database", () => {
    expect(pilot).toContain('resource "aws_rds_cluster" "application"');
    expect(pilot).toContain('engine                          = "aurora-postgresql"');
    expect(pilot).toContain("manage_master_user_password     = true");
    expect(pilot).toContain("storage_encrypted               = true");
    expect(pilot).toContain("deletion_protection             = true");
    expect(pilot).toContain("skip_final_snapshot             = false");
    expect(pilot).toContain("copy_tags_to_snapshot           = true");
    expect(pilot).toContain("serverlessv2_scaling_configuration");
    expect(pilot).toContain("publicly_accessible  = false");
    expect(pilot).toContain("referenced_security_group_id = each.value");
    expect(pilot).not.toMatch(/^\s*(?:master_)?password\s*=/im);
    expect(pilot).not.toMatch(/cidr_ipv4\s*=\s*"0\.0\.0\.0\/0"[\s\S]{0,100}5432/);
  });

  it("provisions encrypted FIFO queues, DLQs, and non-authoritative coordination", () => {
    expect(pilot).toContain('resource "aws_sqs_queue" "runtime"');
    expect(pilot).toContain('resource "aws_sqs_queue" "dead_letter"');
    expect(pilot).toContain("fifo_queue                  = true");
    expect(pilot).toContain("content_based_deduplication = false");
    expect(pilot).toContain("maxReceiveCount     = 5");
    expect(pilot).toContain("sqs_managed_sse_enabled");
    expect(pilot).toContain('resource "aws_dynamodb_table" "runtime_coordination"');
    expect(pilot).toContain('attribute_name = "expiresAtEpochSeconds"');
    expect(pilot).toContain("point_in_time_recovery");
    expect(pilot).toContain("deletion_protection_enabled = true");
  });

  it("provisions inert private workers with bounded scale-to-zero capacity", () => {
    expect(pilot).toContain('resource "aws_ecs_service" "worker"');
    expect(pilot).toContain("desired_count   = 0");
    expect(pilot).toContain("min_capacity       = 0");
    expect(pilot).toContain("max_capacity       = 2");
    expect(pilot).toContain("assign_public_ip = false");
    expect(pilot).toContain('"${aws_ecr_repository.worker.repository_url}:${var.worker_image_sha}"');
    expect(pilot).toContain("stopTimeout = 60");
    expect(pilot).not.toContain(":latest");
  });

  it("exposes only bounded webhook ingress through API Gateway and Lambda", () => {
    expect(pilot).toContain('route_key = "POST /github/webhooks"');
    expect(pilot).toContain('payload_format_version = "2.0"');
    expect(pilot).toContain("reserved_concurrent_executions = 5");
    expect(pilot).toContain('entry_point = ["node_modules/.bin/aws-lambda-ric"]');
    expect(pilot).toContain('command     = ["dist/github/webhooks/v1/lambda-handler.handler"]');
    expect(pilot).toContain('WEBHOOK_SECRET_ARN');
    expect(pilot).toContain('CALLBACK_QUEUE_URL');
    expect(pilot).toContain('source_arn    = "${aws_apigatewayv2_api.operator.execution_arn}/*/POST/github/webhooks"');
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

  it("rejects delete and replacement actions before ordinary saved plans are applied", () => {
    expect(applyWorkflow).toContain("Reject destructive pilot IAM plan");
    expect(applyWorkflow).toContain("Reject destructive pilot plan");
    expect(applyWorkflow.match(/show -json pilot(?:-iam)?\.tfplan/g)).toHaveLength(2);
    expect(applyWorkflow.match(/index\("delete"\)/g)).toHaveLength(2);
    expect(applyWorkflow.indexOf("Reject destructive pilot IAM plan")).toBeGreaterThan(applyWorkflow.indexOf("Plan pilot IAM for selected commit"));
    expect(applyWorkflow.indexOf("Reject destructive pilot IAM plan")).toBeLessThan(applyWorkflow.indexOf("Apply selected pilot IAM plan"));
    expect(applyWorkflow.indexOf("Reject destructive pilot plan")).toBeGreaterThan(applyWorkflow.indexOf("Plan selected commit"));
    expect(applyWorkflow.indexOf("Reject destructive pilot plan")).toBeLessThan(applyWorkflow.indexOf("Apply selected plan"));
    expect(destroyWorkflow).not.toContain("Reject destructive");
  });

  it("creates named secret containers without managing values", () => {
    expect(pilot).toContain('resource "aws_secretsmanager_secret" "application"');
    for (const name of ["github-app-private-key", "github-app-builder-private-key", "github-app-reviewer-private-key", "github-app-merger-private-key", "github-webhook-secret", "openai-api-key"]) {
      expect(pilot).toContain(`"${name}"`);
    }
    expect(pilot).toContain("recovery_window_in_days = 30");
    expect(pilot).not.toMatch(/aws_secretsmanager_secret_version|secret_string|secret_binary/i);
    expect(pilotIam).toContain('"github-app-builder-private-key"');
    expect(pilotIam).not.toContain('"github-app-reviewer-private-key"');
    expect(pilotIam).not.toContain('"github-app-merger-private-key"');
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

  it("uses the exact ECR repository ARN for plan, apply, and publish permissions", () => {
    const expectedArn = "repository/ai-delivery-orchestrator-worker";
    expect(bootstrap.match(new RegExp(expectedArn, "g"))).toHaveLength(3);
    expect(bootstrap).not.toContain("repository/ai-delivery-orchestrator-pilot-worker");
  });

  it("trusts immutable main only for dedicated ECR publication", () => {
    const publishTrust = bootstrap.slice(bootstrap.indexOf('data "aws_iam_policy_document" "github_publish_trust"'));
    expect(publishTrust).toContain('values   = ["repo:${local.github_immutable_repository}:ref:refs/heads/main"]');
    expect(publishTrust).not.toContain(":pull_request");
    expect(publishTrust).not.toContain(":ref:refs/heads/*");
    expect(publishTrust).not.toContain('repo:${var.github_repository}');
    expect(publishTrust).not.toMatch(/identifiers\s*=\s*\["\*"\]/);
    expect(bootstrap).toContain('name                 = "ai-delivery-orchestrator-ecr-publish"');
    expect(bootstrap).toContain('output "github_publish_role_arn"');
  });

  it("grants the publishing role only exact-repository ECR push authority", () => {
    const publishPolicy = bootstrap.slice(bootstrap.indexOf('data "aws_iam_policy_document" "github_publish"'));
    const expectedActions = [
      "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload",
      "ecr:DescribeImages", "ecr:GetAuthorizationToken", "ecr:InitiateLayerUpload",
      "ecr:PutImage", "ecr:UploadLayerPart",
    ];
    for (const action of expectedActions) {
      expect(publishPolicy).toContain(`"${action}"`);
    }
    const actualActions = [...publishPolicy.matchAll(/"(ecr:[A-Za-z]+)"/g)].flatMap((match) => match[1] ? [match[1]] : []);
    expect(actualActions.sort()).toEqual(expectedActions.sort());
    expect(publishPolicy.match(/resources\s*=\s*\["\*"\]/g)).toHaveLength(1);
    expect(publishPolicy).toContain("repository/ai-delivery-orchestrator-worker");
    expect(publishPolicy).not.toMatch(/ecr:(?:Create|Delete|PutLifecyclePolicy|TagResource|UntagResource)/);
    expect(publishPolicy).not.toMatch(/s3:|iam:|ec2:|secretsmanager:/);
  });

  it("publishes only an immutable full-main-SHA image with pinned actions", () => {
    expect(publishWorkflow).toMatch(/on:\n\s{2}push:\n\s{4}branches: \[main\]/);
    expect(publishWorkflow).not.toMatch(/pull_request:|workflow_dispatch:/);
    expect(publishWorkflow).toContain("contents: read");
    expect(publishWorkflow).toContain("id-token: write");
    expect(publishWorkflow).toContain("role-to-assume: ${{ vars.AWS_ECR_PUBLISH_ROLE_ARN }}");
    expect(publishWorkflow).not.toMatch(/AWS_TERRAFORM_(?:PLAN|APPLY)_ROLE_ARN/);
    expect(publishWorkflow).toContain('test "${#SELECTED_SHA}" -eq 40');
    expect(publishWorkflow).toContain('test "$(git rev-parse HEAD)" = "$SELECTED_SHA"');
    expect(publishWorkflow).toContain("${{ env.ECR_REPOSITORY }}:${{ github.sha }}");
    expect(publishWorkflow).not.toMatch(/tags:.*latest/);
    expect(publishWorkflow).toContain("ImageNotFoundException");
    expect(publishWorkflow).toContain("refusing to overwrite or accept it");
    expect(publishWorkflow).toContain('mask-password: "true"');
    expect(publishWorkflow).toContain("cancel-in-progress: false");
    expect(publishWorkflow).not.toMatch(/access-key-id|secret-access-key|terraform apply|terraform destroy/);
    const actionReferences = [...publishWorkflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)].flatMap((match) => match[1] ? [match[1]] : []);
    expect(actionReferences).toHaveLength(5);
    expect(actionReferences.every((reference) => /^[0-9a-f]{40}$/.test(reference))).toBe(true);
  });

  it("grants provider-required reads only on existing pilot scopes", () => {
    const applyPolicy = bootstrap.slice(bootstrap.indexOf('data "aws_iam_policy_document" "github_apply"'));
    expect(bootstrap.match(/secretsmanager:GetResourcePolicy/g)).toHaveLength(2);
    expect(bootstrap.match(/budgets:ViewBudget/g)).toHaveLength(2);
    expect(bootstrap.match(/budgets:ListTagsForResource/g)).toHaveLength(2);
    expect(applyPolicy.match(/budgets:ListTagsForResource/g)).toHaveLength(1);
    expect(bootstrap).toContain("secret:ai-delivery-orchestrator/pilot/*");
    expect(bootstrap).toContain("budget/ai-delivery-orchestrator-pilot-monthly");
  });

  it("documents the exact four-address tainted-state recovery contract", () => {
    expect(bootstrapRunbook).toContain("exactly the four tainted");
    expect(bootstrapRunbook).toContain("aws_budgets_budget.monthly");
    for (const name of ["github-app-private-key", "github-webhook-secret", "openai-api-key"]) {
      expect(bootstrapRunbook).toContain(`aws_secretsmanager_secret.application[\\"${name}\\"]`);
    }
    expect(bootstrapRunbook.match(/length == 23/g)).toHaveLength(2);
    expect(bootstrapRunbook).toContain('select(.status == "tainted")] | length == 0');
    expect(bootstrapRunbook).toContain("0 to add, 0 to change, 0 to destroy");
  });

  it("masks the protected budget email in mutation workflows", () => {
    for (const workflow of [applyWorkflow, destroyWorkflow]) {
      expect(workflow).toContain("TF_VAR_budget_notification_email: ${{ secrets.BUDGET_NOTIFICATION_EMAIL }}");
      expect(workflow).toContain("BUDGET_NOTIFICATION_EMAIL: ${{ secrets.BUDGET_NOTIFICATION_EMAIL }}");
      expect(workflow).not.toContain("${{ vars.BUDGET_NOTIFICATION_EMAIL }}");
      expect(workflow).not.toMatch(/-var=.*budget_notification_email/);
      expect(workflow).not.toMatch(/echo.*BUDGET_NOTIFICATION_EMAIL/);
    }
    expect(planWorkflow).toContain("TF_VAR_budget_notification_email: terraform-plan@example.invalid");
  });

  it("bounds logs, alarms, and budget notifications", () => {
    expect(pilot).toContain("retention_in_days = var.log_retention_days");
    expect(pilot).toContain('namespace           = "AWS/Billing"');
    expect(pilot).toContain("alarm_actions       = var.alarm_action_arns");
    expect(pilot).toContain('resource "aws_budgets_budget" "monthly"');
    expect(pilot).toContain("subscriber_email_addresses = [var.budget_notification_email]");
    expect(pilot).not.toMatch(/aws_lambda_function\s+"operator/);
  });
});
