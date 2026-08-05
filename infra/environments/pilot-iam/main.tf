data "aws_iam_policy_document" "runtime_secrets" {
  statement {
    sid     = "ReadPilotApplicationSecrets"
    actions = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
    resources = [
      for name in local.application_secret_names :
      "arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:ai-delivery-orchestrator/pilot/${name}-??????"
    ]
  }
}

resource "aws_iam_policy" "runtime_secrets" {
  name        = "${local.name}-runtime-secrets"
  description = "Unattached policy for the future pilot runtime; attachment requires a reviewed compute slice."
  policy      = data.aws_iam_policy_document.runtime_secrets.json
}
