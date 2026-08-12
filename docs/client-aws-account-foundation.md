# Client AWS Account Foundation

## Purpose and durability

This guide prepares an authorized client-owned AWS boundary for a distributable
fork of the orchestrator. It records security outcomes and decision points, not
a promise that AWS console labels or page layouts will remain unchanged. Use
the current AWS documentation when the interface differs, and preserve the
verification outcomes below.

This guide does not grant a right to fork or redistribute the repository, apply
infrastructure, or incur charges. Distribution terms and each apply remain
separate human approvals.

## Recommended account boundary

Use an AWS Organization with at least two accounts:

```text
management account (billing and organization administration only)
└── orchestrator workload account (Terraform and runtime resources)
```

Do not deploy the orchestrator into the management account. A separate workload
account isolates permissions and cost, avoids inherited legacy resources, and
makes later handoff or teardown easier to reason about. The management-account
owner remains responsible for member-account charges.

If an existing organization is trustworthy and understood, create a member
account there. Otherwise establish a new management account and organization
before creating the workload account. Do not close old accounts merely because
their credentials are stale: first inventory bills, domains, Marketplace
subscriptions, backups, commitments, organization dependencies, and retained
data.

## 1. Establish durable account ownership

Every AWS account needs a unique root email that can receive account-recovery
messages. Prefer business-controlled distribution addresses. A solo operator
without a domain may temporarily use tested provider-supported sub-addresses
such as `owner+aws-management@example.com` and
`owner+aws-orchestrator@example.com`; document the mapping and migrate to
business-owned addresses when available.

For the management account:

- Choose the paid/pay-as-you-go account plan when it will create an
  organization. Creating or joining an organization changes Free-plan
  eligibility; verify current AWS terms during signup.
- Use Basic Support unless paid support is an intentional purchase.
- Register phishing-resistant root MFA where possible.
- Create no root access keys.
- Verify recovery email, phone, payment method, and billing, operations, and
  security contacts.

Stop and recover the account before continuing if root MFA or recovery contact
verification fails.

## 2. Create the organization and human access

Create an AWS Organization with all features enabled, then enable an
organization instance of IAM Identity Center in the approved home Region. The
pilot uses `us-east-1`; changing the Identity Center Region later is an
architectural operation, not a casual preference.

Using the default Identity Center directory or the client's approved identity
provider:

1. Create a named administrator identity with MFA.
2. Place it in an administrator group.
3. Create an administrative permission set with a short session duration.
4. Assign the group to the management account.
5. Sign in through the AWS access portal and verify an assumed-role session.
6. Sign out of root and reserve it for root-only recovery and account tasks.

Prefer a dual-stack portal endpoint unless the client's network requires the
IPv4 endpoint. Save the portal URL in the organization's credential manager;
it is configuration, not a password.

Verification checkpoint:

- Non-root portal authentication requires MFA.
- The management account opens through an Identity Center role.
- No root or IAM-user access key is used.

## 3. Create and assign the workload account

From AWS Organizations, create—not invite—a member account with a unique,
recoverable root email and a descriptive name such as
`ai-delivery-orchestrator-pilot`. Retain the default organization access role
unless client policy requires another reviewed name. Add organization metadata
for project, environment, and ownership when supported.

After the account becomes active, assign the administrator group and permission
set to it through IAM Identity Center. Verify through the access portal that:

- The workload account ID matches the privately recorded account inventory.
- The session is an Identity Center role, not root.
- The working Region is `us-east-1`.

Do not create a member-account root password, IAM users, or long-lived access
keys merely to continue provisioning. Evaluate centralized member-account root
access separately under the client's recovery policy.

## 4. Put cost visibility in place first

Before Terraform creates resources, create a small recurring cost budget from
the management account. Scope it to the workload account when linked-account
billing data is available. A newly created member may take time to appear as a
billing dimension; until then, an unfiltered organization-wide budget provides
a useful safety net and also detects accidental management-account usage.

Configure monitored email notifications for meaningful actual and forecasted
thresholds. Do not attach automatic budget actions unless a separate policy
defines their operational and recovery consequences. Budgets and billing data
can lag usage, so alerts are not hard spending caps.

The Terraform project budget is tag-filtered and complements—rather than
replaces—the initial account-wide budget. Activate the project's cost-allocation
tag before relying on that narrower budget.

## 5. Configure temporary CLI access

Install a current AWS CLI v2 from an official AWS distribution. Configure an
IAM Identity Center profile; do not run legacy access-key configuration.

```bash
aws configure sso --profile CLIENT_ORCHESTRATOR_PROFILE
aws sso login --profile CLIENT_ORCHESTRATOR_PROFILE
aws sts get-caller-identity --profile CLIENT_ORCHESTRATOR_PROFILE
```

Use the saved access portal URL, its Identity Center Region, the workload
account, the approved permission set, and `us-east-1` as the default service
Region. Privately verify the returned account ID and an Identity Center role
ARN before every bootstrap or recovery operation. Never paste credentials,
tokens, account inventories, or complete identity output into issues or logs.

## 6. Hand off to repository bootstrap

Continue with [Terraform and AWS bootstrap](./terraform-bootstrap.md) only
after the preceding checkpoints pass. The stable authority boundary is:

1. A human administrator checks for an existing GitHub OIDC provider and
   selects a globally unique, non-identifying state-bucket name.
2. Terraform produces a saved bootstrap plan for the workload account.
3. A human reviews the exact create/change/destroy summary and explicitly
   approves that saved plan.
4. The one-time bootstrap creates protected state and narrowly trusted GitHub
   plan/apply roles.
5. The ignored local bootstrap state is preserved until a separately reviewed
   state-migration procedure exists.
6. Normal workload planning and provisioning moves to protected GitHub
   workflows with short-lived OIDC credentials.

Do not substitute a workstation apply for the protected pilot workflow after
bootstrap. Do not create a second GitHub OIDC provider when the account already
has one; safely import or adopt shared account-level infrastructure instead.

## Client handoff record

Record these items in the client's approved password manager or infrastructure
inventory, not in repository content:

- Account names, IDs, root-email ownership, and recovery contacts
- Organization and Identity Center ownership and home Region
- Access portal URL, administrator groups, permission sets, and session limits
- Budget owner, scope, thresholds, and notification recipients
- CLI profile convention and access-review date
- Bootstrap state custody, state-bucket name, and GitHub role identifiers
- GitHub environment approvers and emergency disablement owner

The handoff is complete only when a second authorized operator can authenticate,
identify the correct account, review a plan, and stop before apply without
undocumented assistance.

## Current AWS references

- [Getting started with an AWS account](https://docs.aws.amazon.com/accounts/latest/reference/getting-started.html)
- [AWS Organizations management-account best practices](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_best-practices_mgmt-acct.html)
- [Creating an organization](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_org_create.html)
- [Creating a member account](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_accounts_create.html)
- [IAM root-user best practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-best-practices.html)
- [Using the IAM Identity Center access portal](https://docs.aws.amazon.com/singlesignon/latest/userguide/using-the-portal.html)
- [Configuring IAM Identity Center for the AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html)
- [Managing costs with AWS Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html)
- [Closing an AWS account](https://docs.aws.amazon.com/accounts/latest/reference/manage-acct-closing.html)

Recheck these sources before a client onboarding or account closure because
service eligibility, billing behavior, endpoint options, and console wording
can change independently of this repository.
