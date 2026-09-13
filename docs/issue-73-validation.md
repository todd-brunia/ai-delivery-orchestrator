# Issue #73: completion and validation

## September 13 resumed validation (latest)

### Execution-handoff regression evidence

The checkpoint-enabled read-only preflight now checks the existing full-issue
assessment as well as scoped checkpoint readiness, applies both existing
approval checks, and binds the additional input fingerprint into its digest.
Tests prove full-issue infeasibility, unresolved decisions, provider failure or
input-artifact drift prevents execute before any run/authorization/workflow
write. The live workflow's independent gate remains in place. This is a local
readiness safeguard, not a resolution of the last live model rejection or
permission to dispatch.

Validation for this guard: all 22 targeted supervised/workflow tests, full unit
suite and seven observer tests, lint, typecheck, build, Docker build, compiled
fixtures, offline Lambda container invocation and `git diff --check` passed.
PostgreSQL integration and live AWS checks were not rerun for this application
guard; the prior lifecycle checkpoint results below remain historical evidence.

Local tests now exercise the actual live binding workflow with accepted,
infeasible, unresolved-decision and unavailable full-issue assessments. All three
failure cases preserve the discovered work-item state/revision and produce no
work-item transition or GitHub mutation. The workflow independently requests
full-issue feasibility from the canonically collected plan fingerprint; the
scoped supervised preflight does not replace this assessment.

Crucially, the workflow persists a planning binding **before** that assessment.
A later rejection is therefore a consumed execution attempt, not a read-only
preflight. The existing supervised operator test's successful stubbed workflow
does not prove this live handoff. Do not attempt a live execute merely because
the narrower preflight becomes ready: validate this independent gate and its
recovery implications first. No assessment policy, runtime authorization, AWS
resource or live fixture was changed by this regression work.

### Approved lifecycle implementation and first pilot checks

Checkpoint outcome: both bounded ECS coordination probes exited 0, and the
corrected live controller invocation returned HTTP 200 with no function error
and `{"status":"disabled"}`. No running tasks remain and the schedule is disabled.
This proves packaging and the tested coordination paths, not automatic callback
processing or completion of #73.

The owner explicitly approved the scoped lifecycle inventory and, subsequently,
one private-worker TCP 443 egress rule to the existing DynamoDB gateway prefix
list. Commit `571b940` implements the conditional lifecycle, bounded ingress and
processor fences, exact launch configuration, dedicated roles and disabled
schedule. Image tag `issue73-571b940` has digest
`sha256:0678e126caddabee0d078d63c0f065bc1692e27d8e4fbf8d3c6d4f673f9ba008`.

Reviewed Terraform applies added seven IAM resources, eight pilot resources,
and then one exact-revision launch policy. All three plans had zero changes or
deletions to existing resources. The ingress and processor task definitions are
both revision 1. Launch authority names only these revisions, the existing pilot
cluster, and their exact worker/processor/execution roles. The processor has no
OpenAI secret or SQS consumer permission. The controller has no provider or
database permission. The new egress rule is `sgr-01652d147a7829941`, from
`sg-0195296e5bc0ea25c` to DynamoDB prefix list `pl-02cd2c6b` on TCP 443.

The lifecycle coordination record is initialized **disabled and draining** with
configuration fingerprint
`3c5c75800ed8a63e2f92f371ec6c797bae50d6ea0168465f913ce37066822bc7`.
No wake has authorized real callback processing. Manual diagnostic command
overrides exercised only coordination reads/conditional writes, without SQS
claims, database connections or provider calls:

- Private ingress task `2d8d2242755b4dc6892f966c613efc76` logged
  `callback_coordination_smoke/passed`, stopped at 13:03:55 UTC, exit 0.
- Processor task `3b75a63ecebe4769ab0fe4ae27cc8aff` logged the same passing result,
  including an expected denial outside the lifecycle partition, and stopped at
  13:03:55 UTC, exit 0.
