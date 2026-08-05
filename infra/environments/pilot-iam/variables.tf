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

locals {
  name = "ai-delivery-orchestrator-pilot"
  application_secret_names = toset([
    "github-app-private-key",
    "github-webhook-secret",
    "openai-api-key",
  ])
  tags = {
    Project     = "ai-delivery-orchestrator"
    Environment = "pilot"
    ManagedBy   = "terraform"
  }
}
