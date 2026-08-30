output "state_bucket_name" { value = aws_s3_bucket.terraform_state.id }
output "github_plan_role_arn" { value = aws_iam_role.github_plan.arn }
output "github_apply_role_arn" { value = aws_iam_role.github_apply.arn }
output "github_runtime_deploy_role_arn" { value = aws_iam_role.github_runtime_deploy.arn }
output "github_publish_role_arn" { value = aws_iam_role.github_publish.arn }