- Worker service desired/running/pending counts remained zero. The one-minute
  EventBridge rule remains disabled. No endpoint, NAT, secret, quota, database
  migration or fixture mutation was added by these checks.
- The disabled Lambda invocation exposed a packaging defect: RIC 4.0.2's
  `rapid-client.node` was absent because the Docker image suppressed install
  scripts. Invocation `e55c1581-d6a5-4912-b814-20861254c765` failed during native
  runtime initialization, before the application handler. The fix builds only
  the reviewed AWS runtime's addon in an isolated build stage; its compilers do
  not enter the final image. A loopback-only, credential-free Runtime API fixture
  now successfully exercises the actual native runtime and disabled handler
  locally, with external networking disabled; the same test is wired into CI.
  A second live invocation exposed relative handler resolution under Lambda's
  default task root. An absolute `/app/dist/...` handler path fixes this, and the
  offline fixture now deliberately uses `/var/task` as its task root.

The controller-only packaging correction uses commit `c3a0abb`, image tag
`issue73-c3a0abb`, digest
`sha256:56268e399a0d1d7e62f1ff6df3cdc6bf578f93532bb8722a2efbc6d7577777ad`.
Two reviewed controller-only in-place updates corrected the image and handler
path, with no replacements or permission changes. ECS task revisions remain 1
on the original lifecycle image, preserving the exact launch policy. The final
Lambda smoke succeeded; its disabled branch sends no queue, database or provider
request. The lifecycle record still has unacknowledged initial work; it has not
been marked empty by these smoke probes.

At the lifecycle checkpoint, lint/typecheck/unit/build/compiled/Docker checks,
45 local PostgreSQL tests, production dependency audit (zero vulnerabilities),
Terraform validation/formatting and history secret scan passed. A successful
image build did **not** detect the missing native runtime; the additional
container invocation check and corrected live disabled Lambda smoke now pass.
This is not accepted callback rollout evidence. The #72 issue-bound fixture and
named staged callback gates remain outstanding; #74 stays out of scope.

Remaining critical path: resolve the supervised #72 checkpoint's rejected
assessment and validate its execute handoff; obtain a real accepted issue-bound
dispatch; run the separately gated migrations and staged workflow/PR/check/review
callback fixture; prove automatic wake, crash recovery and return to zero under
that workload; then finish acceptance review and open the single draft PR. Do
not interpret the current smoke results as satisfying those gates.

Console evidence in us-east-1: ECS pilot-worker cluster's stopped tasks; worker
log group streams `callback-ingress/worker/<task-id>` and
`callback-processor/worker/<task-id>`; Lambda function and EventBridge rule
`ai-delivery-orchestrator-pilot-callback-controller`; its dedicated log group
`/ai-delivery-orchestrator/pilot/callback-controller`.

### Diagnostic continuation

Commit `ddf1e8d` adds local, fixed-category response attribution. Only reasons
recorded by the adapter in a private WeakMap can reach the strict diagnostic;
exception properties, provider messages, JSON text, and reasoning are excluded.
Incomplete output limits, other incomplete responses, refusals, envelope/JSON/
schema failures, and evidence-normalization failures remain rejecting. Actual
`TimeoutError` exceptions now use the existing bounded timeout retry budget
instead of being misclassified as invalid responses. No model, effort, token
limit, authorization, or feasibility rule changed.

Published tag `issue73-ddf1e8d`, digest
`sha256:315d6d1950f48dfaa15f9ef4f640eda3d4d5db9ee03c466cfb9ba2493582cc56`,
supervised revision 20. Task `9e8e7cf0c01c48879e9037ae37a6f6ba` ran with dispatch
disabled, unchanged roles/network and a 180-second hard deadline. It stopped at
12:18:57 UTC with exit 1, after a valid structured assessment was rejected as
`infeasible`. Two unresolved categories remained: checkpoint_consumption and
runtime_readiness, referencing plan segments P0019/P0020/P0025/P0026. The report
hash is `a413725efe8d9dc548ae893f543c5a5417bc913d3357578aa27e418315f59766`;
actual input hash is
`eb117a8929d78d04e7b27a85aae7000085590ca90d60b512368eb4402ee7f468`.
This result does not reconstruct revision 19's discarded response or establish
that its failure was a timeout. No unchanged-candidate retry is planned.

