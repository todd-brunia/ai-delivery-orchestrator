variable "aws_account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be 12 digits."
  }
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
  validation {
    condition     = var.aws_region == "us-east-1"
    error_message = "The pilot IAM stack is pinned to us-east-1."
  }
}

variable "command_queue_arn" {
  type = string
  validation {
    condition     = var.command_queue_arn == "arn:aws:sqs:${var.aws_region}:${var.aws_account_id}:ai-delivery-orchestrator-pilot-commands.fifo"
    error_message = "command_queue_arn must identify the exact pilot command queue."
  }
}
variable "callback_queue_arn" {
  type = string
  validation {
    condition     = var.callback_queue_arn == "arn:aws:sqs:${var.aws_region}:${var.aws_account_id}:ai-delivery-orchestrator-pilot-callbacks.fifo"
    error_message = "callback_queue_arn must identify the exact pilot callback queue."
  }
}
variable "coordination_table_arn" {
  type = string
  validation {
    condition     = var.coordination_table_arn == "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/ai-delivery-orchestrator-pilot-coordination"
    error_message = "coordination_table_arn must identify the exact pilot coordination table."
  }
}
variable "database_secret_arn" {
  type      = string
  sensitive = true
  validation {
    condition     = can(regex("^arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:rds!cluster:[A-Za-z0-9_-]+$", var.database_secret_arn))
    error_message = "database_secret_arn must identify an RDS-managed cluster secret in the pilot account and region."
  }
}
variable "webhook_secret_arn" {
  type = string
  validation {
    condition     = can(regex("^arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:ai-delivery-orchestrator/pilot/github-webhook-secret-[A-Za-z0-9]+$", var.webhook_secret_arn))
    error_message = "webhook_secret_arn must identify the exact pilot webhook secret container."
  }
}
variable "worker_ecr_repository_arn" {
  type = string
  validation {
    condition     = var.worker_ecr_repository_arn == "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/ai-delivery-orchestrator-worker"
    error_message = "worker_ecr_repository_arn must identify the exact worker repository."
  }
}
variable "ingress_log_group_arn" {
  type = string
  validation {
    condition     = var.ingress_log_group_arn == "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/ai-delivery-orchestrator/pilot/ingress"
    error_message = "ingress_log_group_arn must identify the exact ingress log group."
  }
}
variable "operator_log_group_arn" {
  type = string
  validation {
    condition     = var.operator_log_group_arn == "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/ai-delivery-orchestrator/pilot/operator-api"
    error_message = "operator_log_group_arn must identify the exact operator log group."
  }
}
variable "worker_log_group_arn" {
  type = string
  validation {
    condition     = var.worker_log_group_arn == "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/ai-delivery-orchestrator/pilot/worker"
    error_message = "worker_log_group_arn must identify the exact worker log group."
  }
}

locals {
  name = "ai-delivery-orchestrator-pilot"
  application_secret_names = toset([
    "github-app-builder-private-key",
    "github-webhook-secret",
    "openai-api-key",
  ])
  tags = {
    Project     = "ai-delivery-orchestrator"
    Environment = "pilot"
    ManagedBy   = "terraform"
  }
}
