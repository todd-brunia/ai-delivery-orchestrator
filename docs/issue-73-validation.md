# Issue #73: completion and validation

Work is kept on `issue-73-complete-callbacks`. Open one draft PR after the
implementation and agreed acceptance evidence are complete. #74 remains outside
this change. Do not close #73 on the strength of unit tests or an image build.

## Local acceptance

The integration harness uses real migrations, PostgreSQL inbox/leases, the
canonical GitHub HTTP adapter, callback resolver, policy, atomic transitions,
correlations, outbox, and result publication. HTTP responses and signing keys are
generated test fixtures; no GitHub, OpenAI, or AWS request is sent by this suite.

Use a disposable PostgreSQL database. The integration tests truncate their test
tables with CASCADE. Never point `DATABASE_URL` at the pilot or a database whose
contents must be retained. The development session uses the separate local
database `orchestrator_issue73_tests` on port 54329.

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run test:compiled
npm run test:integration
npm run docker:build
npm audit --audit-level=high
gitleaks git --redact --no-banner .
node --test scripts/callback-progress.test.mjs
git diff --check
```

`test/integration/callback-processing.test.ts` covers delayed PR catch-up,
different deliveries for the same semantic observation, a crash after commit,
outbox rollback, competing consumers, pause during canonical reads, provider
redaction, retry exhaustion, installation blocking, plan/head/workflow/check
drift, incomplete checks, old-head checks, disabled event families, issue-comment
wakes, and projection retry. Unit tests cover expired deadlines and envelope
configuration/fingerprint mismatches. Test the built image with networking
disabled as well as compiling TypeScript.

## Runtime boundaries

Callbacks remain disabled unless `CALLBACK_PROCESSING_ENABLED=true` is explicitly
set. `CALLBACK_EVENT_FAMILIES` is an explicit comma-separated support allowlist.
Unknown values fail validation. Installation events are always retained as
authority invalidations once callback processing is enabled.

There are two runtime modes using the same image:

| Mode | Existing task role and network | Work |
| --- | --- | --- |
| `ingress` | Worker role, private worker subnets/security group | SQS to PostgreSQL inbox; sanitized PostgreSQL results to DynamoDB operator events |
| `processor` | Supervised-dispatch role, supervised network/security group | Read canonical GitHub state and commit callback decisions in PostgreSQL |

The ingress process never constructs a GitHub reader or loads an App key. The
processor never constructs SQS or DynamoDB clients. Neither constructs a model
provider or a GitHub mutation executor. PostgreSQL retains the reviewed RDS TLS
certificate and peer verification.

The current worker task has no injected database credentials. Ingress therefore
accepts the exact existing RDS-managed `DATABASE_SECRET_ARN` and loads its
username/password through the worker task role's existing database-secret read
permission. The processor uses the supervised task's existing PGUSER/PGPASSWORD
injection. No execution-role secret permission expansion is required by this path.

`CALLBACK_RUN_ONCE` defaults to `true`. A bounded processor invocation must also
provide `CALLBACK_DELIVERY_IDS` as exact comma-separated delivery UUIDs. Each
batch claims at most ten deliveries, one at a time. Disabled families and
non-selected deliveries remain in the inbox. Persistent mode is an explicit
operator choice, not the supervised-test default. SIGTERM/SIGINT stop new claims;
an expired lease or drain prevents committing a late canonical read.

SQS acknowledgement proves durable inbox acceptance, not state advancement. A
failed inbox write leaves the SQS message unacknowledged; a crash after acceptance
is handled by delivery ID plus payload fingerprint. Inbox processing has its own
bounded retries and durable dead-letter notification. Existing SQS/DLQ alarms
remain relevant to ingress. PostgreSQL dead-letter notifications also require
operator inspection; they are not automatically replayed.

Results appear in the existing `/v1/runs/{runId}/events` projection with the
canonical observation time, committed revision/state, check status/fingerprint,
and review-facts fingerprint. Failed publication retains `projected_at = NULL`
and leaves related projection outbox work incomplete for retry. Notifications
in `github_callback_notifications` request plan authorization or reconciliation;
they do not authorize dispatch, run #74 scheduling, or start a review.

## Canonical target contract

The implementation workflow's canonical `display_title` must be the exact
dispatch correlation marker. A compatible workflow can expose this through:

```yaml
run-name: ${{ inputs.correlation }}
```

The accepted dispatch receipt, repository ID, immutable default SHA, workflow
path/ID, and attempt are checked as well. Workflow reruns invalidate the binding.
The PR must have exactly one marker in its body, the same base/head repository,
the bound base branch/SHA, and the deterministic branch
`orchestrator/<run UUID>/<work-item UUID>`. A newly observed PR is bound atomically
with its first transition; subsequent head changes require reconciliation.
The marker alone cannot select authority or advance state.

Required check names come from the bound adapter. Missing, duplicate, or
in-progress checks remain pending. All required checks must be successful on the
current head to record a successful check observation. Optional checks cannot
satisfy missing required checks. A stale check callback cannot advance the new
head. Reviews remain observation-only.

GitHub's check endpoints require `checks:read`. The callback token request
explicitly includes that read permission; it cannot grant a permission the App
installation does not already possess. Verify existing installation permission
before enabling the checks family. Do not broaden the App automatically.
See [GitHub check-run API permissions](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)
and [workflow-run observations](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run).

## Verified pilot baseline and remaining live gates

Read-only inspection on 2026-09-12 found the worker service ACTIVE with desired,
running, and pending counts all zero; worker task revision 41 and supervised
task revision 12 remain deployed. The supervised image tag is
`9bb65f7b14830770d925a3702e0669e83f8bc570`, older than the current source.
No deployment, callback enablement, replay, or target-repository mutation was
performed during this implementation.

The split modes provide a supervised execution path. Continuous production
wake/drain and scale-to-zero composition are not provisioned by this change.
The existing autoscaling target alone does not start a supervised processor
when inbox work arrives. That lifecycle wiring remains a #73 acceptance item;
it needs a reviewed deployment design and must not be confused with #74's
scheduled reconciliation. A long-running supervised public-network task is not
authorized by the prior one-off checkpoint.

Portal PR #143 merged on 2026-09-12 at
`7b46cc3478dcbbd4d2157dc1ea44d273750e796f`, following human reapproval of the
marked #142 amendment. Its CI Gate passed. The implementation workflow now has
the exact correlation `run-name`; its six inputs and read-only permissions are
unchanged, and it still does not create a branch/PR. The workflow-runs endpoint
returned zero runs after the merge, so #72 being closed does not supply the
prerequisite live fixture evidence.

Portal #142 was closed immediately after the merge, then reopened with explicit
owner authorization on 2026-09-12. Its `approved-for-build` label remains present.
Refresh canonical issue, approval,
default-SHA and checkpoint evidence before proposing any live dispatch. Portal
#74 is substantive inquiry-persistence work and must not be substituted. Local
synthetic observations do not prove this live checkpoint.

The subsequent read-only App-authenticated installation check confirmed builder
installation `157133323` (App `4744942`) is not suspended and has selected-repository
access, with `issues:write`, `actions:write`, `contents:write`, `metadata:read`, and
`pull_requests:write`. It has **no `checks:read` permission**. The callback runtime
requests that permission, so live callback validation is blocked until the owner
reviews the required authority change. No permission or credential was changed;
the existing key was used in memory for a GET of installation metadata only.
The full canonical preflight and retained database checkpoint verification have
not completed, and this metadata check is not a dispatch-ready result.

The owner subsequently authorized adding only `checks:read`. The tracked builder
ceiling and strict role schema now include that read permission; allowed mutation
operations, repository audience, and all other permissions are unchanged. The
new builder configuration revision is the SHA-256 of compact `JSON.stringify`
of the updated contract, omitting `configurationRevision`. The verifier requests
the new read permission explicitly; the older M3/E1 mutation fixture still
requests only the permissions needed for its original operations.

The GitHub App registration and installation approval require the owner's
authenticated settings session. This code change does not prove that the live
permission has changed. Recheck installation metadata and a narrowed exact-head
checks read after the owner saves and accepts the update. Do not reuse a prior
planning binding across this permission change or enable callbacks automatically.

After the owner accepted the installation update on 2026-09-12, App-authenticated
verification confirmed the exact updated permission ceiling and selected portal
repository access. A narrowed read token successfully retrieved six checks on
`7b46cc3478dcbbd4d2157dc1ea44d273750e796f`; its sole `CI Gate` was completed and
successful. This is permission/canonical-read evidence, not callback processing.

The next canonical fixture read failed closed: #142 has both the original marked
plan and the newly posted marked amendment, while `getMarkedPlan` requires exactly
one marked comment. The fixture preparation introduced this mismatch. Preserve
both historical records; obtain owner authorization to consolidate the approved
scope into one current marked plan and explicitly retire the superseded markers,
then obtain fresh human approval after that edit. Do not silently select one
comment, discard inherited constraints, or reuse the previous plan digest.

The owner authorized consolidation, and exactly one active marked plan now
remains: comment `5646729081`. The two earlier comments retain their prose with
superseded markers. Fresh human approval was recorded at
`2026-09-12T15:11:51Z`. Subsequent canonical reads succeeded: issue #142 is open,
the plan digest is
`e4bc9e3ebb57834c1426c405d9beb5ff55fa0268e9716bee50b4cd03e8c1f76a`,
the default SHA remains `7b46cc3478dcbbd4d2157dc1ea44d273750e796f`, the
implementation workflow exists at that SHA, the installation matches the updated
ceiling, and its sole `CI Gate` is successful. These are read-only observations,
not the full model-assisted supervised preflight or dispatch authorization.

Next proposed checkpoint: one read-only Fargate database inspection using the
existing supervised task revision 12, existing task/execution roles, secret
references, log group, and supervised network. Override only the command with a
reviewed 45-second diagnostic; retain `SUPERVISED_DISPATCH_ENABLED=false`.
The diagnostic counts #142-bound work items, planning bindings, dispatch attempts,
accepted dispatches, outbox intents, and mutation receipts in a PostgreSQL
read-only transaction, without reading stored evidence bodies. Its SQL was
validated against the isolated local test database. No image publication,
migration, model/GitHub call, callback processing, or service update is included.
Launching that task still requires explicit owner approval. Any nonzero counts
require further inspection before considering a new dispatch; zero counts alone
do not prove all other dispatch prerequisites.

The owner authorized that one-off inspection on 2026-09-12. ECS accepted exactly
one task, ID `284d3f0d07414f7987b449e03b35885d`, using supervised revision 12 and
client token `issue73-fixture142-readonly-20260912-a`. The reviewed command SHA-256
was `e9d7f4b55b769958735ceea3ebeeac0092795bd5ca984cdf821e4a5b6e295816`.
The existing service was not updated. The log stream is
`supervised-dispatch/supervised-dispatch/284d3f0d07414f7987b449e03b35885d`
in `/ai-delivery-orchestrator/pilot/worker`. Provisioning is not evidence of a
successful database inspection; record the terminal result before proceeding.

That task stopped with exit code 1. Its only application record was
`{"event":"fixture_database_inspection","status":"unavailable"}`; no counts
were returned. The observed deployed image digest was
`sha256:a9c7df43f38d99d591525f33a9fdcec59fd0862f2322298e6ed07f5ff1d4b7ba`.
The cause is not established because the command omitted stage diagnostics.
Do not infer missing records, a successful connection, or dispatch eligibility.
A revised diagnostic is prepared with closed stage/error categories and checks
for the exact required table names; another launch needs fresh owner approval.
No automatic retry, callback claim, migration, or service change was performed.

After fresh owner authorization, the revised read-only diagnostic ran as task
`b41c05317e424131976c50356a4f23a1` using the same task revision, roles, network,
and image digest. Command SHA-256:
`2199c2f2412d77d797ac3a6bae1bed58959f862c032d96d54d44e88fe4f78b81`.
It exited 0 and recorded `status: observed`, `issue: 142`, and zero for all six
counts: work items, planning bindings, dispatch attempts, accepted dispatches,
outbox intents, and mutation receipts. `dispatchAuthorized` remained false.
The log stream suffix is that exact task ID. This clears the inspected retained
record gate, not full dispatch eligibility; the first failure remains unexplained.
The next distinct checkpoint is the existing disabled supervised preflight,
which includes an OpenAI feasibility request. That model-assisted task requires
separate owner authorization and must not use execute mode or dispatch work.

The owner authorized one disabled model-assisted preflight. Task
`54fcfb876ff1496d9745eb4de6d95209` used supervised revision 12 with explicit
`SUPERVISED_DISPATCH_ENABLED=false`, `mode: preflight`, issue 142, and a
180-second process deadline. It stopped with exit code 1 before model analysis:
`canonical_read / invalid_input / repository_configuration / allow_squash_merge / missing`.
No dispatch occurred. The deployed image predates the already-merged #270 fix
(`953eadb`) that removed that field from the supervised read contract. Image
freshness should have been checked before this preflight attempt.

Read-only ECR inspection found the already-published main image for commit
`102af4d2c5a48e04710a43144dabe2a6f3cccf9a`, digest
`sha256:ed04a955ea0e495938cad1f63d472bc7de0ba808cf51c7f249d1edf11fe7ac7d`.
Proposed next checkpoint, pending owner approval: register a candidate copy of
supervised revision 12 changing only the image to that immutable digest, preserve
all roles, secrets, resource limits, logs and network, and run one disabled
preflight with the same issue and 180-second deadline. Do not update a service,
apply migrations, publish another image/PR, enable callbacks, or dispatch.
This published main image does not yet include the feature-branch #73 processor.

With owner approval, candidate supervised revision 13 was registered using that
digest. Configurable fields match revision 12 except the image; ECS additionally
reported the generated `docker-remote-api.1.21` capability. No service was updated.
One disabled preflight ran as `b80ab09c1e09426c90c1bbcefe1ad63b`, using a
180-second deadline. It stopped with exit code 1 at `model_analysis / invalid_response`,
after passing the earlier repository-read failure. No execute-mode work or callback
processing was enabled.

Offline reproduction identified a definite pre-existing OpenAI adapter defect:
it sends raw HTTP but requires top-level `output_text`, an SDK convenience field.
A synthetic completed REST response with valid structured text in
`output[].content[]` is rejected with `invalid_response`. Existing unit fixtures
use the same incorrect top-level shape, hiding this failure. The live diagnostic
does not establish whether this was its only cause; raw model output was not
retrieved or logged. See the official
[text-generation response format](https://developers.openai.com/api/docs/guides/text).
The owner approved this prerequisite repair locally. The adapter now extracts
assistant text from completed REST `output` messages, ignores reasoning metadata,
and retains model matching and structured-result validation. Refusals, incomplete
responses, unexpected tool/content types, invalid JSON/schema results, and oversized
response bodies fail closed without retrying or exposing provider text. Configured
models, request permissions, and the transient-error retry policy are unchanged.

Local repair validation: lint, typecheck, build, and Docker build passed; 228 unit
tests and six observer-script tests passed; all 43 PostgreSQL integration tests
passed against the existing local test container (the sandboxed attempt could not
connect, so the suite was rerun with local-network access). Compiled startup and
diagnostic checks passed, including a new offline REST-envelope adapter fixture.
The adapter suite contains 19 tests, including realistic feasibility/review
responses and rejection cases. No live model request or AWS task was started for
this repair. These synthetic tests prove the parser correction, not successful
live preflight or completion of #73.

The repair remains on the existing #73 feature branch. The next live checkpoint
requires an owner-authorized immutable candidate image containing this code,
a candidate task revision retaining existing authority, and explicit approval
for one bounded disabled-preflight retry. Revision 13 does not contain this fix.

The owner authorized that checkpoint. Commit
`aee45719333607ed8a1d260cf07ab1924507224d` was built for Linux AMD64 and published
under the immutable ECR tag `issue73-aee45719333607ed8a1d260cf07ab1924507224d`,
digest `sha256:5ba5a39b86c195737445b02469c8431b3bc94ae4a35fe546362273c3c3df686e`.
Supervised task revision 14 was registered and its configurable fields compared
equal to revision 13 except for that image. A local CLI input-method failure
occurred before registration; correcting it did not consume a live invocation.

One disabled preflight for portal issue 142 ran as
`b5ae9e234a9444378f415acf6858c6ba`, with the existing roles/network and 180-second
deadline. ECS confirmed the expected image digest. It started at
2026-09-12T15:39:23.494Z and stopped at 15:40:00.995Z with exit code 1. Its sanitized
diagnostic was `model_analysis / unexpected`. No preflight-ready result was
observed and no retry was launched. The worker service remained at desired,
running, and pending counts zero. No migrations, callback enablement, execute-mode
dispatch, service update, or additional PR was performed.

Read-only local inspection found that `validateFeasibilityForRun` throws generic
errors for infeasible results, unresolved decisions, missing conflict coverage,
and out-of-scope dependencies. A synthetic schema-valid result with empty
conflicts reproduced the same `model_analysis / unexpected` diagnostic. This is
diagnostic ambiguity, not proof of the live cause: artifact drift and other
pre-request failures can also surface in that stage. Raw model output was not
retrieved or logged. The next local step is narrowly scoped, allowlisted
diagnostics distinguishing artifact acquisition, response handling, and feasibility
validation without weakening those checks; another live attempt needs separate
authorization after that evidence is reviewed.

With owner approval, local diagnostics now distinguish `model_artifact` acquisition
from provider `model_analysis` and post-response `feasibility_validation`.
Existing narrower canonical-read and secret-access attribution is preserved.
Feasibility validation emits category `feasibility_rejected` with one allowlisted
`feasibilityReason`: `infeasible`, `unresolved_decisions`, `invalid_issue_scope`,
`conflict_coverage`, or `dependency_scope`. Schema failures remain `invalid_input`;
unrecognized exceptions remain `unexpected`. No provider body, model rationale,
decision text, artifact contents, or arbitrary exception message is included.
The diagnostic schema rejects unknown reasons and reason/stage mismatches.
These are additions to the diagnostic contract; observers must use the matching
candidate schema rather than the revision-14 schema.

The checks and authorization policy are unchanged. Offline operator regression
coverage proves a missing-conflict rejection occurs before persistence, workflow
execution, or dispatch. Compiled regression coverage exercises the same typed
domain-to-runtime error boundary. This work does not identify the prior live
failure retrospectively, publish another image, or authorize a cloud retry.

Local diagnostic validation passed: lint, typecheck, 239 unit tests, six observer
tests, 43 PostgreSQL integration tests, build, compiled checks, Docker build,
and whitespace validation. No AWS resource or live model API was accessed during
this diagnostic implementation.

## Following the supervised test in the AWS console

Select account `025540956479` and region **US East (N. Virginia)** (`us-east-1`).
Before any live launch, record the approved candidate digest and exact task ARNs
here or in the acceptance evidence. Existing tasks and queue traffic are not
automatically evidence of this candidate.

- [ECS tasks](https://us-east-1.console.aws.amazon.com/ecs/v2/clusters/ai-delivery-orchestrator-pilot-worker/tasks?region=us-east-1):
  select the announced task ID. Watch its status and inspect the container's image
  digest and exit code. Include stopped tasks after a bounded invocation exits.
  The worker service can remain at desired count zero while a one-off task runs.
- From that task's **Logs** tab, open its CloudWatch log stream. Use the announced
  test time window and task ID. Processor `callback_batch` records show sanitized
  dispositions; ingress `callback_ingress_retry` indicates failed acceptance.
  An absent batch log does not prove success. Do not post raw log exports publicly.
- [SQS](https://us-east-1.console.aws.amazon.com/sqs/v3/home?region=us-east-1#/queues):
  select `ai-delivery-orchestrator-pilot-callbacks.fifo` and view **Monitoring**.
  Visible and in-flight message counts are approximate and metrics may lag. Do
  not use **Poll for messages**, purge, or redrive to observe this test: those
  actions affect delivery. An empty queue proves neither a transition nor a
  successful projection; compare exact delivery results in operator run events.

A read-only CLI snapshot provides the same resource links and optional exact-task
status without retrieving credentials, message bodies, or log contents:

```sh
node scripts/callback-progress.mjs
# After a task is announced, pass its exact ARN (up to three):
node scripts/callback-progress.mjs EXACT_TASK_ARN
```

The script uses the existing `ai-orchestrator-pilot` AWS profile, verifies the
account, and only calls STS identity, ECS describe, and SQS attribute reads. It
does not deploy, start/stop tasks, receive messages, or enable callbacks. Run its
offline regression checks with `node --test scripts/callback-progress.test.mjs`.

## Proposed cloud iteration without intermediate PRs

1. Finish local validation and freeze the feature commit. Build and publish an
   immutable candidate image from that commit using owner-authorized credentials.
   Record the ECR digest; keep the existing main-only deployment workflow intact.
2. Prepare copies of the deployed worker and supervised task definitions with
   the candidate image digest and `node dist/index.js` entrypoint. Retain their
   existing task/execution roles, secret references, networks, and log groups.
   Registering these candidate revisions must not update either running service
   or Terraform-managed image selection. Use one-off task ARNs explicitly.
3. Review and authorize the additive database migrations, the exact candidate
   task definitions and environment overrides, and the fixture delivery IDs.
   The GitHub App read-permission prerequisite and target fixture must be
   resolved before live callback processing. No role expansion is part of the
   proposed split-runtime test.
4. Launch bounded ingress, processor, then projection/ingress tasks against the
   exact approved fixture. Record immutable image/task IDs, canonical binding,
   workflow/PR/head/check evidence, domain transitions, inbox completion,
   notification rows, and projected results. Compare to a manual canonical read.
5. Stop on an identity, correlation, redaction, lease, or duplicate-work failure.
   Keep inbox/results/notifications and any accepted external work. Retain the
   prior service task definitions and desired count zero. Do not blindly repeat
   a fixture dispatch or replay a dead-letter delivery.
6. Open the single final PR with local and live evidence, or explicitly agree
   with the owner that the live rollout is a remaining post-merge checkpoint.

The repository's human-controlled deployment/credential/authority rules still
apply. This document prepares a reviewable path; it is not permission to deploy,
change the target repository, enable live callbacks, or retry a consumed live
checkpoint. No scheduled reconciliation, dependency release, repair, review
submission, merge, release, or target application deployment is included.
