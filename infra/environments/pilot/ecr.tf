resource "aws_ecr_repository" "worker" {
  name                 = "ai-delivery-orchestrator-worker"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
}
resource "aws_ecr_lifecycle_policy" "worker" {
  repository = aws_ecr_repository.worker.name
  policy     = jsonencode({ rules = [{ rulePriority = 1, description = "Retain 30 most recent images", selection = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }, action = { type = "expire" } }] })
}

data "aws_iam_policy_document" "worker_lambda_pull" {
  statement {
    sid     = "AllowPilotLambdaImagePull"
    actions = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${local.name}-*"]
    }
  }
}

resource "aws_ecr_repository_policy" "worker_lambda_pull" {
  repository = aws_ecr_repository.worker.name
  policy     = data.aws_iam_policy_document.worker_lambda_pull.json
}
