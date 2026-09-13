# Issue #73: remaining lifecycle authority decision

Status: owner approved implementation and pilot testing, September 13, 2026,
in the working session. Approval is limited to the inventory and safeguards below;
it does not authorize production deployment or bypass the fixture prerequisites.
Implementation is in progress. On September 13, reviewed additive plans created
three callback roles, five scoped policies, two task definitions, the disabled
controller/schedule/logging resources and the approved DynamoDB egress rule.
Launch authority is pinned to ingress revision 1 and processor revision 1. Two
controller-only updates fixed native runtime packaging and handler resolution;
no resources were deleted or replaced. Coordination smoke tests and a disabled
Lambda invocation pass. Real callback rollout remains gated; see the validation
ledger for exact evidence and remaining work.

## Additional network prerequisite — owner approved

Read-only inspection on September 13 confirmed that private worker security group
`sg-0195296e5bc0ea25c` permits PostgreSQL to the database, HTTPS to the interface
endpoint security group, and HTTPS to the regional S3 prefix list. It does not
permit HTTPS to DynamoDB. The existing DynamoDB gateway endpoint and route alone
do not grant security-group egress. This also prevents the existing private
callback projection writer from reaching its coordination table.

The lifecycle ingress needs DynamoDB for its generation fence and durable wake
signal before SQS acknowledgement. The required additional permission is one
outbound TCP 443 rule from this worker security group to the AWS-managed
`com.amazonaws.us-east-1.dynamodb` prefix list through the existing gateway
endpoint. No ingress, internet route, NAT, endpoint, credential, or IAM action
would be added by that rule. The owner explicitly approved this exact addition
in the working session on September 13, before any AWS mutation.

Local work adds the lifecycle state machine, conditional coordination
adapter, pinned ECS launcher, scheduled handler, runtime fences and wake wiring,
and opt-in Terraform definitions. Application deployment and acceptance testing
are still in progress; the IAM bootstrap alone does not establish callback success.

## Lifecycle implementation notes

- Missing coordination state is disabled and unknown, not empty. Initialization
  seeds unacknowledged work for both modes; owner enablement increments a generation.
- Conditional revisions serialize reservations and wake updates. A slot contains
  the configuration hash, deterministic launch token, captured wake, generation,
  task ARN when known, and a fixed 180-second deadline including startup.
- A known task must be observed `STOPPED` before its slot can be reused. Unknown
  launches retry the identical request only within ten minutes, safely inside
  [ECS's token lifetime](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ECS_Idempotency.html).
  Older ambiguous outcomes remain fenced for operator inspection; they never
  expire directly into a duplicate launch. Five consecutive task crashes exhaust
  automatic retries until an explicit generation-fenced wake.
- Before claims and callback/projection commits, the runtime rereads the durable
  generation and checks its task identity/deadline. Signal failures prevent SQS
  acknowledgement. Empty progress acknowledges only the launch's captured wake.
- Pilot task definitions require lifecycle identity and exact delivery-ID scope.
  The unconfigured scope is the nil UUID, and scheduler enablement additionally
  requires explicit delivery IDs and canonical hook identity. No fixture gate is
  inferred from a successful infrastructure deployment.
- The Lambda scheduler is outside the VPC and disabled by default. The pilot's
  concurrency quota remains unchanged and unreserved; conditional claims, not
  concurrency settings, establish single-task safety.
- Bootstrap sequence: opt into IAM roles without launch ARNs; provision the two
  task definitions and disabled controller using an immutable candidate digest;
  then attach launch authority for those exact revisions. Preserve these explicit
  Terraform inputs on subsequent plans; omitted opt-in values would propose
  deletion and must be rejected. Existing main-only deployment workflows are not
  used to test a feature candidate.

## Verified gap

The pilot has an ECS autoscaling target but no scaling policies or wake rules.
The worker and operator Lambda roles have no ECS launch/service-control actions.
The callback runtime's ingress and processor modes can run as bounded tasks, but
nothing automatically starts them from zero or recovers an interrupted drain.
The user's interactive AWS test credentials do not authorize transferring their
administrator privileges to application code. This is a #73 lifecycle gap,
not #74's periodic canonical reconciliation.

## Proposed bounded-task lifecycle

Preserve private queue ingestion and a separate outbound canonical-GitHub reader.
Use a small scheduled lifecycle controller outside the VPC to observe callback
queue metadata and durable wake/progress signals in the existing coordination
table. It may launch only two pinned callback task definitions in the existing
pilot cluster: ingress and canonical processor. No model or publishing operation
is available to this controller. The processor uses existing reviewed public
subnets/security group; the ingress retains the existing private network path.
No NAT gateway or endpoint removal is proposed. The only additional network
access is the separately approved DynamoDB egress rule described above.

At most one task per mode runs concurrently. Launches use durable conditional
claims and deterministic ECS client tokens, with explicit task deadlines and
recovery after an expired claim. Unknown launch outcomes are reconciled against
the recorded task, never immediately duplicated. Finishing a bounded drain exits
the task; no idle Fargate service is kept alive. Controller ticks with no pending
work perform only bounded metadata reads, not database or model calls.

Ingress must durably record both inbox acceptance and the wake signal before
acknowledging SQS. Processor completion cannot clear a newer wake generation.
Drain/kill/configuration generation is checked before claims and commits; pending
or uncertain evidence remains retained. Missing/stale progress signals must not
be interpreted as proof of an empty inbox. Implementation must test crash points,
concurrent ticks, signal-publication failure, and work arriving during shutdown.
Do not claim this design is implemented or its race handling proven yet.

## Authority requiring explicit owner approval

- A dedicated lifecycle-controller Lambda role: logs to its exact log group;
  callback-queue `sqs:GetQueueAttributes`; scoped coordination-table
  `dynamodb:GetItem`, `PutItem`, and `UpdateItem`; `ecs:RunTask` limited to the two
  reviewed callback task definitions and pilot cluster; `ecs:DescribeTasks`
  limited to that cluster's tasks; and `iam:PassRole` limited to their exact task
  and execution roles, conditioned on `ecs-tasks.amazonaws.com`.
- A dedicated callback processor task role: read only the existing builder App
  key's `AWSCURRENT` version and scoped lifecycle coordination records. No OpenAI
  key, GitHub publishing transport, SQS consumer authority, or other provider key.
  This replaces use of the broader supervised-dispatch role for automatic callbacks.
- A dedicated callback execution role: existing ECR image pull, exact log stream
  writes, and injection of the existing database credential, with exact resources.
  No new secret value or credential is created or modified.
- A scheduled invocation permission restricted to the controller's exact rule.
  All resources belong to the pilot, default disabled, with no production rollout.

Before applying, inspect the exact Terraform plan and stop for any deletion,
replacement, wildcard authority beyond required API semantics, unrelated resource,
new secret, or permission outside the approved inventory. Do not use broad
deployment/admin policies as runtime shortcuts. Approved implementation/testing
would still preserve human-only merges, production deployments, and #74's scope.
