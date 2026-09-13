# Issue #73 pause / restart — September 12, 2026

Historical pause snapshot: work resumed September 13 under the owner's AWS-test
authorization. Read the **September 13 resumed validation** section at the start
of `issue-73-validation.md` for current candidates, results, and remaining gates.

## Stopping point

The approved local checkpoint-evidence implementation is complete on
`issue-73-complete-callbacks`. It has not been published to ECR or deployed.
No additional model invocation, workflow dispatch, portal fixture PR, AWS
migration, or callback enablement was performed during this closing task.
No final orchestrator PR has been opened. Issue #73 remains incomplete; #74
remains out of scope. Preserve the single final orchestrator PR workflow.

Read `issue-73-checkpoint-evidence-design.md` for the packet and five-minute
snapshot handoff. Tests cover strict/fresh approval and receipt evidence,
actual model-input hashing, execution revalidation, consumed-checkpoint rejection,
read-only SQL/error redaction, and all six database record families.

Validation passed: `npm run lint`, `npm run typecheck`, `npm test` (300 unit
tests plus 6 observer tests), `npm run build`, `npm run test:compiled`,
`npm run docker:build`, and all 44 local PostgreSQL integration tests. Docker
needed the existing local daemon permission; no image was pushed to AWS.

## AWS state verified without connecting to Aurora

Account `025540956479`, region `us-east-1`, profile `ai-orchestrator-pilot`:

- ECS cluster/service `ai-delivery-orchestrator-pilot-worker`: desired 0,
  running 0, pending 0. Cluster running-task listing is empty.
- Aurora cluster `ai-delivery-orchestrator-pilot`: minimum 0 ACUs, maximum 2,
  automatic pause after 300 seconds. Latest observed writer capacity samples
  through 16:30 UTC were minimum/maximum 0 ACUs. Administrative cluster status
  `available` does not itself mean serverless compute is consuming ACUs.
- No infrastructure was deleted or reconfigured during this pause preparation.
  Data, logs, images, credentials, and Terraform state are preserved.
- Five interface endpoints remain in `vpc-0784201e26abd2078`, each in two
  subnets: ECR API, ECR Docker, Logs, Secrets Manager, and SQS. These continue
  hourly billing even with no tasks. Stopping compute does not stop those charges.
  Removing them requires a separately reviewed Terraform pause/restore change,
  since the worker's private service connectivity would be unavailable until
  restored. Do not delete them ad hoc or destroy the environment.
- Retained database/storage, logs, images, secrets and any incoming request
  usage can still incur charges. This is a compute-idle pause, not a zero-cost
  teardown or a guarantee against externally triggered traffic.

AWS references: [PrivateLink pricing](https://aws.amazon.com/privatelink/pricing/)
and [Aurora auto-pause](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html).

Console evidence: select **US East (N. Virginia)**. In **ECS → Clusters →
ai-delivery-orchestrator-pilot-worker**, inspect service/task counts. In
**RDS → Databases → ai-delivery-orchestrator-pilot-writer → Monitoring**, inspect
`ServerlessDatabaseCapacity` (use CloudWatch AWS/RDS per-instance metrics if
needed). In **VPC → Endpoints**, filter by the VPC above for remaining endpoints.
Viewing control-plane metrics does not require opening a database connection.

## Resume safely

1. Read this note, the checkpoint design, and `issue-73-validation.md`; check
   branch/worktree and current canonical GitHub/AWS state. Old snapshots,
   approvals, zero-count observations, and preflight digests are not fresh proof.
2. Latest published supervised task definition is revision 17, image digest
   `sha256:ae61c94781fcee65aa78d70c56294dc661157f9603b2a1f1e7c23287547edea7`.
   Last task `df149cc33543476ea00ec5d88f41e35a` stopped with an infeasible result
   and five model-reported concerns. No successful implementation dispatch is
   established. Do not blindly rerun `/private/tmp` launch scripts.
3. Portal fixture is issue 142; marked plan comment `5646729081`, plan hash
   `e4bc9e3ebb57834c1426c405d9beb5ff55fa0268e9716bee50b4cd03e8c1f76a`.
   Human merged portal PR #143; last observed default SHA was
   `7b46cc3478dcbbd4d2157dc1ea44d273750e796f`. Re-read rather than assume unchanged.
4. Review the new local implementation, then obtain approval for an exact
   candidate publication and bounded execution-disabled preflight. A favorable
   model result is not authority for dispatch or acceptance of the whole epic.
5. Remaining staged live work includes evidence-only dispatch observation,
   separately approved disposable fixture publication via the local operator,
   AWS callback migrations/enablement and callback evidence. Migrations 0012/0013
   have only been tested locally. Permanent worker wake/drain/scale-to-zero wiring
   still needs completion and validation within #73. Do not move that to #74.
6. Only after acceptance evidence and final required checks, open the single
   linked orchestrator draft PR for human review/merge.

Local integration database remains disposable Docker PostgreSQL on
`127.0.0.1:54329`, database `orchestrator_issue73_tests`. Integration tests clear
their fixture tables: never point those tests at AWS or a shared database.
