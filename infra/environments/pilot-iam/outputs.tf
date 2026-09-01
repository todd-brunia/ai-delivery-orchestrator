output "runtime_secret_policy_arn" {
  description = "Exact policy reference passed explicitly to the main pilot stack."
  value       = aws_iam_policy.runtime_secrets.arn
}
output "runtime_role_arns" {
  value = {
    webhook                       = aws_iam_role.webhook.arn
    operator_api                  = aws_iam_role.operator_api.arn
    worker                        = aws_iam_role.worker.arn
    worker_execution              = aws_iam_role.worker_execution.arn
    migration                     = aws_iam_role.migration.arn
    migration_execution           = aws_iam_role.migration_execution.arn
    supervised_dispatch           = aws_iam_role.supervised_dispatch.arn
    supervised_dispatch_execution = aws_iam_role.supervised_dispatch_execution.arn
  }
}
output "provider_role_arns" { value = { for name, role in aws_iam_role.provider : name => role.arn } }