Local unit, type/lint/build, compiled diagnostic/redaction and Docker checks
passed, as did all 44 PostgreSQL integration tests. The lifecycle IAM proposal
still awaits explicit owner approval; automated goal continuation is not approval.
No fixture dispatch, callback processing, migration, or IAM change occurred.
Reference: [Responses API fields](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).

### Earlier September 13 attempts

The owner authorized independently progressing toward one final PR and running
AWS tests with their refreshed credentials. IAM/credential expansion and human-only
actions remain gated. No callback enablement, fixture publication, migration,
workflow dispatch, or runtime IAM modification has occurred in this resumed work.

- Published commit `bb5a4f7` as ECR tag `issue73-bb5a4f7`, digest
  `sha256:eaf59d05f5d507d8dd4d648c895c0d33731ab10f2bdde88e90494d4bff7abadd`,
  supervised task revision 18, with unchanged roles/network and execution disabled.
- Preflight task `5c284ad5e5f743fc9ca4cbd329ed64fe` failed at the database stage.
  A subsequent 45-second read-only diagnostic task
  `f684c04dcd0548b790585455c3c7b886` exited 0 and confirmed all six issue-142
  record-family counts were zero. This is consistent with cold Aurora connection
  timeout, not proof that the original cause was captured. Commit `cb504f3`
  raises connection establishment to 45 seconds; SQL limits remain unchanged.
- Warm revision-18 retry `4f58dae114b8482982c178f575e4181b` reached model assessment
  and failed with `unresolved_decisions`: acceptance_evidence,
  checkpoint_consumption, fixture_publishing_path, operational_authorization.
  Report SHA `9841fb2dc1315c7a8372d9b36481196665b2410db680c34e3d8299190fbcb80b`;
  actual input SHA `dd38d101e457db01e566b5bad067e7ce1ccb867245e2660d0b59ce894e410984`.
  No rejection was bypassed. Referenced plan segments were read against the same
  canonical marked plan and their concerns remain model-reported, not verified facts.
- Commit `dfad594` explicitly defines the checkpoint assessment in static
  application instructions and hashes that policy into the artifact. Legacy
  full-issue analysis remains unchanged. Published ECR tag `issue73-dfad594`,
  digest `sha256:8fb7c428f092a0ccb439c968cd26540638fad7d560e43694ba81a0fd090700e8`,
  supervised revision 19. Task `ef3ab464ebf04e3bb1941eb332957874` failed closed
  at `model_analysis/invalid_response`. Its safe diagnostic does not distinguish
  provider-envelope, JSON/schema, or evidence-normalization failure. Do not guess
  the cause, increase permissions, or repeatedly invoke an unchanged candidate.
- Local checks passed: lint, typecheck, 301 unit tests plus 6 observer tests,
  build, compiled fixtures, Docker build, 44 PostgreSQL integration tests,
  `npm audit --audit-level=high` (zero vulnerabilities), and diff whitespace checks.

Current remaining gates: improve safe invalid-response attribution before another
model invocation; validate the scoped-assessment/execute workflow handoff (which
still performs its independent full-issue feasibility review); obtain real accepted
dispatch evidence; staged fixture/callback evidence; and automatic lifecycle wiring.
No final PR or completion claim is justified yet. The verified lifecycle authority
gap and proposed least-privilege remedy are in
`issue-73-lifecycle-authority-proposal.md`. The existing autoscaling target has no
scaling policy, no named wake rules were found, and runtime roles lack ECS controls.

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

