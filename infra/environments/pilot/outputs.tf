output "ecr_repository_url" { value = aws_ecr_repository.worker.repository_url }
output "public_subnet_ids" { value = values(aws_subnet.public)[*].id }
output "isolated_subnet_ids" { value = values(aws_subnet.isolated)[*].id }
output "application_secret_arns" {
  value = { for name, secret in aws_secretsmanager_secret.application : name => secret.arn }
}
output "runtime_secret_policy_arn" { value = var.runtime_secret_policy_arn }
output "database_cluster_arn" { value = aws_rds_cluster.application.arn }
output "database_endpoint" {
  value     = aws_rds_cluster.application.endpoint
  sensitive = true
}
output "database_security_group_id" { value = aws_security_group.database.id }
output "database_master_secret_arn" {
  value     = aws_rds_cluster.application.master_user_secret[0].secret_arn
  sensitive = true
}
output "application_database_schema" { value = "orchestrator" }
output "checkpoint_database_schema" { value = "langgraph_checkpoints" }
output "runtime_queue_arns" { value = { for name, queue in aws_sqs_queue.runtime : name => queue.arn } }
output "runtime_dlq_arns" { value = { for name, queue in aws_sqs_queue.dead_letter : name => queue.arn } }
output "runtime_coordination_table_arn" { value = aws_dynamodb_table.runtime_coordination.arn }
output "worker_cluster_arn" { value = aws_ecs_cluster.worker.arn }
output "worker_service_name" { value = aws_ecs_service.worker.name }
output "worker_security_group_id" { value = aws_security_group.worker.id }
output "worker_task_definition_arn" { value = aws_ecs_task_definition.worker.arn }
output "migration_task_definition_arn" { value = aws_ecs_task_definition.migration.arn }
output "supervised_dispatch_task_definition_arn" { value = aws_ecs_task_definition.supervised_dispatch.arn }
output "supervised_dispatch_security_group_id" { value = aws_security_group.supervised_dispatch.id }
output "operator_api_endpoint" {
  value     = aws_apigatewayv2_api.operator.api_endpoint
  sensitive = true
}
output "operator_lambda_arn" { value = aws_lambda_function.operator.arn }
output "pilot_dashboard_name" { value = aws_cloudwatch_dashboard.pilot.dashboard_name }
