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
}

locals {
  tags = {
    Project     = "ai-delivery-orchestrator"
    Environment = "bootstrap"
    ManagedBy   = "terraform"
  }
}
