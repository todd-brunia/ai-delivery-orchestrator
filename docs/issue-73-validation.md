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

The portal's `.github/workflows/implementation.yml` currently validates dispatch
inputs only. It has no correlation `run-name`, does not create a branch/PR, and
its workflow-runs endpoint returned no runs. #72 being closed therefore does not
supply the prerequisite live fixture evidence. Changing that target workflow
is a separate operational scope decision. Local synthetic observations do not
prove this live checkpoint.

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
