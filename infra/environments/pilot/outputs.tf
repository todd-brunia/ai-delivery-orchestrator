output "ecr_repository_url" { value = aws_ecr_repository.worker.repository_url }
output "public_subnet_ids" { value = values(aws_subnet.public)[*].id }
output "isolated_subnet_ids" { value = values(aws_subnet.isolated)[*].id }
output "application_secret_arns" {
  value = { for name, secret in aws_secretsmanager_secret.application : name => secret.arn }
}
output "runtime_secret_policy_arn" { value = aws_iam_policy.runtime_secrets.arn }
