locals {
  application_secret_names = toset([
    "github-app-private-key",
    "github-app-builder-private-key",
    "github-app-reviewer-private-key",
    "github-app-merger-private-key",
    "github-webhook-secret",
    "openai-api-key",
    "portal-openai-builder-api-key",
    "portal-openai-reviewer-api-key",
    "orchestrator-openai-reviewer-api-key",
  ])
  log_group_names = toset([
    "ingress",
    "operator-api",
    "worker",
  ])
}

resource "aws_secretsmanager_secret" "application" {
  for_each                = local.application_secret_names
  name                    = "ai-delivery-orchestrator/pilot/${each.value}"
  description             = "Value is entered and rotated outside Terraform for the pilot ${each.value}."
  recovery_window_in_days = 30
}

resource "aws_cloudwatch_log_group" "application" {
  for_each          = local.log_group_names
  name              = "/ai-delivery-orchestrator/pilot/${each.value}"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_metric_alarm" "estimated_charges" {
  alarm_name          = "ai-delivery-orchestrator-pilot-estimated-charges"
  alarm_description   = "Informational account estimated-charge signal; the scoped AWS Budget is authoritative for pilot notifications."
  namespace           = "AWS/Billing"
  metric_name         = "EstimatedCharges"
  statistic           = "Maximum"
  period              = 21600
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = var.monthly_budget_usd
  treat_missing_data  = "missing"
  alarm_actions       = var.alarm_action_arns
  dimensions = {
    Currency = "USD"
  }
}

resource "aws_budgets_budget" "monthly" {
  name         = "ai-delivery-orchestrator-pilot-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = ["user:Project$ai-delivery-orchestrator"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = var.budget_alert_percent
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_notification_email]
  }
}
