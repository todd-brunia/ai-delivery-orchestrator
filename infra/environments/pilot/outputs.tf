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
