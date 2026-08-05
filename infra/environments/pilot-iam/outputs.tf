output "runtime_secret_policy_arn" {
  description = "Exact policy reference passed explicitly to the main pilot stack."
  value       = aws_iam_policy.runtime_secrets.arn
}
