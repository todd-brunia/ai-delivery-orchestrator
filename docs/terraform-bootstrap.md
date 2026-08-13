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
   apply role, main-only ECR publishing role, and their policies.
4. Apply only after explicit human authorization.
5. Record the state bucket and plan-role ARN as GitHub repository variables.
   They are identifiers, not credentials. Leave the repository variable
   `PILOT_IAM_STATE_ENABLED` unset until the separately reviewed bootstrap
   update grants both OIDC roles access to the dedicated IAM state key.
6. Create a protected GitHub environment named `pilot`. Require a human
   reviewer and prevent unreviewed branches from deploying.
7. In the `pilot` environment, set `AWS_ACCOUNT_ID`, `TF_STATE_BUCKET`, and
   `AWS_TERRAFORM_APPLY_ROLE_ARN` as variables. Set
   `BUDGET_NOTIFICATION_EMAIL` as a protected environment secret so Actions
   masks it in mutation-workflow logs. After the first IAM-enabled deployment,
   also set `RUNTIME_SECRET_POLICY_ARN` as a variable; it is an identifier, not
   a credential, and is required when a deployment skips IAM provisioning.

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

## Pilot IAM and main backends

Pilot/application IAM is isolated in `infra/environments/pilot-iam` with the
`pilot-iam/terraform.tfstate` backend key. The main root uses
`pilot/terraform.tfstate` and must not manage IAM. Both use S3 native lockfiles.
The roots exchange only an explicit, validated policy ARN; neither reads the
other's Terraform state.

For the first protected deployment, the apply workflow breaks the generated
identifier cycle in three fail-closed stages. It first creates the IAM roles
with narrowly scoped placeholder secret identifiers that do not name existing
resources. It then applies the main stack while the worker remains scaled to
zero and secret-dependent ingress cannot succeed with the placeholder policy.
Finally, it reads only Terraform outputs (never secret values), creates a new
saved IAM plan using the concrete database and webhook secret identifiers,
rejects deletes or replacements, and applies that converged plan. A failure at
any stage stops the job; rerunning the same current-main SHA replans from the
remote state rather than deleting or rolling back resources.

Before that first deployment, update the bootstrap plan and apply identities
with the exact runtime-role authority declared in `infra/bootstrap`. Review a
saved bootstrap plan that changes only the existing plan/apply inline policies
in place: no trust-policy, principal, role-name, state-resource, replacement,
creation, or deletion change is allowed. The plan identity receives inspection
only. The apply identity receives lifecycle authority over the twelve enumerated
runtime/provider roles and may pass them only to Lambda or ECS tasks; it cannot
manage bootstrap or human-operator roles.

If role creation succeeds but Terraform cannot complete its post-create read,
stop before the main stack. Add the missing read action through a reviewed
bootstrap policy change, verify the created role count, trust, and tags without
printing identifiers, and inspect the remote state. Do not accept a replacement
plan for the roles. Untaint only the exact verified role addresses after a
separate human checkpoint, then require a fresh pilot-IAM plan with no deletes
or replacements before retrying the protected workflow.

```bash
terraform -chdir=infra/environments/pilot-iam init \
  -backend-config="bucket=REPLACE_WITH_STATE_BUCKET"
terraform -chdir=infra/environments/pilot-iam plan \
  -var="aws_account_id=REPLACE_WITH_12_DIGIT_ACCOUNT_ID"
terraform -chdir=infra/environments/pilot init \
  -backend-config="bucket=REPLACE_WITH_STATE_BUCKET"
terraform -chdir=infra/environments/pilot plan \
  -var="aws_account_id=REPLACE_WITH_12_DIGIT_ACCOUNT_ID" \
  -var="runtime_secret_policy_arn=arn:aws:iam::REPLACE_WITH_12_DIGIT_ACCOUNT_ID:policy/ai-delivery-orchestrator-pilot-runtime-secrets"
```

The OIDC plan role can access only these two pilot state keys and inspect
declared resources; it cannot mutate managed infrastructure.