The owner subsequently authorized publication and one disabled preflight for
commit `642c78a5b89aed61770c69db483e34b1f912c517`. Its immutable image digest is
`sha256:aaaf419d3c566114df7baf0e2d48b2c4a68a53cfa3f7e29d3f3b85c18d195968`.
Supervised revision 15 was verified equal to revision 14 in configurable fields
except its image. Task `31f611d3943645d29bf105eb4508210f` ran with the existing
roles/network, dispatch disabled, and a 180-second execution deadline. ECS
confirmed the image digest, start at 2026-09-12T15:47:12.101Z, and stop at
15:47:56.879Z with exit code 1. The diagnostic was
`canonical_read / transport / default_branch_ref`, before model analysis.
This attempt therefore did not exercise the new feasibility diagnostic live.

No live preflight retry was launched. A subsequent local read-only canonical
check succeeded: installation permissions unchanged, portal issue 142 open,
plan comment `5646729081` and its recorded fingerprint unchanged, default branch
`7b46cc3478dcbbd4d2157dc1ea44d273750e796f`, required CI Gate successful. This
establishes local GitHub reachability, not the cause or recovery of the ECS
transport failure. No model call was part of that local check. The worker service
remained at desired/running/pending zero; no dispatch, migrations, callback
enablement, service update, or new PR was performed. Another live invocation
requires owner authorization; revision 15 can be reused without another image
publication if its exact evidence and scope are rechecked.

The owner authorized one retry on existing revision 15. Pre-launch read-only
checks confirmed unchanged fixture plan, default SHA, installation permissions,
and required-check success; the task definition and ECR digest were reverified.
No image was rebuilt/published and no task revision was registered. Task
`d8bfed83e5ec48f2bae1262e3f1bb759` ran with dispatch disabled and the same
180-second execution deadline, starting at 2026-09-12T15:50:04.341Z and stopping
at 15:50:42.150Z with exit code 1. The expected image digest was observed.

The diagnostic was `feasibility_validation / feasibility_rejected`, reason
`unresolved_decisions`. This proves this invocation passed canonical acquisition
and provider response/schema validation, then stopped at the domain feasibility
gate. It does not establish the specific decision text, which was not retrieved
or logged. No further invocation, dispatch, callback enablement, migration,
service update, or PR was performed. Worker service counts remained zero.

Read-only inspection found a concrete model-input gap: `CanonicalGitHubArtifactSource`
includes the issue body and marked-plan metadata (comment ID, hash, timestamp),
but not the marked plan text. Portal #142's consolidated plan contains scope and
completed-prerequisite details absent from its original issue body. The missing
plan content may contribute to unresolved decisions, but this is not established
as the live cause. Proposed next local work: include bounded, exact hash-verified
canonical plan text as untrusted model input, with drift/redaction regression
coverage and unchanged feasibility/authorization gates. Review that change
before any further live model attempt; do not retry the same input blindly or
treat future operational approvals as already granted.

The owner approved the local plan-content repair. A separate
`MarkedPlanContentPort.getMarkedPlanContent` now returns the exact marked-comment
body and metadata from one canonical read. Existing `getMarkedPlan` callers and
persisted binding contracts remain metadata-only. Missing/ambiguous plans and
incomplete comment reads still fail closed; plan text over 100,000 UTF-8 bytes is
rejected, never truncated. The artifact builder independently verifies issue
identity, open state, the requested plan fingerprint, and the SHA-256 of the exact
body before including it. Entire issue bundles are limited to 500,000 UTF-8 bytes.

The plan is included only as untrusted artifact text, not developer instructions
or authority. Model permissions, request settings, feasibility gates, and human
authorization policy are unchanged. Tests cover exact Unicode/line-ending
preservation, metadata isolation, hash drift, missing markers, ambiguous plans,
cross-repository access, per-plan/aggregate bounds, sanitized failures, and
unchanged tool-free/non-stored requests. An offline model-adapter test proves
drift stops before credential loading or transport invocation. Compiled checks
exercise the real reader's exact-body hash and metadata-only boundary. No live
model request, AWS access, image publication, or new PR is part of this repair.
Its effect on the live unresolved-decisions result remains unverified.

