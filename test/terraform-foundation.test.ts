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
    expect(bootstrap).toContain('resource "aws_iam_service_linked_role" "rds"');
    expect(bootstrap).toContain('aws_service_name = "rds.amazonaws.com"');
    expect(bootstrap).toContain('resource "aws_iam_service_linked_role" "ecs"');
    expect(bootstrap).toContain('aws_service_name = "ecs.amazonaws.com"');
    expect(bootstrap).toContain('resource "aws_iam_service_linked_role" "ecs_application_autoscaling"');
    expect(bootstrap).toContain('aws_service_name = "ecs.application-autoscaling.amazonaws.com"');
    expect(pilot).toContain('resource "aws_rds_cluster" "application"');
    expect(pilot).toContain('engine                          = "aurora-postgresql"');
    expect(pilot).toContain('default = "16.14"');
    expect(pilot).toContain("manage_master_user_password     = true");
    expect(pilot).toContain("storage_encrypted               = true");
    expect(pilot).toContain('data "aws_kms_alias" "rds"');
    expect(pilot).toContain('name = "alias/aws/rds"');
    expect(pilot).toContain('kms_key_id                      = data.aws_kms_alias.rds.target_key_arn');
    expect(pilot).toContain("deletion_protection             = var.database_deletion_protection");
    expect(pilot).toContain("skip_final_snapshot             = var.database_skip_final_snapshot");
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
    expect(pilot).toContain("deletion_protection_enabled = var.coordination_table_deletion_protection_enabled");
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

  it("covers pilot failure, backlog, recovery, and cost signals", () => {
    for (const namespace of ["AWS/Lambda", "AWS/ApiGateway", "AWS/SQS", "AWS/DynamoDB", "ECS/ContainerInsights", "AWS/RDS", "AiDeliveryOrchestrator/Pilot"]) {
      expect(pilot).toContain(namespace);
    }
    for (const metric of ["Errors", "Throttles", "Duration", "5xx", "Latency", "ApproximateAgeOfOldestMessage", "ApproximateNumberOfMessagesVisible", "RunningTaskCount", "AuroraWakeSeconds", "WorkerWakeToReadySeconds", "WorkerHeartbeatAgeSeconds", "ProjectionLagSeconds", "MigrationFailures", "BackupAgeHours", "TelemetryGap"]) {
      expect(pilot).toContain(metric);
    }
    expect(pilot).toContain('resource "aws_cloudwatch_dashboard" "pilot"');
    expect(pilot).toContain("alarm_actions       = var.alarm_action_arns");
    expect(pilot).toMatch(/threshold_type\s+= "PERCENTAGE"/);
    expect(pilot).toMatch(/notification_type\s+= "FORECASTED"/);
    expect(pilot).toMatch(/notification_type\s+= "ACTUAL"/);
  });

  it("provides private AWS service connectivity without a NAT gateway", () => {
    for (const service of ["ecr.api", "ecr.dkr", "logs", "secretsmanager", "sqs", "s3", "dynamodb"]) {
      expect(pilot).toContain(`"${service}"`);
    }
    expect(pilot).toContain('vpc_endpoint_type   = "Interface"');
    expect(pilot).toContain('vpc_endpoint_type = "Gateway"');
    expect(pilot).toContain("referenced_security_group_id = aws_security_group.worker.id");
    expect(pilot).not.toContain("aws_nat_gateway");
  });

  it("exposes only bounded webhook ingress through API Gateway and Lambda", () => {
    expect(pilot).toContain('route_key = "POST /github/webhooks"');
    expect(pilot).toContain('payload_format_version = "2.0"');
    expect(pilot).not.toContain("reserved_concurrent_executions");
    expect(pilot).toContain('entry_point = ["node_modules/.bin/aws-lambda-ric"]');
    expect(pilot).toContain('command     = ["dist/github/webhooks/v1/lambda-handler.handler"]');
    expect(pilot).toContain('WEBHOOK_SECRET_ARN');
    expect(pilot).toContain('CALLBACK_QUEUE_URL');
    expect(pilot).toContain('source_arn    = "${aws_apigatewayv2_api.operator.execution_arn}/*/POST/github/webhooks"');
  });

  it("requires IAM authorization on every operator route", () => {
    expect(pilot).toContain('resource "aws_lambda_function" "operator"');
    expect(pilot).toContain('authorization_type = "AWS_IAM"');
    for (const route of ["GET /v1/runs", "POST /v1/runs", "GET /v1/runs/{runId}", "GET /v1/runs/{runId}/events", "POST /v1/runs/{runId}/pause", "POST /v1/runs/{runId}/resume", "POST /v1/runs/{runId}/cancel", "POST /v1/runs/{runId}/reconcile", "POST /v1/runtime/wake", "POST /v1/runtime/drain"]) {
      expect(pilot).toContain(`"${route}"`);
    }
    expect(pilot).toContain("ALLOWED_OPERATOR_PRINCIPAL_ARN");
    expect(pilot).not.toMatch(/authorization_type\s*=\s*"NONE"/);
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
    expect(applyWorkflow).toContain('TF_VAR_worker_image_sha: ${{ inputs.commit_sha }}');
    expect(applyWorkflow).toContain("Require published immutable image");
    expect(applyWorkflow).toContain('--image-ids "imageTag=$SELECTED_SHA"');
    expect(applyWorkflow.indexOf("Require published immutable image")).toBeLessThan(applyWorkflow.indexOf("Plan selected commit"));
    expect(applyWorkflow).toContain("-out=pilot.tfplan");
    expect(applyWorkflow).toContain("apply -input=false -lock-timeout=5m pilot.tfplan");
    expect(applyWorkflow).toContain("-out=pilot-iam.tfplan");
    expect(applyWorkflow).toContain("apply -input=false -lock-timeout=5m pilot-iam.tfplan");
  });

  it("rejects deletes and every replacement except exact ECS task-definition revision promotion", () => {
    expect(applyWorkflow).toContain("Reject destructive pilot IAM plan");
    expect(applyWorkflow).toContain("Reject destructive pilot plan");
    expect(applyWorkflow.match(/show -json pilot(?:-iam|-iam-converged)?\.tfplan/g)).toHaveLength(3);
    expect(applyWorkflow.match(/index\("delete"\)/g)).toHaveLength(3);
    expect(applyWorkflow.indexOf("Reject destructive pilot IAM plan")).toBeGreaterThan(applyWorkflow.indexOf("Plan pilot IAM for selected commit"));
    expect(applyWorkflow.indexOf("Reject destructive pilot IAM plan")).toBeLessThan(applyWorkflow.indexOf("Apply selected pilot IAM plan"));
    expect(applyWorkflow.indexOf("Reject destructive pilot plan")).toBeGreaterThan(applyWorkflow.indexOf("Plan selected commit"));
    expect(applyWorkflow.indexOf("Reject destructive pilot plan")).toBeLessThan(applyWorkflow.indexOf("Apply selected plan"));
    expect(applyWorkflow.indexOf("Reject destructive converged pilot IAM plan")).toBeGreaterThan(applyWorkflow.indexOf("Plan converged pilot IAM"));
    expect(applyWorkflow.indexOf("Reject destructive converged pilot IAM plan")).toBeLessThan(applyWorkflow.indexOf("Apply converged pilot IAM plan"));
    expect(applyWorkflow).toContain("allowed_task_definition_replacement");
    expect(applyWorkflow).toContain('.change.actions == ["delete", "create"]');
    expect(applyWorkflow).toContain('.address == "aws_ecs_task_definition.worker"');
    expect(applyWorkflow).toContain('.address == "aws_ecs_task_definition.migration"');
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
    expect(pilotIam).toContain('"github-app-reviewer-private-key"');
    expect(pilotIam).toContain('"github-app-merger-private-key"');
  });

  it("keeps future runtime secret access scoped and unattached", () => {
    expect(pilotIam).toContain('["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]');
    expect(pilotIam).toContain("secret:ai-delivery-orchestrator/pilot/${name}-??????");
    expect(pilotIam).not.toMatch(/resources\s*=\s*\["\*"\][\s\S]{0,200}GetSecretValue/);
    expect(pilotIam).not.toMatch(/aws_iam_(role_)?policy_attachment/);
  });

  it("separates runtime and provider roles with exact secret boundaries", () => {
    for (const role of ["webhook", "operator_api", "worker_execution", "worker", "migration", "migration_execution"]) {
      expect(pilotIam).toContain(`resource "aws_iam_role" "${role}"`);
    }
    for (const secret of ["github-app-builder-private-key", "github-app-reviewer-private-key", "github-app-merger-private-key", "portal-openai-builder-api-key", "portal-openai-reviewer-api-key", "orchestrator-openai-reviewer-api-key"]) {
      expect(pilotIam).toContain(secret);
      expect(pilot).toContain(secret);
    }
    expect(pilotIam).toContain('variable = "secretsmanager:VersionStage"');
    expect(pilotIam).toMatch(/values\s*=\s*\["AWSCURRENT"\]/);
    const migrationSecretInjection = pilotIam.match(/data "aws_iam_policy_document" "migration_secret_injection" \{([\s\S]*?)\n\}/)?.[1];
    expect(migrationSecretInjection).toContain('resources = [var.database_secret_arn]');
    expect(migrationSecretInjection).not.toContain("secretsmanager:VersionStage");
    expect(pilotIam).not.toMatch(/iam:PassRole|iam:\*/);
    expect(pilot).not.toMatch(/resource\s+"aws_iam_/);
    expect(pilot).not.toMatch(/aws_secretsmanager_secret_version|secret_string|secret_binary/i);
  });

  it("grants bootstrap identities authority over only the exact pilot runtime roles", () => {
    const bootstrapVariables = read("infra/bootstrap/variables.tf");
    const runtimeRoleNames = [
      "ai-delivery-orchestrator-pilot-webhook",
      "ai-delivery-orchestrator-pilot-operator-api",
      "ai-delivery-orchestrator-pilot-worker-execution",
      "ai-delivery-orchestrator-pilot-worker",
      "ai-delivery-orchestrator-pilot-migration",
      "ai-delivery-orchestrator-pilot-migration-execution",
      "ai-delivery-orchestrator-pilot-github-builder",
      "ai-delivery-orchestrator-pilot-github-reviewer",
      "ai-delivery-orchestrator-pilot-github-merger",
      "ai-delivery-orchestrator-pilot-openai-portal-builder",
      "ai-delivery-orchestrator-pilot-openai-portal-reviewer",
      "ai-delivery-orchestrator-pilot-openai-orchestrator-reviewer",
    ];
    for (const roleName of runtimeRoleNames) expect(bootstrapVariables).toContain(`"${roleName}"`);
    expect(bootstrapVariables).not.toContain("ai-delivery-orchestrator-pilot-human-operator");
    expect(bootstrap).toContain('sid = "InspectPilotRuntimeRoles"');
    expect(bootstrap).toContain('sid = "ManagePilotRuntimeRoles"');
    expect(bootstrap).toContain('"iam:CreateRole"');
    expect(bootstrap).toContain('"iam:PutRolePolicy"');
    expect(bootstrap.match(/"iam:ListAttachedRolePolicies"/g)).toHaveLength(2);
    expect(bootstrap).toContain('sid       = "PassPilotRuntimeRoles"');
    expect(bootstrap).toContain('variable = "iam:PassedToService"');
    expect(bootstrap).toContain('["ecs-tasks.amazonaws.com", "lambda.amazonaws.com"]');
    expect(bootstrap).not.toMatch(/role\/ai-delivery-orchestrator-pilot-\*/);
  });

  it("separates complete pilot service planning from protected lifecycle authority", () => {
    const runtimeAuthority = read("infra/bootstrap/runtime-service-authority.tf");
    expect(runtimeAuthority).toContain('resource "aws_iam_role_policy" "github_plan_runtime_services"');
    expect(runtimeAuthority).toContain('name   = "pilot-runtime-services-read-only"');
    expect(runtimeAuthority).toContain('resource "aws_iam_policy" "github_apply_runtime_services"');
    expect(runtimeAuthority).toContain('name   = "ai-delivery-orchestrator-pilot-runtime-services-apply"');
    expect(runtimeAuthority).toContain('resource "aws_iam_role_policy_attachment" "github_apply_runtime_services"');
    expect(runtimeAuthority).toContain('resource "aws_iam_policy" "github_apply_runtime_network"');
    expect(runtimeAuthority).toContain('name   = "ai-delivery-orchestrator-pilot-runtime-network-apply"');
    expect(runtimeAuthority).toContain('resource "aws_iam_role_policy_attachment" "github_apply_runtime_network"');
    const servicePolicy = runtimeAuthority.slice(
      runtimeAuthority.indexOf('data "aws_iam_policy_document" "github_apply_runtime_services"'),
      runtimeAuthority.indexOf('data "aws_iam_policy_document" "github_apply_runtime_network"'),
    );
    const networkPolicy = runtimeAuthority.slice(
      runtimeAuthority.indexOf('data "aws_iam_policy_document" "github_apply_runtime_network"'),
      runtimeAuthority.indexOf('resource "aws_iam_policy" "github_apply_runtime_services"'),
    );
    expect(Buffer.byteLength(servicePolicy)).toBeLessThan(6144);
    expect(Buffer.byteLength(networkPolicy)).toBeLessThan(6144);
    expect(runtimeAuthority).toContain("role       = aws_iam_role.github_apply.name");
    expect(runtimeAuthority).not.toContain("role       = aws_iam_role.github_plan.name");
    for (const action of [
      "ecs:CreateCluster", "ecs:RegisterTaskDefinition", "ec2:CreateSecurityGroup", "ec2:CreateVpcEndpoint",
      "sqs:CreateQueue", "dynamodb:CreateTable", "rds:CreateDBCluster", "lambda:CreateFunction",
      "apigateway:POST", "application-autoscaling:RegisterScalableTarget", "cloudwatch:PutDashboard",
    ]) expect(runtimeAuthority).toContain(`"${action}"`);
    expect(runtimeAuthority).toMatch(/sid\s*= "RunPilotMigrationAndSmokeTasks"[\s\S]*?actions\s*= \["ecs:RunTask"\][\s\S]*?task-definition\/\$\{local\.pilot_name\}-worker:\*[\s\S]*?task-definition\/\$\{local\.pilot_name\}-migration:\*[\s\S]*?variable\s*= "ecs:cluster"[\s\S]*?values\s*= \["arn:aws:ecs:\$\{var\.aws_region\}:\$\{var\.aws_account_id\}:cluster\/\$\{local\.pilot_name\}-worker"\]/);
    expect(runtimeAuthority).toMatch(/sid\s*= "InspectPilotTasks"[\s\S]*?actions\s*= \["ecs:DescribeTasks"\][\s\S]*?resources = \["arn:aws:ecs:\$\{var\.aws_region\}:\$\{var\.aws_account_id\}:task\/\$\{local\.pilot_name\}-worker\/\*"\]/);
    const planPolicy = runtimeAuthority.slice(runtimeAuthority.indexOf('data "aws_iam_policy_document" "github_plan_runtime_services"'), runtimeAuthority.indexOf('resource "aws_iam_role_policy" "github_plan_runtime_services"'));
    expect(planPolicy).toContain('"rds:DescribeGlobalClusters"');
    expect(planPolicy).toContain('"kms:ListAliases"');
    expect(planPolicy).toMatch(/sid\s*= "DescribeAwsManagedRdsKey"[\s\S]*?actions\s*= \["kms:DescribeKey"\][\s\S]*?resources = \[data\.aws_kms_alias\.rds\.target_key_arn\]/);
    expect(planPolicy).not.toMatch(/:(?:Create|Delete|Put|Post|Patch|Update|Modify|Register|Deregister|Authorize|Revoke|Tag|Untag)/i);
    expect(runtimeAuthority).toContain('variable = "aws:RequestTag/Project"');
    expect(runtimeAuthority).toContain('variable = "aws:RequestTag/Environment"');
    expect(runtimeAuthority).toContain('variable = "aws:ResourceTag/Project"');
    expect(runtimeAuthority).toContain('variable = "application-autoscaling:service-namespace"');
    expect(runtimeAuthority).toContain('sid       = "InspectPilotAutoscalingTags"');
    expect(runtimeAuthority).toContain('"application-autoscaling:ListTagsForResource"');
    expect(runtimeAuthority).toContain('resources = ["arn:aws:application-autoscaling:${var.aws_region}:${var.aws_account_id}:scalable-target/*"]');
    expect(runtimeAuthority).toContain('resource "aws_iam_policy" "github_apply_autoscaling_tags"');
    expect(runtimeAuthority).toContain('name   = "ai-delivery-orchestrator-pilot-autoscaling-tags-apply"');
    expect(runtimeAuthority).toContain('resource "aws_iam_role_policy_attachment" "github_apply_autoscaling_tags"');
    expect(runtimeAuthority).toMatch(/values\s+= \["ecs"\]/);
    expect(runtimeAuthority).toContain('"arn:aws:apigateway:${var.aws_region}::/apis"');
    expect(runtimeAuthority).toContain('"arn:aws:apigateway:${var.aws_region}::/apis/*"');
    expect(runtimeAuthority).toContain('"arn:aws:apigateway:${var.aws_region}::/tags/*"');
    expect(runtimeAuthority).toMatch(/sid\s*= "UseTaggedPilotNetworkForCreate"/);
    expect(runtimeAuthority).toContain('"arn:aws:ec2:${var.aws_region}:${var.aws_account_id}:vpc/*"');
    expect(runtimeAuthority).toContain('"ecr:SetRepositoryPolicy"');
    expect(runtimeAuthority).toContain('"ecr:DescribeImages"');
    expect(runtimeAuthority).toContain('"ec2:RevokeSecurityGroupEgress"');
    expect(runtimeAuthority).toContain('"ec2:AuthorizeSecurityGroupEgress"');
    expect(runtimeAuthority).toContain('"arn:aws:ec2:${var.aws_region}:${var.aws_account_id}:security-group-rule/*"');
    expect(runtimeAuthority).toMatch(/sid\s*= "CreateTaggedPilotSecurityGroupRules"/);
    expect(pilot).toContain('resource "aws_vpc_security_group_egress_rule" "worker_database"');
    expect(pilot).toContain('referenced_security_group_id = aws_security_group.database.id');
    expect(pilot).toContain('from_port                    = 5432');
    expect(pilot).toContain('resource "aws_vpc_security_group_egress_rule" "worker_private_endpoints"');
    expect(pilot).toContain('referenced_security_group_id = aws_security_group.private_endpoints.id');
    expect(pilot).toContain('from_port                    = 443');
    expect(runtimeAuthority).toContain('"rds:CreateDBClusterSnapshot"');
    expect(runtimeAuthority).toContain('"rds:DeleteDBClusterSnapshot"');
    expect(runtimeAuthority).toContain('"rds:DescribeDBClusterSnapshots"');
    expect(runtimeAuthority).toContain('"arn:aws:rds:${var.aws_region}:${var.aws_account_id}:cluster:${local.pilot_name}"');
    expect(runtimeAuthority).toContain('"arn:aws:rds:${var.aws_region}:${var.aws_account_id}:cluster-snapshot:${local.pilot_name}-*"');
    expect(runtimeAuthority).toContain('"arn:aws:rds:${var.aws_region}:${var.aws_account_id}:db:${local.pilot_name}-writer"');
    expect(runtimeAuthority).toContain('sid       = "InspectRdsGlobalClusters"');
    expect(runtimeAuthority).toContain('actions   = ["rds:DescribeGlobalClusters"]');
    expect(runtimeAuthority).toContain('"arn:aws:rds::${var.aws_account_id}:global-cluster:*"');
    expect(runtimeAuthority).not.toContain('cluster:${local.pilot_name}-database');
    expect(runtimeAuthority).not.toContain('db:${local.pilot_name}-database-1');
    expect(runtimeAuthority).toContain('data "aws_kms_alias" "rds"');
    expect(runtimeAuthority).toContain('name = "alias/aws/rds"');
    expect(runtimeAuthority).toContain('data "aws_kms_alias" "secretsmanager"');
    expect(runtimeAuthority).toContain('name = "alias/aws/secretsmanager"');
    expect(runtimeAuthority).toMatch(/sid\s*= "ListAwsManagedRdsKeyAlias"[\s\S]*?actions\s*= \["kms:ListAliases"\][\s\S]*?resources = \["\*"\]/);
    expect(runtimeAuthority).toContain('sid       = "DescribeAwsManagedRdsKey"');
    expect(runtimeAuthority).toContain('actions   = ["kms:DescribeKey"]');
    expect(runtimeAuthority).toContain('sid       = "DescribeAwsManagedSecretsManagerKey"');
    expect(runtimeAuthority).toContain('resources = [data.aws_kms_alias.secretsmanager.target_key_arn]');
    expect(runtimeAuthority).toMatch(/sid\s*= "DescribeAwsManagedSecretsManagerKey"[\s\S]*?actions\s*= \["kms:DescribeKey"\][\s\S]*?resources = \[data\.aws_kms_alias\.secretsmanager\.target_key_arn\]/);
    expect(runtimeAuthority).toContain('sid       = "UseAwsManagedRdsKeyThroughRds"');
    expect(runtimeAuthority).toContain('actions   = ["kms:Decrypt", "kms:GenerateDataKey"]');
    expect(runtimeAuthority).toContain('variable = "kms:ViaService"');
    expect(runtimeAuthority).toContain('values   = ["rds.${var.aws_region}.amazonaws.com"]');
    expect(runtimeAuthority).toContain('sid       = "GrantAwsManagedRdsKeyToRds"');
    expect(runtimeAuthority).toContain('actions   = ["kms:CreateGrant"]');
    expect(runtimeAuthority).toContain('resources = [data.aws_kms_alias.rds.target_key_arn]');
    expect(runtimeAuthority).toContain('variable = "kms:GrantIsForAWSResource"');
    expect(runtimeAuthority).not.toContain('"kms:Encrypt"');
    expect(runtimeAuthority.match(/"kms:ListAliases"/g)).toHaveLength(2);
    expect(runtimeAuthority.match(/data\.aws_kms_alias\.secretsmanager\.target_key_arn/g)).toHaveLength(1);
    expect(runtimeAuthority).toContain('sid       = "CreateAndTagRdsManagedMasterSecret"');
    expect(runtimeAuthority).toContain('actions   = ["secretsmanager:CreateSecret", "secretsmanager:TagResource"]');
    expect(runtimeAuthority).toMatch(/sid\s*= "CreateAndTagRdsManagedMasterSecret"[\s\S]*?actions\s*= \["secretsmanager:CreateSecret", "secretsmanager:TagResource"\][\s\S]*?resources = \["\*"\][\s\S]*?variable = "aws:RequestedRegion"[\s\S]*?values\s*= \[var\.aws_region\]/);
    expect(runtimeAuthority).not.toMatch(/sid\s*= "CreateAndTagRdsManagedMasterSecret"[\s\S]*?variable = "aws:(?:ViaAWSService|CalledViaLast)"/);
    expect(runtimeAuthority.match(/"secretsmanager:CreateSecret"/g)).toHaveLength(1);
    expect(runtimeAuthority.match(/"secretsmanager:TagResource"/g)).toHaveLength(1);
    expect(runtimeAuthority).not.toMatch(/"secretsmanager:(?:GetSecretValue|PutSecretValue|UpdateSecret|DeleteSecret|RotateSecret|ReplicateSecretToRegions)"/);
    expect(runtimeAuthority.match(/variable = "kms:ViaService"/g)).toHaveLength(1);
    expect(runtimeAuthority).not.toMatch(/"kms:(?:CreateKey|DisableKey|ScheduleKeyDeletion|PutKeyPolicy|CreateAlias)"/);
    expect(runtimeAuthority).toContain('"lambda:PutFunctionConcurrency"');
    expect(runtimeAuthority).toContain('"lambda:DeleteFunctionConcurrency"');
    expect(runtimeAuthority).toContain('"lambda:ListVersionsByFunction"');
    expect(runtimeAuthority).toMatch(/sid\s*= "InspectTaskDefinitions"[\s\S]*?actions\s*= \["ecs:DescribeTaskDefinition"\][\s\S]*?resources = \["\*"\]/);
    expect(runtimeAuthority).toContain('"apigateway:TagResource"');
    expect(runtimeAuthority).toContain('"apigateway:UntagResource"');
    expect(runtimeAuthority).not.toContain("iam:PassRole");
  });

  it("allows only same-account pilot Lambda functions to pull the worker image", () => {
    const ecr = read("infra/environments/pilot/ecr.tf");
    expect(ecr).toContain('resource "aws_ecr_repository_policy" "worker_lambda_pull"');
    expect(ecr).toContain('identifiers = ["lambda.amazonaws.com"]');
    expect(ecr).toContain('variable = "aws:SourceAccount"');
    expect(ecr).toContain('values   = [var.aws_account_id]');
    expect(ecr).toContain('variable = "aws:SourceArn"');
    expect(ecr).toContain('function:${local.name}-*');
    expect(ecr).not.toMatch(/principals\s*\{[\s\S]{0,100}identifiers\s*=\s*\["\*"\]/);
  });

  it("attaches exact reviewed roles to inert compute", () => {
    expect(pilot).toContain("execution_role_arn       = var.worker_execution_role_arn");
    expect(pilot).toContain("task_role_arn            = var.worker_task_role_arn");
    expect(pilot).toContain("execution_role_arn       = var.migration_execution_role_arn");
    expect(pilot).toContain("task_role_arn            = var.migration_task_role_arn");
    expect(pilot).toContain("role          = var.webhook_lambda_role_arn");
    expect(pilot).toContain("role          = var.operator_lambda_role_arn");
    expect(pilot.match(/skip_destroy\s*=\s*true/g)).toHaveLength(2);
    expect(bootstrap).not.toContain("ecs:DeregisterTaskDefinition");
  });

  it("separates pilot IAM ownership behind an exact reference contract", () => {
    const pilotIamVariables = read("infra/environments/pilot-iam/variables.tf");
    expect(pilot).not.toMatch(/resource\s+"aws_iam_/);
    expect(pilotIam).toContain('resource "aws_iam_policy" "runtime_secrets"');
    expect(pilot).toContain('variable "runtime_secret_policy_arn"');
    expect(pilot).toContain('var.runtime_secret_policy_arn == "arn:aws:iam::${var.aws_account_id}:policy/ai-delivery-orchestrator-pilot-runtime-secrets"');
    expect(pilot).not.toMatch(/terraform_remote_state/);
    expect(pilotIam).not.toMatch(/terraform_remote_state/);
    expect(pilotIamVariables).toContain('secret:rds!cluster(:[A-Za-z0-9_-]+|-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}-[A-Za-z0-9]{6})$');
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
    expect(bootstrap.match(new RegExp(expectedArn, "g"))).toHaveLength(4);
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
    const publishPolicyStart = bootstrap.indexOf('data "aws_iam_policy_document" "github_publish"');
    const publishPolicy = bootstrap.slice(publishPolicyStart, bootstrap.indexOf('output "state_bucket_name"', publishPolicyStart));
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
    expect(bootstrap).not.toContain('"budgets:CreateBudget"');
    expect(bootstrap).not.toContain('"budgets:DeleteBudget"');
    expect(bootstrap).not.toContain('"budgets:DescribeBudget"');
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
