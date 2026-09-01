data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}
data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "webhook" {
  name               = "${local.name}-webhook"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
  tags               = local.tags
}
resource "aws_iam_role" "operator_api" {
  name               = "${local.name}-operator-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
  tags               = local.tags
}
resource "aws_iam_role" "worker_execution" {
  name               = "${local.name}-worker-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = local.tags
}
resource "aws_iam_role" "worker" {
  name               = "${local.name}-worker"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = local.tags
}
resource "aws_iam_role" "supervised_dispatch" {
  name               = "${local.name}-supervised-dispatch"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = local.tags
}
resource "aws_iam_role" "supervised_dispatch_execution" {
  name               = "${local.name}-supervised-dispatch-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = local.tags
}
resource "aws_iam_role" "migration" {
  name               = "${local.name}-migration"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = local.tags
}
resource "aws_iam_role" "migration_execution" {
  name               = "${local.name}-migration-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = local.tags
}

locals {
  separated_provider_secrets = {
    github-builder               = "github-app-builder-private-key"
    github-reviewer              = "github-app-reviewer-private-key"
    github-merger                = "github-app-merger-private-key"
    openai-portal-builder        = "portal-openai-builder-api-key"
    openai-portal-reviewer       = "portal-openai-reviewer-api-key"
    openai-orchestrator-reviewer = "orchestrator-openai-reviewer-api-key"
  }
}
resource "aws_iam_role" "provider" {
  for_each           = local.separated_provider_secrets
  name               = "${local.name}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = local.tags
}
data "aws_iam_policy_document" "provider_secret" {
  for_each = local.separated_provider_secrets
  statement {
    actions   = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
    resources = ["arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:ai-delivery-orchestrator/pilot/${each.value}-??????"]
    condition {
      test     = "StringEquals"
      variable = "secretsmanager:VersionStage"
      values   = ["AWSCURRENT"]
    }
  }
}
resource "aws_iam_role_policy" "provider_secret" {
  for_each = local.separated_provider_secrets
  name     = "read-${each.value}"
  role     = aws_iam_role.provider[each.key].id
  policy   = data.aws_iam_policy_document.provider_secret[each.key].json
}

data "aws_iam_policy_document" "webhook" {
  statement {
    actions   = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
    resources = [var.webhook_secret_arn]
    condition {
      test     = "StringEquals"
      variable = "secretsmanager:VersionStage"
      values   = ["AWSCURRENT"]
    }
  }
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [var.callback_queue_arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${var.ingress_log_group_arn}:log-stream:*"]
  }
}
resource "aws_iam_role_policy" "webhook" {
  name   = "webhook-runtime"
  role   = aws_iam_role.webhook.id
  policy = data.aws_iam_policy_document.webhook.json
}

data "aws_iam_policy_document" "operator_api" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [var.command_queue_arn]
  }
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"]
    resources = [var.coordination_table_arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${var.operator_log_group_arn}:log-stream:*"]
  }
}
resource "aws_iam_role_policy" "operator_api" {
  name   = "operator-runtime"
  role   = aws_iam_role.operator_api.id
  policy = data.aws_iam_policy_document.operator_api.json
}

data "aws_iam_policy_document" "worker" {
  statement {
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"]
    resources = [var.command_queue_arn, var.callback_queue_arn]
  }
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]
    resources = [var.coordination_table_arn]
  }
  statement {
    actions   = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
    resources = [var.database_secret_arn]
    condition {
      test     = "StringEquals"
      variable = "secretsmanager:VersionStage"
      values   = ["AWSCURRENT"]
    }
  }
}
resource "aws_iam_role_policy" "worker" {
  name   = "worker-runtime"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker.json
}
data "aws_iam_policy_document" "supervised_dispatch" {
  statement {
    actions = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
    resources = [
      "arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:ai-delivery-orchestrator/pilot/github-app-builder-private-key-??????",
      "arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:ai-delivery-orchestrator/pilot/portal-openai-builder-api-key-??????",
    ]
    condition {
      test     = "StringEquals"
      variable = "secretsmanager:VersionStage"
      values   = ["AWSCURRENT"]
    }
  }
}
resource "aws_iam_role_policy" "supervised_dispatch" {
  name   = "supervised-dispatch-provider-secrets"
  role   = aws_iam_role.supervised_dispatch.id
  policy = data.aws_iam_policy_document.supervised_dispatch.json
}
data "aws_iam_policy_document" "worker_execution" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
    resources = [var.worker_ecr_repository_arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${var.worker_log_group_arn}:log-stream:*"]
  }
}
resource "aws_iam_role_policy" "worker_execution" {
  name   = "worker-execution"
  role   = aws_iam_role.worker_execution.id
  policy = data.aws_iam_policy_document.worker_execution.json
}
resource "aws_iam_role_policy" "supervised_dispatch_execution" {
  name   = "supervised-dispatch-execution"
  role   = aws_iam_role.supervised_dispatch_execution.id
  policy = data.aws_iam_policy_document.worker_execution.json
}
resource "aws_iam_role_policy" "supervised_dispatch_database_injection" {
  name   = "supervised-dispatch-database-injection"
  role   = aws_iam_role.supervised_dispatch_execution.id
  policy = data.aws_iam_policy_document.migration_secret_injection.json
}
resource "aws_iam_role_policy" "migration_execution" {
  name   = "migration-execution"
  role   = aws_iam_role.migration_execution.id
  policy = data.aws_iam_policy_document.worker_execution.json
}
data "aws_iam_policy_document" "migration_secret_injection" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.database_secret_arn]
  }
}
resource "aws_iam_role_policy" "migration_secret_injection" {
  name   = "migration-secret-injection"
  role   = aws_iam_role.migration_execution.id
  policy = data.aws_iam_policy_document.migration_secret_injection.json
}
