# Owner-approved #73 inventory. Provision roles first, then the disabled task
# definitions in pilot, then supply their exact revision ARNs to grant RunTask.
variable "callback_lifecycle_provisioned" {
  type    = bool
  default = false
}
variable "callback_task_definition_arns" {
  type    = map(string)
  default = {}
  validation {
    condition = length(var.callback_task_definition_arns) == 0 || (
      toset(keys(var.callback_task_definition_arns)) == toset(["ingress", "processor"]) &&
      alltrue([for mode, arn in var.callback_task_definition_arns : can(regex("^arn:aws:ecs:us-east-1:${var.aws_account_id}:task-definition/ai-delivery-orchestrator-pilot-callback-${mode}:[1-9][0-9]*$", arn))])
    )
    error_message = "Provide both exact callback task-definition revision ARNs, or none during role bootstrap."
  }
}
locals {
  callback_roles = var.callback_lifecycle_provisioned ? toset(["controller", "processor", "execution"]) : toset([])
}
resource "aws_iam_role" "callback" {
  for_each           = local.callback_roles
  name               = "${local.name}-callback-${each.key}"
  assume_role_policy = each.key == "controller" ? data.aws_iam_policy_document.lambda_trust.json : data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = local.tags
}
data "aws_secretsmanager_secret" "callback_builder" {
  count = var.callback_lifecycle_provisioned ? 1 : 0
  name  = "ai-delivery-orchestrator/pilot/github-app-builder-private-key"
}
data "aws_iam_policy_document" "callback_coordination" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [var.coordination_table_arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["callback-lifecycle/v1"]
    }
  }
}
data "aws_iam_policy_document" "callback_processor" {
  count                   = var.callback_lifecycle_provisioned ? 1 : 0
  source_policy_documents = [data.aws_iam_policy_document.callback_coordination.json]
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [data.aws_secretsmanager_secret.callback_builder[0].arn]
    condition {
      test     = "StringEquals"
      variable = "secretsmanager:VersionStage"
      values   = ["AWSCURRENT"]
    }
  }
}
resource "aws_iam_role_policy" "callback_processor" {
  count  = var.callback_lifecycle_provisioned ? 1 : 0
  name   = "callback-read-and-coordination"
  role   = aws_iam_role.callback["processor"].id
  policy = data.aws_iam_policy_document.callback_processor[0].json
}
resource "aws_iam_role_policy" "callback_execution" {
  count  = var.callback_lifecycle_provisioned ? 1 : 0
  name   = "callback-image-and-logs"
  role   = aws_iam_role.callback["execution"].id
  policy = data.aws_iam_policy_document.worker_execution.json
}
resource "aws_iam_role_policy" "callback_database_injection" {
  count  = var.callback_lifecycle_provisioned ? 1 : 0
  name   = "callback-database-injection"
  role   = aws_iam_role.callback["execution"].id
  policy = data.aws_iam_policy_document.migration_secret_injection.json
}
data "aws_iam_policy_document" "callback_controller" {
  source_policy_documents = [data.aws_iam_policy_document.callback_coordination.json]
  statement {
    actions   = ["sqs:GetQueueAttributes"]
    resources = [var.callback_queue_arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:us-east-1:${var.aws_account_id}:log-group:/ai-delivery-orchestrator/pilot/callback-controller:log-stream:*"]
  }
  statement {
    actions   = ["ecs:DescribeTasks"]
    resources = ["arn:aws:ecs:us-east-1:${var.aws_account_id}:task/${local.name}-worker/*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = ["arn:aws:ecs:us-east-1:${var.aws_account_id}:cluster/${local.name}-worker"]
    }
  }
}
resource "aws_iam_role_policy" "callback_controller" {
  count  = var.callback_lifecycle_provisioned ? 1 : 0
  name   = "callback-lifecycle-observation"
  role   = aws_iam_role.callback["controller"].id
  policy = data.aws_iam_policy_document.callback_controller.json
}
data "aws_iam_policy_document" "callback_launch" {
  count = var.callback_lifecycle_provisioned && length(var.callback_task_definition_arns) == 2 ? 1 : 0
  statement {
    actions   = ["ecs:RunTask"]
    resources = values(var.callback_task_definition_arns)
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = ["arn:aws:ecs:us-east-1:${var.aws_account_id}:cluster/${local.name}-worker"]
    }
  }
  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.worker.arn, aws_iam_role.callback["processor"].arn, aws_iam_role.callback["execution"].arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}
resource "aws_iam_role_policy" "callback_launch" {
  count  = var.callback_lifecycle_provisioned && length(var.callback_task_definition_arns) == 2 ? 1 : 0
  name   = "callback-pinned-task-launch"
  role   = aws_iam_role.callback["controller"].id
  policy = data.aws_iam_policy_document.callback_launch[0].json
}
output "callback_role_arns" {
  value = { for name, role in aws_iam_role.callback : name => role.arn }
}