During the implementation rollout, pull-request CI temporarily excludes the
IAM backend declaration and initializes local, ephemeral state while
`PILOT_IAM_STATE_ENABLED` is unset. The runner never applies or publishes that
state. After the merged bootstrap change is separately planned and applied,
set that repository variable to the literal value `true`. Protected IAM apply
fails closed unless the flag is `true`; subsequent pull requests then plan
against remote IAM state. The flag grants no authority by itself.

For an existing bootstrap, preserve its local state and create a saved
bootstrap plan after merging the IAM separation change. The reviewed plan must
show exactly two in-place updates: the plan-role and apply-role inline
permission policies gain access to `pilot-iam/terraform.tfstate` and its lock.
OIDC trust, principals, role names, the state bucket, and all other resources
must remain unchanged. Apply the saved plan only after separate authorization,
then set `PILOT_IAM_STATE_ENABLED=true` and rerun the Terraform plan workflow.

## Protected pilot provisioning

Dispatch `Terraform apply` from GitHub Actions with the full 40-character SHA
of a reviewed commit on `main`. Set `provision_iam` to `true` for the first
deployment or an explicitly reviewed IAM change. Leave it at its fail-closed
default, `false`, for ordinary main-stack changes; the workflow then requires
the exact `RUNTIME_SECRET_POLICY_ARN` protected environment variable. The
workflow:

1. waits for approval through the protected `pilot` environment;
2. rejects malformed SHAs and any commit other than the current `origin/main`;
3. assumes the environment-scoped apply role through OIDC;
4. when explicitly enabled, creates and applies a saved pilot-IAM plan before
   exporting its concrete policy output;
5. creates a saved main-stack plan for that exact commit with the validated IAM
   reference; and
6. applies that saved plan in the same job.

After the first successful IAM-enabled deployment, record the emitted
`runtime_secret_policy_arn` output as the protected environment variable
`RUNTIME_SECRET_POLICY_ARN`. Future main-only deployments leave
`provision_iam=false` and fail unless that exact account-scoped ARN is present.

The workflow has a single non-cancelling concurrency group, so two pilot applies
cannot overlap. There is no automated destroy path. Pull requests and ordinary
pushes cannot invoke apply.

## Immutable worker image publication

`.github/workflows/publish-worker-image.yml` builds the reviewed `Dockerfile`
on every push to `main` and publishes exactly one tag: the full commit SHA. It
does not publish `latest`, accept user-supplied tags, run for pull requests, or
deploy the image. The workflow uses a dedicated OIDC role whose trust is scoped
to the immutable repository identity and `ref:refs/heads/main`; it does not use
either Terraform role.

For an existing bootstrap, merge the implementation before changing AWS or
GitHub configuration. The first workflow run is expected to fail closed while
`AWS_ECR_PUBLISH_ROLE_ARN` is absent. Preserve the authoritative local
bootstrap state, verify the non-root pilot identity, and create a saved plan:

```text
AWS_PROFILE=ai-orchestrator-pilot terraform -chdir=infra/bootstrap plan -out=ecr-publish-role.tfplan -var-file=terraform.tfvars
```

Require exactly `2 to add, 0 to change, 0 to destroy`: the dedicated publish
role and its inline policy. The plan must not change the existing roles, OIDC
provider, state bucket, trust relationships, or pilot resources. Apply that
saved plan only after separate explicit authorization, then require a
follow-up bootstrap plan with no changes.

Record the verified `github_publish_role_arn` output as the repository Actions
variable `AWS_ECR_PUBLISH_ROLE_ARN`. It is an identifier, not a credential. Do
not print or store the account ID unnecessarily, and do not configure access
keys. A subsequent separately reviewed merge to `main` performs the first real
publication.

Before building, the workflow requires proof that the commit tag does not
already exist. An existing tag, a permission failure, or an inconclusive ECR
read stops publication. Because the repository is immutable, rerunning a
successful commit publication is expected to fail safely; never delete or
overwrite the image to make a rerun pass.

### Recover the recorded partial apply

The initial pilot apply failed during provider post-create reads after AWS had
created and Terraform had recorded all resources. The IAM state contains its
one managed policy and the main state contains all 23 managed resources. Four
main-state instances were nevertheless marked tainted:

- `aws_budgets_budget.monthly`
- `aws_secretsmanager_secret.application["github-app-private-key"]`
- `aws_secretsmanager_secret.application["github-webhook-secret"]`
- `aws_secretsmanager_secret.application["openai-api-key"]`

Do not apply the resulting replacement plan. Do not import, remove state,
destroy, or recreate the budget or secrets. Ordinary apply now inspects each
saved plan and fails before apply when any resource action contains `delete`,
including a delete-and-create replacement. The protected destroy workflow
remains the only workflow intended to apply deletion plans.

The missing provider reads were completed by adding
`secretsmanager:GetResourcePolicy`, `budgets:ViewBudget`, and
`budgets:ListTagsForResource` to the bootstrap role policies on their existing
scoped resources. The final saved bootstrap plan changed only the apply-role
inline policy in place with `0 to add, 0 to destroy`, and the separately
authorized apply completed successfully. A follow-up bootstrap plan reported
no changes.

Before rerunning apply, migrate the protected environment configuration:

1. create the `BUDGET_NOTIFICATION_EMAIL` environment secret with the current
   notification address;
2. verify only that the secret name exists—never retrieve or print its value;
3. delete the same-named environment variable to prevent ambiguity; and
4. set `RUNTIME_SECRET_POLICY_ARN` to the exact output from the complete IAM
   state.

Initialize the main pilot backend locally using the protected profile and state
bucket:

```text
AWS_PROFILE=ai-orchestrator-pilot terraform -chdir=infra/environments/pilot init -reconfigure -input=false -backend-config="bucket=$TF_STATE_BUCKET"
```

Immediately before changing state, run both read-only assertions below. The
first requires 23 instances. The second requires exactly the four tainted
addresses listed above. Each command prints only `true` on success and exits
nonzero on a mismatch; stop if either fails. Do not save or print the complete
state because it contains protected configuration.

```text
AWS_PROFILE=ai-orchestrator-pilot terraform -chdir=infra/environments/pilot state pull | jq -e '[.resources[].instances[]] | length == 23'
AWS_PROFILE=ai-orchestrator-pilot terraform -chdir=infra/environments/pilot state pull | jq -e '[.resources[] as $resource | $resource.instances[] | select(.status == "tainted") | if .index_key == null then "\($resource.type).\($resource.name)" else "\($resource.type).\($resource.name)[\(.index_key | @json)]" end] | sort == ["aws_budgets_budget.monthly", "aws_secretsmanager_secret.application[\"github-app-private-key\"]", "aws_secretsmanager_secret.application[\"github-webhook-secret\"]", "aws_secretsmanager_secret.application[\"openai-api-key\"]"]'
```

Create a fresh read-only main-stack plan with the configured runtime policy ARN
and notification email. Provider refresh must succeed with the corrected
permissions, and destructive actions must be limited to replacements of
exactly those four tainted addresses. Do not save, dispatch, or apply that
replacement plan. Stop on any provider error or additional change.

Only after separate authorization for these exact addresses, run:

```text
AWS_PROFILE=ai-orchestrator-pilot terraform -chdir=infra/environments/pilot untaint 'aws_budgets_budget.monthly'
AWS_PROFILE=ai-orchestrator-pilot terraform -chdir=infra/environments/pilot untaint 'aws_secretsmanager_secret.application["github-app-private-key"]'
AWS_PROFILE=ai-orchestrator-pilot terraform -chdir=infra/environments/pilot untaint 'aws_secretsmanager_secret.application["github-webhook-secret"]'
AWS_PROFILE=ai-orchestrator-pilot terraform -chdir=infra/environments/pilot untaint 'aws_secretsmanager_secret.application["openai-api-key"]'
```

Immediately after repair, repeat the 23-instance assertion and require that no
instance is tainted:

```text
AWS_PROFILE=ai-orchestrator-pilot terraform -chdir=infra/environments/pilot state pull | jq -e '[.resources[].instances[]] | length == 23'
AWS_PROFILE=ai-orchestrator-pilot terraform -chdir=infra/environments/pilot state pull | jq -e '[.resources[].instances[] | select(.status == "tainted")] | length == 0'
```

