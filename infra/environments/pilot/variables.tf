variable "aws_account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be 12 digits."
  }
}
variable "runtime_secret_policy_arn" {
  type = string
  validation {
    condition     = var.runtime_secret_policy_arn == "arn:aws:iam::${var.aws_account_id}:policy/ai-delivery-orchestrator-pilot-runtime-secrets"
    error_message = "runtime_secret_policy_arn must identify the exact pilot runtime secrets policy in aws_account_id."
  }
}
variable "aws_region" {
  type    = string
  default = "us-east-1"
  validation {
    condition     = var.aws_region == "us-east-1"
    error_message = "The pilot is pinned to us-east-1."
  }
}
variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}
variable "availability_zones" {
  type    = list(string)
  default = ["us-east-1a", "us-east-1b"]
  validation {
    condition     = length(var.availability_zones) == 2 && length(distinct(var.availability_zones)) == 2
    error_message = "Exactly two distinct availability zones are required."
  }
}
variable "log_retention_days" {
  type    = number
  default = 30
  validation {
    condition     = contains([14, 30, 60, 90, 120, 150, 180, 365], var.log_retention_days)
    error_message = "log_retention_days must be an approved CloudWatch retention period from 14 through 365 days."
  }
}
variable "monthly_budget_usd" {
  type    = number
  default = 25
  validation {
    condition     = var.monthly_budget_usd >= 5 && var.monthly_budget_usd <= 500
    error_message = "monthly_budget_usd must be between 5 and 500."
  }
}
variable "budget_alert_percent" {
  type    = number
  default = 80
  validation {
    condition     = var.budget_alert_percent >= 50 && var.budget_alert_percent <= 100
    error_message = "budget_alert_percent must be between 50 and 100."
  }
}
variable "budget_notification_email" {
  type      = string
  sensitive = true
  validation {
    condition     = can(regex("^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$", var.budget_notification_email))
    error_message = "budget_notification_email must be a valid email address supplied outside source control."
  }
}
variable "alarm_action_arns" {
  type    = list(string)
  default = []
  validation {
    condition     = length(var.alarm_action_arns) <= 5 && alltrue([for arn in var.alarm_action_arns : can(regex("^arn:aws:sns:us-east-1:[0-9]{12}:[A-Za-z0-9_-]+$", arn))])
    error_message = "alarm_action_arns must contain at most five us-east-1 SNS topic ARNs."
  }
}

variable "aurora_engine_version" {
  type    = string
  default = "16.6"
  validation {
    condition     = can(regex("^16\\.[0-9]+$", var.aurora_engine_version))
    error_message = "aurora_engine_version must be an explicitly reviewed Aurora PostgreSQL 16 minor version."
  }
}

variable "aurora_min_capacity" {
  type    = number
  default = 0
  validation {
    condition     = var.aurora_min_capacity >= 0 && var.aurora_min_capacity <= 2
    error_message = "aurora_min_capacity must be between 0 and 2 ACUs."
  }
}

variable "aurora_max_capacity" {
  type    = number
  default = 2
  validation {
    condition     = var.aurora_max_capacity >= 1 && var.aurora_max_capacity <= 4 && var.aurora_max_capacity >= var.aurora_min_capacity
    error_message = "aurora_max_capacity must be between 1 and 4 ACUs and not less than the minimum."
  }
}

variable "database_backup_retention_days" {
  type    = number
  default = 7
  validation {
    condition     = var.database_backup_retention_days >= 7 && var.database_backup_retention_days <= 35
    error_message = "database_backup_retention_days must be between 7 and 35."
  }
}

variable "database_client_security_group_ids" {
  description = "Reviewed worker and migration security groups allowed to connect; empty keeps Aurora isolated."
  type        = map(string)
  default     = {}
  validation {
    condition     = alltrue([for id in values(var.database_client_security_group_ids) : can(regex("^sg-[0-9a-f]{8,17}$", id))])
    error_message = "Every database client must be an explicit security-group ID."
  }
}
locals {
  name = "ai-delivery-orchestrator-pilot"
  tags = {
    Project     = "ai-delivery-orchestrator"
    Environment = "pilot"
    ManagedBy   = "terraform"
  }
}
