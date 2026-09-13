variable "callback_image_digest" {
  description = "Reviewed candidate digest. Null leaves lifecycle resources unprovisioned."
  type        = string
  default     = null
  nullable    = true
  validation {
    condition     = var.callback_image_digest == null || can(regex("^sha256:[0-9a-f]{64}$", var.callback_image_digest))
    error_message = "Use an immutable SHA-256 image digest."
  }
}
variable "callback_lifecycle_enabled" {
  description = "Enable only after migrations, exact fixture approval, IAM pinning and durable lifecycle initialization."
  type        = bool
  default     = false
}
variable "callback_controller_image_digest" {
  description = "Optional separately reviewed controller image; preserves pinned ECS revisions during Lambda-only fixes."
  type        = string
  default     = null
  nullable    = true
  validation {
    condition     = var.callback_controller_image_digest == null || can(regex("^sha256:[0-9a-f]{64}$", var.callback_controller_image_digest))
    error_message = "Use an immutable SHA-256 controller image digest."
  }
}
variable "callback_delivery_ids" {
  description = "Exact owner-approved pilot webhook delivery IDs; no repository-wide automatic claims."
  type        = list(string)
  default     = []
  validation {
    condition     = length(var.callback_delivery_ids) <= 100 && alltrue([for id in var.callback_delivery_ids : can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", id))])
    error_message = "Provide at most 100 exact UUID delivery IDs."
  }
}
variable "callback_hook_id" {
  type    = number
  default = 1
  validation {
    condition     = var.callback_hook_id >= 1 && floor(var.callback_hook_id) == var.callback_hook_id
    error_message = "Use the canonical positive integer GitHub App hook ID."
  }
}
locals {
  callback_provisioned = var.callback_image_digest != null
  callback_modes       = local.callback_provisioned ? toset(["ingress", "processor"]) : toset([])
  callback_repository  = "todd-brunia/ai-consulting-client-portal"
  callback_adapter = {
    version             = 1, repository = local.callback_repository, defaultBranch = "main", enabled = true,
    orchestratorAppSlug = "ai-delivery-orchestrator",
    workflows           = { implementation = "implementation.yml", repair = "repair.yml", sync = "sync.yml" },
    labels              = { needsPlanning = "needs-planning", planReady = "plan-ready", approvedForBuild = "approved-for-build", approvedForAiBuild = "approved-for-ai-build", inProgress = "in-progress", previewReady = "preview-ready", needsDecision = "needs-decision", blocked = "blocked" },
    requiredChecks      = ["CI Gate"], maxParallelImplementations = 1,
    risk                = { humanApprovalCategories = ["security", "authentication", "secrets", "infrastructure", "destructive_data", "billing", "workflow_policy", "external_communication"], humanApprovalLabels = ["approved-for-build"], humanApprovalPathPatterns = [".github/**"] }
  }
  callback_launch_configuration = local.callback_provisioned ? {
    version    = "callback-launch/v1", cluster = aws_ecs_cluster.worker.arn,
    repository = local.callback_repository, runtimeConfigurationVersion = "runtime-v1",
    ingress = {
      taskDefinition = aws_ecs_task_definition.callback["ingress"].arn,
      subnets        = sort(values(aws_subnet.isolated)[*].id),
      securityGroup  = aws_security_group.worker.id
    },
    processor = {
      taskDefinition = aws_ecs_task_definition.callback["processor"].arn,
      subnets        = sort(values(aws_subnet.public)[*].id),
      securityGroup  = aws_security_group.supervised_dispatch.id
    }
  } : null
}
resource "aws_ecs_task_definition" "callback" {
  for_each                 = local.callback_modes
  family                   = "${local.name}-callback-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = "arn:aws:iam::${var.aws_account_id}:role/${local.name}-callback-execution"
  task_role_arn            = each.key == "ingress" ? var.worker_task_role_arn : "arn:aws:iam::${var.aws_account_id}:role/${local.name}-callback-processor"
  skip_destroy             = true
  container_definitions = jsonencode([{
    name      = "worker", image = "${aws_ecr_repository.worker.repository_url}@${var.callback_image_digest}",
    essential = true, readonlyRootFilesystem = true, stopTimeout = 30,
    environment = concat([
      { name = "NODE_ENV", value = "production" }, { name = "PROVIDER_MODE", value = "stub" },
      { name = "CALLBACK_PROCESSING_ENABLED", value = "true" },
      { name = "CALLBACK_RUNTIME_MODE", value = each.key },
      { name = "CALLBACK_RUN_ONCE", value = "false" },
      { name = "CALLBACK_LIFECYCLE_REQUIRED", value = "true" },
      { name = "CALLBACK_EVENT_FAMILIES", value = "issues,issue_comment,workflow_run,pull_request,check_run,check_suite,pull_request_review" },
      { name = "CALLBACK_QUEUE_URL", value = aws_sqs_queue.runtime["callbacks"].url },
      { name = "COORDINATION_TABLE_NAME", value = aws_dynamodb_table.runtime_coordination.name },
      { name = "RUNTIME_CONFIGURATION_VERSION", value = "runtime-v1" },
      { name = "GITHUB_HOOK_ID", value = tostring(var.callback_hook_id) },
      { name = "GITHUB_REPOSITORY_ID", value = var.supervised_repository_id },
      { name = "GITHUB_APP_ID", value = var.supervised_github_app_id },
      { name = "GITHUB_INSTALLATION_ID", value = var.supervised_github_installation_id },
      { name = "GITHUB_INSTALLATION_ACCOUNT", value = var.supervised_github_installation_account },
      { name = "REPOSITORY_ADAPTER_JSON", value = jsonencode(local.callback_adapter) },
      { name = "PGHOST", value = aws_rds_cluster.application.endpoint },
      { name = "PGPORT", value = "5432" }, { name = "PGDATABASE", value = "orchestrator" }
    ], [{ name = "CALLBACK_DELIVERY_IDS", value = join(",", length(var.callback_delivery_ids) > 0 ? var.callback_delivery_ids : ["00000000-0000-0000-0000-000000000000"]) }]),
    secrets = [
      { name = "PGUSER", valueFrom = "${aws_rds_cluster.application.master_user_secret[0].secret_arn}:username::" },
      { name = "PGPASSWORD", valueFrom = "${aws_rds_cluster.application.master_user_secret[0].secret_arn}:password::" }
    ],
    logConfiguration = { logDriver = "awslogs", options = {
      awslogs-group  = aws_cloudwatch_log_group.application["worker"].name,
      awslogs-region = var.aws_region, awslogs-stream-prefix = "callback-${each.key}"
    } }
  }])
  tags = local.tags
}
resource "aws_cloudwatch_log_group" "callback_controller" {
  count             = local.callback_provisioned ? 1 : 0
  name              = "/ai-delivery-orchestrator/pilot/callback-controller"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}
resource "aws_lambda_function" "callback_controller" {
  count         = local.callback_provisioned ? 1 : 0
  function_name = "${local.name}-callback-controller"
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.worker.repository_url}@${coalesce(var.callback_controller_image_digest, var.callback_image_digest)}"
  role          = "arn:aws:iam::${var.aws_account_id}:role/${local.name}-callback-controller"
  timeout       = 50
  memory_size   = 256
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.callback_controller[0].name
  }
  image_config {
    entry_point = ["node_modules/.bin/aws-lambda-ric"]
    command     = ["/app/dist/runtime/v1/callback-lifecycle-handler.handler"]
  }
  environment {
    variables = {
      CALLBACK_LIFECYCLE_ENABLED         = tostring(var.callback_lifecycle_enabled)
      CALLBACK_LAUNCH_CONFIGURATION_JSON = jsonencode(local.callback_launch_configuration)
      COORDINATION_TABLE_NAME            = aws_dynamodb_table.runtime_coordination.name
      CALLBACK_QUEUE_URL                 = aws_sqs_queue.runtime["callbacks"].url
    }
  }
  lifecycle {
    precondition {
      condition     = !var.callback_lifecycle_enabled || (length(var.callback_delivery_ids) > 0 && var.callback_hook_id > 1)
      error_message = "Pilot enablement requires explicit delivery scope and canonical hook identity."
    }
  }
  depends_on = [aws_cloudwatch_log_group.callback_controller]
  tags       = local.tags
}
resource "aws_cloudwatch_event_rule" "callback_controller" {
  count               = local.callback_provisioned ? 1 : 0
  name                = "${local.name}-callback-controller"
  schedule_expression = "rate(1 minute)"
  state               = var.callback_lifecycle_enabled ? "ENABLED" : "DISABLED"
  tags                = local.tags
}
resource "aws_cloudwatch_event_target" "callback_controller" {
  count     = local.callback_provisioned ? 1 : 0
  rule      = aws_cloudwatch_event_rule.callback_controller[0].name
  target_id = "callback-controller"
  arn       = aws_lambda_function.callback_controller[0].arn
  retry_policy {
    maximum_event_age_in_seconds = 60
    maximum_retry_attempts       = 0
  }
}
resource "aws_lambda_permission" "callback_controller" {
  count          = local.callback_provisioned ? 1 : 0
  statement_id   = "AllowExactCallbackSchedule"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.callback_controller[0].function_name
  principal      = "events.amazonaws.com"
  source_arn     = aws_cloudwatch_event_rule.callback_controller[0].arn
  source_account = var.aws_account_id
}
output "callback_task_definition_arns" {
  value = { for mode, task in aws_ecs_task_definition.callback : mode => task.arn }
}
output "callback_launch_configuration" {
  value = local.callback_launch_configuration
}
