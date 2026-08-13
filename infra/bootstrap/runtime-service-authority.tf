locals {
  pilot_name = "ai-delivery-orchestrator-pilot"
}

data "aws_iam_policy_document" "github_plan_runtime_services" {
  statement {
    sid = "InspectPilotRuntimeServices"
    actions = [
      "apigateway:GET", "application-autoscaling:DescribeScalableTargets", "cloudwatch:GetDashboard",
      "dynamodb:DescribeContinuousBackups", "dynamodb:DescribeTable", "dynamodb:DescribeTimeToLive", "dynamodb:ListTagsOfResource",
      "ec2:Describe*", "ecs:DescribeClusters", "ecs:DescribeServices", "ecs:DescribeTaskDefinition", "ecs:ListTagsForResource",
      "lambda:GetFunction", "lambda:GetFunctionConcurrency", "lambda:GetPolicy", "lambda:ListTags", "lambda:ListVersionsByFunction",
      "rds:DescribeDBClusters", "rds:DescribeDBInstances",
      "rds:DescribeDBSubnetGroups", "rds:ListTagsForResource", "sqs:GetQueueAttributes", "sqs:ListQueueTags",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_plan_runtime_services" {
  name   = "pilot-runtime-services-read-only"
  role   = aws_iam_role.github_plan.id
  policy = data.aws_iam_policy_document.github_plan_runtime_services.json
}

data "aws_iam_policy_document" "github_apply_runtime_services" {
  statement {
    sid = "ManagePilotEcs"
    actions = [
      "ecs:CreateCluster", "ecs:CreateService", "ecs:DeleteCluster", "ecs:DeleteService", "ecs:DeregisterTaskDefinition",
      "ecs:DescribeClusters", "ecs:DescribeServices", "ecs:ListTagsForResource",
      "ecs:PutClusterCapacityProviders", "ecs:TagResource", "ecs:UntagResource", "ecs:UpdateService",
    ]
    resources = [
      "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:cluster/${local.pilot_name}-worker",
      "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:service/${local.pilot_name}-worker/*",
      "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/${local.pilot_name}-worker:*",
      "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/${local.pilot_name}-migration:*",
    ]
  }
  statement {
    sid       = "InspectTaskDefinitions"
    actions   = ["ecs:DescribeTaskDefinition"]
    resources = ["*"]
  }
  statement {
    sid       = "RegisterPilotTaskDefinitions"
    actions   = ["ecs:RegisterTaskDefinition"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = ["ai-delivery-orchestrator"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Environment"
      values   = ["pilot"]
    }
  }
  statement {
    sid       = "ManagePilotQueues"
    actions   = ["sqs:CreateQueue", "sqs:DeleteQueue", "sqs:GetQueueAttributes", "sqs:ListQueueTags", "sqs:SetQueueAttributes", "sqs:TagQueue", "sqs:UntagQueue"]
    resources = ["arn:aws:sqs:${var.aws_region}:${var.aws_account_id}:${local.pilot_name}-*.fifo"]
  }
  statement {
    sid = "ManagePilotCoordinationTable"
    actions = [
      "dynamodb:CreateTable", "dynamodb:DeleteTable", "dynamodb:DescribeContinuousBackups", "dynamodb:DescribeTable",
      "dynamodb:DescribeTimeToLive", "dynamodb:ListTagsOfResource", "dynamodb:TagResource", "dynamodb:UntagResource",
      "dynamodb:UpdateContinuousBackups", "dynamodb:UpdateTable", "dynamodb:UpdateTimeToLive",
    ]
    resources = ["arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${local.pilot_name}-coordination"]
  }
  statement {
    sid = "ManagePilotDatabase"
    actions = [
      "rds:AddTagsToResource", "rds:CreateDBCluster", "rds:CreateDBInstance", "rds:CreateDBSubnetGroup", "rds:DeleteDBCluster",
      "rds:DeleteDBInstance", "rds:DeleteDBSubnetGroup", "rds:DescribeDBClusters", "rds:DescribeDBInstances",
      "rds:DescribeDBSubnetGroups", "rds:ListTagsForResource", "rds:ModifyDBCluster", "rds:ModifyDBInstance",
      "rds:ModifyDBSubnetGroup", "rds:RemoveTagsFromResource",
    ]
    resources = [
      "arn:aws:rds:${var.aws_region}:${var.aws_account_id}:cluster:${local.pilot_name}",
      "arn:aws:rds:${var.aws_region}:${var.aws_account_id}:db:${local.pilot_name}-writer",
      "arn:aws:rds:${var.aws_region}:${var.aws_account_id}:subgrp:${local.pilot_name}-database",
    ]
  }
  statement {
    sid = "ManagePilotLambda"
    actions = [
      "lambda:AddPermission", "lambda:CreateFunction", "lambda:DeleteFunction", "lambda:DeleteFunctionConcurrency",
      "lambda:GetFunction", "lambda:GetFunctionConcurrency", "lambda:GetPolicy", "lambda:ListTags", "lambda:ListVersionsByFunction",
      "lambda:PutFunctionConcurrency", "lambda:RemovePermission", "lambda:TagResource", "lambda:UntagResource",
      "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration",
    ]
    resources = ["arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${local.pilot_name}-*"]
  }
  statement {
    sid = "ManagePilotApiGateway"
    actions = [
      "apigateway:DELETE", "apigateway:GET", "apigateway:PATCH", "apigateway:POST", "apigateway:PUT",
      "apigateway:TagResource", "apigateway:UntagResource",
    ]
    resources = [
      "arn:aws:apigateway:${var.aws_region}::/apis",
      "arn:aws:apigateway:${var.aws_region}::/apis/*",
      "arn:aws:apigateway:${var.aws_region}::/tags/*",
    ]
  }
  statement {
    sid = "ManagePilotAutoscaling"
    actions = [
      "application-autoscaling:DeleteScalingPolicy", "application-autoscaling:DeregisterScalableTarget",
      "application-autoscaling:DescribeScalableTargets", "application-autoscaling:PutScalingPolicy",
      "application-autoscaling:RegisterScalableTarget", "application-autoscaling:TagResource", "application-autoscaling:UntagResource",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "application-autoscaling:service-namespace"
      values   = ["ecs"]
    }
  }
  statement {
    sid       = "ManagePilotDashboard"
    actions   = ["cloudwatch:DeleteDashboards", "cloudwatch:GetDashboard", "cloudwatch:PutDashboard"]
    resources = ["arn:aws:cloudwatch::${var.aws_account_id}:dashboard/${local.pilot_name}"]
  }
  statement {
    sid     = "CreateTaggedPilotEc2Resources"
    actions = ["ec2:CreateSecurityGroup", "ec2:CreateVpcEndpoint"]
    resources = [
      "arn:aws:ec2:${var.aws_region}:${var.aws_account_id}:security-group/*",
      "arn:aws:ec2:${var.aws_region}:${var.aws_account_id}:vpc-endpoint/*",
    ]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = ["ai-delivery-orchestrator"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Environment"
      values   = ["pilot"]
    }
  }
  statement {
    sid     = "UseTaggedPilotNetworkForCreate"
    actions = ["ec2:CreateSecurityGroup", "ec2:CreateVpcEndpoint"]
    resources = [
      "arn:aws:ec2:${var.aws_region}:${var.aws_account_id}:route-table/*",
      "arn:aws:ec2:${var.aws_region}:${var.aws_account_id}:security-group/*",
      "arn:aws:ec2:${var.aws_region}:${var.aws_account_id}:subnet/*",
      "arn:aws:ec2:${var.aws_region}:${var.aws_account_id}:vpc/*",
    ]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = ["ai-delivery-orchestrator"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Environment"
      values   = ["pilot"]
    }
  }
  statement {
    sid = "ManageTaggedPilotEc2Resources"
    actions = [
      "ec2:CreateTags", "ec2:DeleteSecurityGroup", "ec2:DeleteTags", "ec2:DeleteVpcEndpoints",
      "ec2:ModifyVpcEndpoint", "ec2:RevokeSecurityGroupEgress", "ec2:RevokeSecurityGroupIngress",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = ["ai-delivery-orchestrator"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Environment"
      values   = ["pilot"]
    }
  }
  statement {
    sid       = "CreateTaggedPilotSecurityGroupRules"
    actions   = ["ec2:AuthorizeSecurityGroupIngress"]
    resources = ["arn:aws:ec2:${var.aws_region}:${var.aws_account_id}:security-group-rule/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = ["ai-delivery-orchestrator"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Environment"
      values   = ["pilot"]
    }
  }
  statement {
    sid       = "UseTaggedPilotSecurityGroupsForIngress"
    actions   = ["ec2:AuthorizeSecurityGroupIngress"]
    resources = ["arn:aws:ec2:${var.aws_region}:${var.aws_account_id}:security-group/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = ["ai-delivery-orchestrator"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Environment"
      values   = ["pilot"]
    }
  }
  statement {
    sid = "ManagePilotEcrLambdaPolicy"
    actions = [
      "ecr:DeleteRepositoryPolicy", "ecr:DescribeImages", "ecr:GetRepositoryPolicy", "ecr:SetRepositoryPolicy",
    ]
    resources = ["arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/ai-delivery-orchestrator-worker"]
  }
}

resource "aws_iam_policy" "github_apply_runtime_services" {
  name   = "ai-delivery-orchestrator-pilot-runtime-services-apply"
  policy = data.aws_iam_policy_document.github_apply_runtime_services.json
}

resource "aws_iam_role_policy_attachment" "github_apply_runtime_services" {
  role       = aws_iam_role.github_apply.name
  policy_arn = aws_iam_policy.github_apply_runtime_services.arn
}
