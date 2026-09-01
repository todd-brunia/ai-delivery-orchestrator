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
}
variable "state_bucket_name" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.state_bucket_name))
    error_message = "state_bucket_name must be a valid S3 bucket name."
  }
}
variable "github_repository" {
  type    = string
  default = "todd-brunia/ai-delivery-orchestrator"
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must be an OWNER/REPOSITORY pair."
  }
}
variable "github_repository_owner_id" {
  type = string
  validation {
    condition     = can(regex("^[1-9][0-9]{0,19}$", var.github_repository_owner_id))
    error_message = "github_repository_owner_id must be a positive numeric GitHub owner ID."
  }
}
variable "github_repository_id" {
  type = string
  validation {
    condition     = can(regex("^[1-9][0-9]{0,19}$", var.github_repository_id))
    error_message = "github_repository_id must be a positive numeric GitHub repository ID."
  }
}
variable "pilot_environment_name" {
  type    = string
  default = "pilot"
  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,64}$", var.pilot_environment_name))
    error_message = "pilot_environment_name must contain only letters, digits, underscores, or hyphens."
  }
}

locals {
  github_repository_parts     = split("/", var.github_repository)
  github_immutable_repository = "${local.github_repository_parts[0]}@${var.github_repository_owner_id}/${local.github_repository_parts[1]}@${var.github_repository_id}"
  pilot_runtime_role_names = toset([
    "ai-delivery-orchestrator-pilot-webhook",
    "ai-delivery-orchestrator-pilot-operator-api",
    "ai-delivery-orchestrator-pilot-worker-execution",
    "ai-delivery-orchestrator-pilot-worker",
    "ai-delivery-orchestrator-pilot-migration",
    "ai-delivery-orchestrator-pilot-migration-execution",
    "ai-delivery-orchestrator-pilot-supervised-dispatch",
    "ai-delivery-orchestrator-pilot-supervised-dispatch-execution",
    "ai-delivery-orchestrator-pilot-github-builder",
    "ai-delivery-orchestrator-pilot-github-reviewer",
    "ai-delivery-orchestrator-pilot-github-merger",
    "ai-delivery-orchestrator-pilot-openai-portal-builder",
    "ai-delivery-orchestrator-pilot-openai-portal-reviewer",
    "ai-delivery-orchestrator-pilot-openai-orchestrator-reviewer",
  ])
  pilot_runtime_role_arns = [for name in local.pilot_runtime_role_names : "arn:aws:iam::${var.aws_account_id}:role/${name}"]
  tags = {
    Project     = "ai-delivery-orchestrator"
    Environment = "bootstrap"
    ManagedBy   = "terraform"
  }
}