Local plan-content validation passed: lint, typecheck, 247 unit tests, six observer
tests, 43 PostgreSQL integration tests, build, compiled checks, Docker build,
and whitespace validation. A future live check requires a newly published
immutable candidate containing this repair and separate authorization for one
bounded disabled preflight; revision 15 does not contain it.

The owner authorized publication and one disabled preflight for commit
`6b370a89a0f6cd14de7b4690aa6b5a9a431b4c38`. The Linux AMD64 candidate was published
as immutable tag `issue73-6b370a89a0f6cd14de7b4690aa6b5a9a431b4c38`, digest
`sha256:4606bdfe6f7862fbbee4916e07da6a943a23ead10bfedd233787e3bce33095be`.
Pre-launch canonical checks confirmed unchanged fixture plan, default SHA,
installation permissions, and required CI success. Supervised revision 16 was
registered and verified equal to revision 15 in configurable fields except image.

Task `5f0fa21b41e1409e9d195f48068356d3` ran with the existing roles/network,
dispatch disabled, and a 180-second execution deadline. ECS confirmed the expected
image digest, start at 2026-09-12T16:00:11.074Z, and stop at 16:00:51.151Z with exit
code 1. The result remained `feasibility_validation / feasibility_rejected`, reason
`unresolved_decisions`, now after successful acquisition of hash-verified plan
content and model-response/schema validation. This demonstrates that adding plan
text alone did not clear the gate. It does not reveal which decisions were
reported or prove that they are the same as in the previous invocation.

No retry, dispatch, migration, callback enablement, service update, or new PR was
performed. Worker service desired/running/pending counts remained zero. Raw model
output and decision text were not retrieved or logged. Before another live model
attempt, review how to produce bounded, operator-visible decision evidence without
logging raw model reasoning, private source, credentials, or provider bodies.
Do not suppress unresolved decisions, assume they are merely future authorization
gates, or repeatedly invoke the model hoping for an approving result.

With owner authorization, the local design for a bounded operator report is in
[issue-73-decision-report-design.md](issue-73-decision-report-design.md).
It proposes fixed decision codes/templates, manifest-validated source references,
runtime-computed provenance, and unchanged rejection/authorization behavior.
It is not implemented and cannot reconstruct prior decision text. This turn
changed documentation only: whitespace validation passed; runtime tests were not
rerun. No live model/AWS call, image publication, or PR was performed.

The owner then authorized local implementation. The supervised CLI now explicitly
uses `supervised-analysis/v2`, leaving legacy feasibility/review wire contracts
unchanged. Exact input text is indexed by bounded paragraph IDs; response decisions
are restricted to nine fixed categories and references from that manifest. A
runtime envelope carries actual input provenance, which replaces model-written
artifact hashes on this supervised path. The report rechecks canonical binding,
uses fixed prompts, and emits no model-written rationale, decision prose, source
text, or URLs. Unknown/malformed output, a missing envelope, report failure, or
remaining decisions still stops progress without a legacy fallback or model retry.

`scripts/review-supervised-decision.mjs` provides local, read-only hash verification
and source line-range lookup using existing GitHub access. It is not in the task
image, prints no source text, and rejects edited evidence. Reports require no new
storage, API, permissions, or service wiring. Issue reads now reject oversized
bodies rather than silently truncate evidence. The design document contains exact
bounds, usage, compatibility notes, and the official Structured Outputs reference.

Implementation validation passed: lint, typecheck, 270 unit tests, six observer
tests, 43 PostgreSQL integration tests, build, compiled diagnostic/report/review
checks, Docker build, and whitespace validation. Synthetic tests cover safe report
serialization, provenance spoofing, injection text, schema/evidence bounds,
refusals/incomplete output, hash drift, unchanged domain gates, and zero
persistence/dispatch calls on report rejection or sink failure. No live model/AWS
access, image publication, or PR occurred during this implementation. Revision 16
does not contain this code. A newly published immutable candidate and one bounded
disabled preflight require separate owner authorization; this implementation
cannot recover prior decision text or establish #73's live acceptance.

