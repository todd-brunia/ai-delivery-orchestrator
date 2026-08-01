# Terraform and AWS Bootstrap

## Current boundary

The checked-in Terraform is reviewed configuration, not a deployment. It
defines the state/OIDC bootstrap and a pilot foundation containing ECR and
networking only. It does not define ECS, Lambda, API Gateway, SQS, DynamoDB,
Aurora, secrets, budgets, alarms, or application credentials.

No automated apply workflow exists. Applying either stack requires a separate
approved issue and an authenticated human operator.

## Prerequisites

- Terraform 1.15.8 (the configuration permits 1.10 through 1.x).
- An explicitly selected AWS account and `us-east-1` access.
- Authority to create the bootstrap S3 and IAM resources.
- A globally unique, non-sensitive S3 bucket name.

Never commit account-specific `.tfvars`, backend files, state, lock files, or
plans. Example variable files contain placeholders only.

## Validate without AWS credentials

```bash
terraform fmt -check -recursive infra
terraform -chdir=infra/bootstrap init -backend=false
terraform -chdir=infra/bootstrap validate
terraform -chdir=infra/environments/pilot init -backend=false
terraform -chdir=infra/environments/pilot validate
npm test
```

CI always performs these checks. It performs an AWS-backed speculative pilot
plan only when `AWS_TERRAFORM_PLAN_ROLE_ARN`, `AWS_ACCOUNT_ID`, and
`TF_STATE_BUCKET` repository variables are all configured.

## Bootstrap sequence (future authorized operation)

1. Copy `infra/bootstrap/terraform.tfvars.example` to an ignored local
   `.tfvars` file and replace both placeholders.
2. Reauthenticate to the intended AWS account and verify its account ID.
3. Run `terraform -chdir=infra/bootstrap plan`. Confirm it contains only the
   state bucket, GitHub OIDC provider, pull-request plan role, and policies.
4. Apply only after explicit human authorization.
5. Record the state bucket and plan-role ARN as protected GitHub repository
   variables. They are identifiers, not credentials.

The bootstrap begins with local state because it creates its own remote state
bucket. Preserve that state securely until a separately reviewed migration
places it in an appropriate protected backend.

An AWS account can have only one GitHub Actions OIDC provider for this issuer.
If the account already contains it, import that provider into the bootstrap
state rather than attempting to create a duplicate or deleting the shared
provider.

## Pilot backend and plan

```bash
terraform -chdir=infra/environments/pilot init \
  -backend-config="bucket=REPLACE_WITH_STATE_BUCKET"
terraform -chdir=infra/environments/pilot plan \
  -var="aws_account_id=REPLACE_WITH_12_DIGIT_ACCOUNT_ID"
```

The backend uses S3 native lockfiles at
`pilot/terraform.tfstate.tflock`. The OIDC plan role can access only the pilot
state object and lockfile and inspect foundation resources; it cannot create,
update, or delete managed infrastructure.

## Cost, rollback, and recovery

This repository change costs nothing until applied. S3 state, ECR
storage/scanning, and public IPv4 usage can incur charges after creation. There
is intentionally no NAT Gateway.

The state bucket has `prevent_destroy`, versioning, encryption, and public
access blocking. Do not bypass those protections to recover from an error.
Investigate lock ownership before deleting a `.tflock` object. Destroying pilot
resources or bootstrap requires its own reviewed plan; no automated destroy
path is provided.
