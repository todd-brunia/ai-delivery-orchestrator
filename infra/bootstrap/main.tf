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
      values   = ["repo:${local.github_immutable_repository}:pull_request"]
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
      values   = ["pilot/*", "pilot-iam/*"]
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
    sid       = "ReadWritePilotIamState"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.terraform_state.arn}/pilot-iam/terraform.tfstate"]
  }
  statement {
    sid       = "ManagePilotIamLock"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.terraform_state.arn}/pilot-iam/terraform.tfstate.tflock"]
  }
  statement {
    sid = "InspectFoundation"
    actions = [
      "cloudwatch:DescribeAlarms", "ec2:Describe*", "logs:DescribeLogGroups", "sts:GetCallerIdentity",
    ]
    resources = ["*"]
  }
  statement {
    sid = "InspectPilotEcr"
    actions = [
      "ecr:DescribeRepositories", "ecr:GetLifecyclePolicy", "ecr:GetRepositoryPolicy", "ecr:ListTagsForResource",
    ]
    resources = ["arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/ai-delivery-orchestrator-worker"]
  }
  statement {
    sid       = "InspectPilotSecrets"
    actions   = ["secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy", "secretsmanager:ListSecretVersionIds"]
    resources = ["arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:ai-delivery-orchestrator/pilot/*"]
  }
  statement {
    sid       = "InspectPilotLogs"
    actions   = ["logs:ListTagsForResource"]
    resources = ["arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/ai-delivery-orchestrator/pilot/*"]
  }
  statement {
    sid       = "InspectPilotBudget"
    actions   = ["budgets:DescribeBudget", "budgets:ListTagsForResource", "budgets:ViewBudget"]
    resources = ["arn:aws:budgets::${var.aws_account_id}:budget/ai-delivery-orchestrator-pilot-monthly"]
  }
  statement {
    sid       = "InspectPilotBillingAlarm"
    actions   = ["cloudwatch:ListTagsForResource"]
    resources = ["arn:aws:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:ai-delivery-orchestrator-pilot-*"]
  }
  statement {
    sid = "InspectRuntimeSecretPolicy"
    actions = [
      "iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyTags", "iam:ListPolicyVersions",
    ]
    resources = ["arn:aws:iam::${var.aws_account_id}:policy/ai-delivery-orchestrator-pilot-runtime-secrets"]
  }
}

resource "aws_iam_role_policy" "github_plan" {
  name   = "pilot-foundation-read-only-plan"
  role   = aws_iam_role.github_plan.id
  policy = data.aws_iam_policy_document.github_plan.json
}

data "aws_iam_policy_document" "github_apply_trust" {
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
      values   = ["repo:${local.github_immutable_repository}:environment:${var.pilot_environment_name}"]
    }
  }
}

resource "aws_iam_role" "github_apply" {
  name                 = "ai-delivery-orchestrator-terraform-pilot-apply"
  assume_role_policy   = data.aws_iam_policy_document.github_apply_trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "github_apply" {
  statement {
    sid       = "ListPilotState"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.terraform_state.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["pilot/*", "pilot-iam/*"]
    }
  }
  statement {
    sid       = "ManagePilotState"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.terraform_state.arn}/pilot/terraform.tfstate"]
  }
  statement {
    sid       = "ManagePilotLock"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.terraform_state.arn}/pilot/terraform.tfstate.tflock"]
  }
  statement {
    sid       = "ManagePilotIamState"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.terraform_state.arn}/pilot-iam/terraform.tfstate"]
  }
  statement {
    sid       = "ManagePilotIamLock"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.terraform_state.arn}/pilot-iam/terraform.tfstate.tflock"]
  }
  statement {
    sid = "ManagePilotNetwork"
    actions = [
      "ec2:AssociateRouteTable", "ec2:AttachInternetGateway", "ec2:CreateInternetGateway",
      "ec2:CreateRoute", "ec2:CreateRouteTable", "ec2:CreateSubnet", "ec2:CreateTags",
      "ec2:CreateVpc", "ec2:DeleteInternetGateway", "ec2:DeleteRoute", "ec2:DeleteRouteTable",
      "ec2:DeleteSubnet", "ec2:DeleteTags", "ec2:DeleteVpc", "ec2:Describe*",
      "ec2:DetachInternetGateway", "ec2:DisassociateRouteTable", "ec2:ModifySubnetAttribute",
      "ec2:ModifyVpcAttribute",
    ]
    resources = ["*"]
  }
  statement {
    sid = "ManagePilotEcr"
    actions = [
      "ecr:CreateRepository", "ecr:DeleteLifecyclePolicy", "ecr:DeleteRepository",
      "ecr:DescribeRepositories", "ecr:GetLifecyclePolicy", "ecr:GetRepositoryPolicy",
      "ecr:ListTagsForResource", "ecr:PutLifecyclePolicy", "ecr:TagResource", "ecr:UntagResource",
    ]
    resources = ["arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/ai-delivery-orchestrator-worker"]
  }
  statement {
    sid = "ManagePilotSecrets"
    actions = [
      "secretsmanager:CreateSecret", "secretsmanager:DeleteSecret", "secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy",
      "secretsmanager:ListSecretVersionIds", "secretsmanager:TagResource", "secretsmanager:UntagResource",
      "secretsmanager:UpdateSecret",
    ]
    resources = ["arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:ai-delivery-orchestrator/pilot/*"]
  }
  statement {
    sid = "ManagePilotLogs"
    actions = [
      "logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:ListTagsForResource", "logs:PutRetentionPolicy",
      "logs:TagResource", "logs:UntagResource",
    ]
    resources = ["arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/ai-delivery-orchestrator/pilot/*"]
  }
  statement {
    sid       = "InspectPilotLogs"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }
  statement {
    sid = "ManagePilotBillingAlarm"
    actions = [
      "cloudwatch:DeleteAlarms", "cloudwatch:ListTagsForResource", "cloudwatch:PutMetricAlarm",
      "cloudwatch:TagResource", "cloudwatch:UntagResource",
    ]
    resources = ["arn:aws:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:ai-delivery-orchestrator-pilot-*"]
  }
  statement {
    sid       = "InspectPilotAlarms"
    actions   = ["cloudwatch:DescribeAlarms"]
    resources = ["*"]
  }
  statement {
    sid = "ManagePilotBudget"
    actions = [
      "budgets:CreateBudget", "budgets:DeleteBudget", "budgets:DescribeBudget", "budgets:ViewBudget",
      "budgets:ListTagsForResource", "budgets:ModifyBudget", "budgets:TagResource", "budgets:UntagResource",
    ]
    resources = ["arn:aws:budgets::${var.aws_account_id}:budget/ai-delivery-orchestrator-pilot-monthly"]
  }
  statement {
    sid = "ManageRuntimeSecretPolicy"
    actions = [
      "iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:DeletePolicyVersion",
      "iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions", "iam:ListPolicyTags",
      "iam:SetDefaultPolicyVersion", "iam:TagPolicy", "iam:UntagPolicy",
    ]
    resources = ["arn:aws:iam::${var.aws_account_id}:policy/ai-delivery-orchestrator-pilot-runtime-secrets"]
  }
}

resource "aws_iam_role_policy" "github_apply" {
  name   = "pilot-foundation-apply"
  role   = aws_iam_role.github_apply.id
  policy = data.aws_iam_policy_document.github_apply.json
}