Then create a fresh main-stack plan with
`provision_iam=false`; it must report `0 to add, 0 to change, 0 to destroy`
before a protected recovery apply is dispatched. Do not reuse a failed run's
saved plan or artifacts.

## Protected pilot teardown

`Terraform destroy` is a manual-only workflow for removing pilot resources
when they are not needed. It uses the same protected `pilot` environment,
short-lived OIDC apply role, current-main commit check, and non-cancelling
concurrency group as provisioning. Apply and destroy therefore cannot overlap.

Dispatch the workflow with all of the following:

- the full 40-character SHA currently at `origin/main`;
- the exact confirmation `DESTROY PILOT`; and
- `destroy_iam=false` unless deletion of the no-cost, unattached runtime policy
  is separately intended.

The workflow creates a saved main-stack destroy plan and applies that exact
plan. Only after it succeeds may the explicitly enabled IAM destroy steps run.
It never targets `infra/bootstrap`, the OIDC provider, GitHub roles, the state
bucket, state objects, state history, or GitHub environment configuration.

Before the first apply or any destroy after this workflow is introduced,
update the existing bootstrap permissions through a separately authorized
saved plan. It must report `0 to add, 2 to change, 0 to destroy` and change only
the plan-role and apply-role inline policies from the obsolete ECR repository
ARN to `repository/ai-delivery-orchestrator-worker`. Stop if trust, principals,
role names, state access, or any other permission changes.

An approved main-stack teardown permanently deletes the VPC, subnets, routes,
internet gateway, ECR repository and all stored images, CloudWatch log groups
and their logs, billing alarm, and budget. Terraform schedules the three secret
containers for deletion with their 30-day recovery windows; it does not
immediately erase them. The confirmation phrase explicitly acknowledges the
permanent ECR image and log loss.

Bootstrap resources and both remote state histories remain after teardown.
They can continue to incur S3 storage charges. The pilot IAM policy is retained
by default and has no direct service charge, but any separately retained or
pending-deletion service resources should still be checked in Cost Explorer.

To reprovision during the secret recovery window, first restore each
pending-deletion secret through an authorized operator session:

```bash
aws secretsmanager restore-secret --profile REPLACE_WITH_AUTHORIZED_PILOT_PROFILE --region us-east-1 --secret-id ai-delivery-orchestrator/pilot/github-app-private-key
aws secretsmanager restore-secret --profile REPLACE_WITH_AUTHORIZED_PILOT_PROFILE --region us-east-1 --secret-id ai-delivery-orchestrator/pilot/github-webhook-secret
aws secretsmanager restore-secret --profile REPLACE_WITH_AUTHORIZED_PILOT_PROFILE --region us-east-1 --secret-id ai-delivery-orchestrator/pilot/openai-api-key
```

Verify all three are active before dispatching apply. Never recreate them under
a different name, shorten the recovery window, or place their values in
Terraform. After the recovery window expires, a later reviewed apply can create
new empty containers and their values must be re-entered through the authorized
secret process.

If destroy fails, preserve the state and lock evidence. Do not delete a lock or
edit state. Correct the permission or dependency problem through a reviewed
change, then dispatch the workflow again for the still-current main SHA; the
new saved plan will contain only resources that remain. After completion,
verify the workflow result and use read-only plans for both roots to confirm
their expected empty or retained state.

## Existing pilot IAM state migration

When upgrading an existing pilot, retain the legacy `github-app-private-key`
container so Terraform does not destroy or expose its existing value. The
reviewed plan creates new empty builder, reviewer, and merger containers; it
does not copy or read the legacy value. Require exactly three creates and no
updates/replacements/deletes. The legacy container is removed from runtime IAM
by the same change and is therefore disabled for future workloads. Its later
recovery-aware deletion or value migration requires a separate plan and
explicit human authorization.

No migration is needed before the first pilot apply. If a future installation
already has `aws_iam_policy.runtime_secrets` in the main pilot state, migration
is a separate state-changing operation and is not authorized by an
implementation PR or ordinary apply approval.