The owner authorized publication and one disabled preflight for commit
`af8ab3a5442d4b4ef00485fd03df969dcb7f799c`. Immutable image digest:
`sha256:ae61c94781fcee65aa78d70c56294dc661157f9603b2a1f1e7c23287547edea7`.
Supervised revision 17 was registered and verified equal to revision 16 in
configurable fields except image. Pre-launch reads confirmed unchanged fixture
plan/default SHA/permissions and required CI success. Task
`df149cc33543476ea00ec5d88f41e35a` used the existing roles/network, dispatch disabled,
and a 180-second execution deadline. ECS confirmed the image, start at
2026-09-12T16:19:09.417Z, and stop at 16:19:52.100Z with exit code 1.

The new report was emitted successfully. Its integrity hash is
`b4f79c7a99285b398ea273d1eecfbf64d75e6ef4fed2fe30e200a0be2c20ef48`;
the runtime-computed input artifact hash is
`1c109408df670b4a8af6e09be77b9ff132705ce4ce89e65a06af6b274c3f0518`.
It contained five model-reported categories: acceptance evidence, checkpoint
consumption, dependency readiness, fixture publishing path, and operational
authorization. The terminal diagnostic was `feasibility_validation /
feasibility_rejected / infeasible`. Do not treat this as the same result as the
previous invocation's unresolved-decisions rejection or as an authoritative
finding that all five prerequisites are absent.

The local read-only review helper verified all eight referenced plan segments
against the report's exact body hash. Several references identify headings or
future stop gates rather than detailed supporting evidence. The report exposes
questions for review, not proof of missing approval. No raw model prose or source
was printed by the helper. No additional preflight was launched. Worker service
desired/running/pending remained zero; no dispatch, migration, callback enablement,
service update, or PR occurred.

### Resolution packet before another live attempt

| Reported concern | Established evidence and remaining action |
| --- | --- |
| Acceptance evidence | The plan defines separate dispatch and callback checkpoints. Make the evaluated checkpoint explicit; do not imply later callback acceptance has occurred. |
| Checkpoint consumption | The earlier approved DB inspection observed zero retained records across six tables. It is historical, not a permanent eligibility guarantee; revalidate before dispatch and bind the observation to the checkpoint. |
| Dependency readiness | Fresh canonical reads confirm the current approved plan/default SHA and successful required CI. The model input contains issue/plan content, not a complete independently verified operational-evidence packet. |
| Fixture publishing path | The owner selected the existing local operator GitHub identity for the later exact disposable branch/PR. Keep the runtime source/ref mutation prohibition unchanged. Approval for the exact branch, content, and PR is still required before creation; route selection is not that approval. |
| Operational authorization | Current approval covers this disabled preflight only. Dispatch, fixture publication, migrations, and callback enablement remain distinct future gates; do not mark them granted. |

Do not retry unchanged input or suppress model rejection. Review the publishing
route choice and the design of a checkpoint-scoped, independently verified
operational-evidence packet before another model invocation. Do not insert stale
facts or conversational approval into trusted runtime evidence without an explicit
binding/validation contract. #73 live acceptance remains incomplete.

The owner approved the local-operator publishing route after reviewing revision
17's report. No branch/PR creation, credential change, permission expansion, or
live retry is authorized by that choice. The proposed next local implementation
is specified in [issue-73-checkpoint-evidence-design.md](issue-73-checkpoint-evidence-design.md).
This follow-up changed documentation only; whitespace validation passed and
runtime checks were not rerun. No AWS or GitHub API access was performed; the
documentation was committed/pushed on the existing #73 branch only.

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
