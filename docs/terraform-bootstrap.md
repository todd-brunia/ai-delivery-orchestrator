# Terraform and AWS Bootstrap

## Current boundary

The checked-in Terraform defines a state/OIDC bootstrap and a pilot foundation
containing ECR, networking, empty secret containers, retained log groups, an
informational billing alarm, and an AWS Budget. It does not define ECS, Lambda,
API Gateway, SQS, DynamoDB, Aurora, secret values, or application credentials.

The bootstrap remains a one-time, explicitly authorized human operation: AWS
must trust GitHub before a GitHub workflow can assume an AWS role. After that
bootstrap, normal pilot planning and provisioning occurs through GitHub
Actions. Do not apply the pilot stack from a developer workstation.

## Prerequisites

- Complete the durable identity, account-isolation, budget, and CLI checkpoints
  in [Client AWS account foundation](./client-aws-account-foundation.md).
- Terraform 1.15.8 (the configuration permits 1.10 through 1.x).
- An explicitly selected AWS account and `us-east-1` access.
- Authority to create the bootstrap S3 and IAM resources.
- A globally unique, non-sensitive S3 bucket name.
- The repository owner's numeric GitHub ID and the repository's numeric GitHub
  ID for immutable OIDC subjects.

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

CI always performs credential-free checks. `.github/workflows/terraform-plan.yml`
performs an AWS-backed speculative pilot plan for same-repository pull requests
when `AWS_TERRAFORM_PLAN_ROLE_ARN`, `AWS_ACCOUNT_ID`, and `TF_STATE_BUCKET`
repository variables are configured. Fork pull requests never receive an OIDC
token. The plan uses a non-deliverable placeholder email; the real notification
address exists only in protected environment configuration.

## One-time bootstrap sequence

1. Copy `infra/bootstrap/terraform.tfvars.example` to an ignored local
   `.tfvars` file and replace all placeholders.
2. Reauthenticate to the intended AWS account and verify its account ID.
3. Run `terraform -chdir=infra/bootstrap plan`. Confirm it contains only the
   state bucket, GitHub OIDC provider, pull-request plan role, protected pilot
   apply role, and their policies.
4. Apply only after explicit human authorization.
5. Record the state bucket and plan-role ARN as GitHub repository variables.
   They are identifiers, not credentials.
6. Create a protected GitHub environment named `pilot`. Require a human
   reviewer and prevent unreviewed branches from deploying.
7. In the `pilot` environment, set `AWS_ACCOUNT_ID`, `TF_STATE_BUCKET`,
   `AWS_TERRAFORM_APPLY_ROLE_ARN`, and `BUDGET_NOTIFICATION_EMAIL` variables.
   The notification address is account configuration and is not committed.

The bootstrap begins with local state because it creates its own remote state
bucket. Preserve that state securely until a separately reviewed migration
places it in an appropriate protected backend.

An AWS account can have only one GitHub Actions OIDC provider for this issuer.
If the account already contains it, import that provider into the bootstrap
state rather than attempting to create a duplicate or deleting the shared
provider.

## Immutable GitHub OIDC identity

GitHub repositories using immutable OIDC subjects include stable numeric owner
and repository IDs alongside their names. This prevents a renamed or recycled
namespace from inheriting cloud trust. Retrieve the public identifiers without
requesting or retaining an OIDC token:

```bash
gh api users/OWNER --jq .id
gh api repos/OWNER/REPOSITORY --jq .id
```

Set the results as `github_repository_owner_id` and `github_repository_id` in
the ignored bootstrap variable file. The plan role then trusts only:

```text
repo:OWNER@OWNER-ID/REPOSITORY@REPOSITORY-ID:pull_request
```

The apply role trusts only the same immutable repository identity followed by
`environment:pilot`. Do not replace either condition with the legacy name-only
format or a wildcard. Numeric GitHub IDs are public identifiers, but reusable
examples contain placeholders rather than live installation values.

## Existing-bootstrap trust update

When immutable identity support is added after the bootstrap already exists,
preserve `infra/bootstrap/terraform.tfstate`; it remains authoritative. Update
the ignored variable file with the existing account, bucket, and immutable
GitHub IDs, then create a saved plan:

```bash
terraform -chdir=infra/bootstrap plan \
  -out=immutable-oidc.tfplan \
  -var-file=terraform.tfvars
```

The reviewed update must report exactly `0 to add, 2 to change, 0 to destroy`,
with in-place `assume_role_policy` changes only for the plan and apply roles.
Do not apply a plan that creates, replaces, or destroys a resource. Apply that
saved plan only after separate human authorization, then rerun the
pull-request-only Terraform workflow. Verify role assumption and remote-state
locking from Actions logs; use CloudTrail metadata for failures without ever
logging or retaining the web identity token.

## Pilot backend and plan

```bash
terraform -chdir=infra/environments/pilot init \
  -backend-config="bucket=REPLACE_WITH_STATE_BUCKET"
terraform -chdir=infra/environments/pilot plan \
  -var="aws_account_id=REPLACE_WITH_12_DIGIT_ACCOUNT_ID"
```

The backend uses S3 native lockfiles at `pilot/terraform.tfstate.tflock`. The
OIDC plan role can access only the pilot state and inspect declared resources;
it cannot mutate managed infrastructure.

## Protected pilot provisioning

Dispatch `Terraform apply` from GitHub Actions with the full 40-character SHA
of a reviewed commit on `main`. The workflow:

1. waits for approval through the protected `pilot` environment;
2. rejects malformed SHAs and any commit other than the current `origin/main`;
3. assumes the environment-scoped apply role through OIDC;
4. creates a saved Terraform plan for that exact commit; and
5. applies that saved plan in the same job.

The workflow has a single non-cancelling concurrency group, so two pilot applies
cannot overlap. There is no automated destroy path. Pull requests and ordinary
pushes cannot invoke apply.

## Secrets, logging, and alerts

Terraform creates exactly three empty Secrets Manager containers. Enter the
GitHub App private key, webhook secret, and OpenAI API key through an authorized
AWS process after provisioning; never put values in Terraform, GitHub Actions
arguments, logs, fixtures, or state. The runtime read policy is deliberately
unattached until a later reviewed runtime-role slice.

Application log groups retain data for 30 days by default and use CloudWatch's
encryption at rest. Logs must never contain webhook bodies, credentials,
private source, prompts, or raw model reasoning. The billing alarm is
informational and can optionally notify up to five configured SNS topics. AWS
Billing metrics must be enabled for it to leave `INSUFFICIENT_DATA`.

The monthly AWS Budget is filtered by the `Project` cost-allocation tag and
sends a forecast notification at 80 percent by default. AWS must activate that
tag for cost allocation; until then, treat the budget as incomplete coverage.
Notifications never disable resources or grant workflow authority. Queue,
Lambda, ECS, and Aurora alarms remain deferred until those resources exist.

## Cost, rollback, and recovery

This repository change costs nothing until applied. S3 state, ECR
storage/scanning, public IPv4 usage, Secrets Manager containers, CloudWatch,
and notifications can incur charges after creation. AWS Budgets may also have
service-specific pricing. There is intentionally no NAT Gateway.

The state bucket has `prevent_destroy`, versioning, encryption, and public
access blocking. Do not bypass those protections to recover from an error.
Investigate lock ownership before deleting a `.tflock` object. Destroying pilot
resources or bootstrap requires its own reviewed plan; no automated destroy
path is provided.
