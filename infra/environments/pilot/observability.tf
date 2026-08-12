locals {
  lambda_functions = {
    webhook  = aws_lambda_function.webhook.function_name
    operator = aws_lambda_function.operator.function_name
  }
  queue_alarm_targets = merge(
    { for name, queue in aws_sqs_queue.runtime : name => queue.name },
    { for name, queue in aws_sqs_queue.dead_letter : "${name}-dlq" => queue.name },
  )
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each            = local.lambda_functions
  alarm_name          = "${local.name}-${each.key}-lambda-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  dimensions          = { FunctionName = each.value }
  tags                = local.tags
}
resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  for_each            = local.lambda_functions
  alarm_name          = "${local.name}-${each.key}-lambda-throttles"
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  dimensions          = { FunctionName = each.value }
  tags                = local.tags
}
resource "aws_cloudwatch_metric_alarm" "lambda_duration" {
  for_each            = local.lambda_functions
  alarm_name          = "${local.name}-${each.key}-lambda-duration"
  namespace           = "AWS/Lambda"
  metric_name         = "Duration"
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 2
  threshold           = 8000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  dimensions          = { FunctionName = each.value }
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${local.name}-api-5xx"
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  dimensions          = { ApiId = aws_apigatewayv2_api.operator.id }
  tags                = local.tags
}
resource "aws_cloudwatch_metric_alarm" "api_latency" {
  alarm_name          = "${local.name}-api-latency"
  namespace           = "AWS/ApiGateway"
  metric_name         = "Latency"
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 2
  threshold           = 8000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  dimensions          = { ApiId = aws_apigatewayv2_api.operator.id }
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "queue_age" {
  for_each            = local.queue_alarm_targets
  alarm_name          = "${local.name}-${each.key}-queue-age"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 900
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  dimensions          = { QueueName = each.value }
  tags                = local.tags
}
resource "aws_cloudwatch_metric_alarm" "dlq_messages" {
  for_each            = aws_sqs_queue.dead_letter
  alarm_name          = "${local.name}-${each.key}-dlq-messages"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  dimensions          = { QueueName = each.value.name }
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "dynamodb_throttles" {
  alarm_name          = "${local.name}-dynamodb-throttles"
  namespace           = "AWS/DynamoDB"
  metric_name         = "ThrottledRequests"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  dimensions          = { TableName = aws_dynamodb_table.runtime_coordination.name }
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "worker_capacity" {
  alarm_name          = "${local.name}-worker-capacity"
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  dimensions = {
    ClusterName = aws_ecs_cluster.worker.name
    ServiceName = aws_ecs_service.worker.name
  }
  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "aurora_connections" {
  alarm_name          = "${local.name}-aurora-connections"
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 100
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  dimensions          = { DBClusterIdentifier = aws_rds_cluster.application.cluster_identifier }
  tags                = local.tags
}
resource "aws_cloudwatch_metric_alarm" "aurora_capacity" {
  alarm_name          = "${local.name}-aurora-capacity"
  namespace           = "AWS/RDS"
  metric_name         = "ACUUtilization"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 90
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  dimensions          = { DBClusterIdentifier = aws_rds_cluster.application.cluster_identifier }
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "runtime_custom" {
  for_each = {
    AuroraWakeSeconds         = 120
    WorkerWakeToReadySeconds  = 180
    WorkerHeartbeatAgeSeconds = 300
    ProjectionLagSeconds      = 300
    MigrationFailures         = 1
    BackupAgeHours            = 30
    TelemetryGap              = 1
  }
  alarm_name          = "${local.name}-${lower(each.key)}"
  namespace           = "AiDeliveryOrchestrator/Pilot"
  metric_name         = each.key
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = each.value
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  dimensions          = { Environment = "pilot" }
  tags                = local.tags
}

resource "aws_cloudwatch_dashboard" "pilot" {
  dashboard_name = local.name
  dashboard_body = jsonencode({
    widgets = [
      { type = "metric", x = 0, y = 0, width = 12, height = 6, properties = { title = "Ingress and operator", region = var.aws_region, metrics = [["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.webhook.function_name], [".", ".", ".", aws_lambda_function.operator.function_name], ["AWS/ApiGateway", "5xx", "ApiId", aws_apigatewayv2_api.operator.id]] } },
      { type = "metric", x = 12, y = 0, width = 12, height = 6, properties = { title = "Queues and DLQs", region = var.aws_region, metrics = [["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", aws_sqs_queue.runtime["commands"].name], [".", ".", ".", aws_sqs_queue.runtime["callbacks"].name], ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.dead_letter["commands"].name], [".", ".", ".", aws_sqs_queue.dead_letter["callbacks"].name]] } },
      { type = "metric", x = 0, y = 6, width = 12, height = 6, properties = { title = "Worker and projection", region = var.aws_region, metrics = [["ECS/ContainerInsights", "RunningTaskCount", "ClusterName", aws_ecs_cluster.worker.name, "ServiceName", aws_ecs_service.worker.name], ["AiDeliveryOrchestrator/Pilot", "WorkerWakeToReadySeconds", "Environment", "pilot"], [".", "WorkerHeartbeatAgeSeconds", ".", "."], [".", "ProjectionLagSeconds", ".", "."], [".", "TelemetryGap", ".", "."]] } },
      { type = "metric", x = 12, y = 6, width = 12, height = 6, properties = { title = "Aurora and recovery", region = var.aws_region, metrics = [["AWS/RDS", "ACUUtilization", "DBClusterIdentifier", aws_rds_cluster.application.cluster_identifier], [".", "DatabaseConnections", ".", "."], ["AiDeliveryOrchestrator/Pilot", "AuroraWakeSeconds", "Environment", "pilot"], [".", "BackupAgeHours", ".", "."]] } },
    ]
  })
}
