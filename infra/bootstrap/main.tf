resource "aws_s3_bucket" "terraform_state" {
  bucket = var.state_bucket_name
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket                  = aws_s3_bucket.terraform_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "terraform_state" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.terraform_state.arn,
      "${aws_s3_bucket.terraform_state.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  policy = data.aws_iam_policy_document.terraform_state.json
}

resource "aws_s3_bucket_lifecycle_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  rule {
    id     = "retain-noncurrent-state"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "github_plan_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:pull_request"]
    }
  }
}

resource "aws_iam_role" "github_plan" {
  name                 = "ai-delivery-orchestrator-terraform-plan"
  assume_role_policy   = data.aws_iam_policy_document.github_plan_trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "github_plan" {
  statement {
    sid       = "ListPilotState"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.terraform_state.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["pilot/*"]
    }
  }
  statement {
    sid       = "ReadWritePilotState"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.terraform_state.arn}/pilot/terraform.tfstate"]
  }
  statement {
    sid       = "ManagePilotLock"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.terraform_state.arn}/pilot/terraform.tfstate.tflock"]
  }
  statement {
    sid       = "InspectFoundation"
    actions   = ["ec2:Describe*", "ecr:DescribeRepositories", "ecr:GetLifecyclePolicy", "ecr:GetRepositoryPolicy", "ecr:ListTagsForResource", "sts:GetCallerIdentity"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_plan" {
  name   = "pilot-foundation-read-only-plan"
  role   = aws_iam_role.github_plan.id
  policy = data.aws_iam_policy_document.github_plan.json
}