Before any migration, download protected backups of both remote states, record
their serials and lineage, and confirm the policy ARN from AWS. Import the
existing policy into the dedicated IAM state first; do not recreate it. After a
no-change IAM plan confirms the import, remove only the legacy policy address
from the main state. Plan both roots and require no create, replace, detach, or
destroy action before proceeding. Keep backups outside source control and
never pass state through issue comments, logs, or workflow artifacts.

If any resource other than the single runtime policy appears in the migration
plan, stop. Restoring a state backup, removing an import, destroying a policy,
or changing an attachment requires its own reviewed recovery plan and explicit
authorization.

## Secrets, logging, and alerts

Terraform creates separate empty builder, reviewer, and merger GitHub App key
containers alongside the webhook and OpenAI containers. Existing deployments
also retain the disabled generic GitHub App container until a separately
authorized cleanup. Enter values through an authorized
AWS process after provisioning; never put values in Terraform, GitHub Actions
arguments, logs, fixtures, or state. The runtime read policy is deliberately
unattached until a later reviewed runtime-role slice and excludes reviewer and
merger containers.

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

The protected plan and apply identities use separate policies for the runtime
service slice. The plan policy is inspection-only and inline. The apply policy
is an exact-named customer-managed policy attached only to the protected apply
role because the pre-existing apply inline policy plus the service lifecycle
document exceeds AWS's 10,240-byte aggregate inline-policy quota. The apply policy
covers the explicitly named/tagged pilot ECS, SQS, DynamoDB, RDS, Lambda,
API Gateway, application-autoscaling, CloudWatch dashboard, security-group,
and VPC-endpoint resources. API Gateway paths, ECS task-definition creation,
application autoscaling, and EC2 create/manage APIs require wildcard resource
scope; constrain them by pilot account/region paths, immutable service
namespace, and `Project=ai-delivery-orchestrator` plus `Environment=pilot`
request/resource tags wherever AWS supports those condition keys. The separate
exact-role `iam:PassRole` boundary remains unchanged.

After any partial main-stack apply, preserve remote state and generate a fresh
residual plan. Do not clean up successful resources or retry against the old
saved plan. Expand a missing permission only through a reviewed bootstrap plan,
require zero bootstrap drift after apply, and then require fresh pilot-IAM and
main plans with no deletion, replacement, or taint before another protected
deployment attempt.

Security-group and VPC-endpoint creation authorizes tagged new target resources
separately from the existing pilot VPC, subnet, route-table, and security-group
dependencies; those dependencies must already carry the pilot project and
environment tags. Tagged pilot security-group authority includes revoking
AWS's default egress rule so Terraform can establish the declared outbound
boundary. API Gateway authority names the create collection, child, and
tag-resource paths explicitly. Lambda container-image creation also requires a
repository resource policy: only the Lambda service may pull, only from the
pilot account, and only for pilot-prefixed function source ARNs.

Foundation provisioning requires the immutable image for the exact selected
current-main commit to have been published first. The protected workflow proves
that tag exists and supplies the selected commit as `worker_image_sha` before it
creates the saved main plan; it never plans Lambda against the all-zero inert
placeholder.

ECS task definitions are immutable. Image promotion therefore appears as a
Terraform `delete,create` replacement even though AWS registers a new revision
before deregistering the prior revision. Foundation, deploy, and rollback gates
allow that exact action pair only for the worker and migration task-definition
addresses. Standalone deletes, every other replacement, and unrelated runtime
deployment changes remain fail-closed.

If task-definition registration succeeds but its immediate provider read fails,
verify exactly one active task definition for the expected family and inspect
the state for a single matching taint. Do not accept replacement. Untaint only
that verified address after an explicit human checkpoint, then regenerate the
main plan.

This repository change costs nothing until applied. S3 state, ECR
storage/scanning, public IPv4 usage, Secrets Manager containers, CloudWatch,
and notifications can incur charges after creation. AWS Budgets may also have
service-specific pricing. There is intentionally no NAT Gateway.

The state bucket has `prevent_destroy`, versioning, encryption, and public
access blocking. Do not bypass those protections to recover from an error.
Investigate lock ownership before deleting a `.tflock` object. Destroying pilot
resources or bootstrap requires its own reviewed plan; no automated destroy
path is provided.
