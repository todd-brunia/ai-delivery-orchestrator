# Issue #73: runtime evidence decision

Status: owner approved local design and implementation on September 13, with an
explicit preference for local testing. Implemented locally; not deployed. This
approval does not authorize the later dispatch/migration/callback stop gates.

## Verified reason for this proposal

On September 13, the rejected report
`a413725efe8d9dc548ae893f543c5a5417bc913d3357578aa27e418315f59766`
was reread from its exact stopped task's CloudWatch stream. Its four referenced
segments still match the current plan's full-body hash: P0019 (line 45), P0020
(47–50), P0025 (60), and P0026 (62). These are reviewer questions and future
approval instructions, not independently verified runtime failures. The report
remains model-reported and rejecting; reference integrity does not prove the
findings are correct or that the fixture is eligible now.

The approved fixture plan explicitly calls for runtime identity and emergency
stop checks. The current checkpoint packet has canonical GitHub facts and fresh
receipt counts, but no corresponding runtime observation. Repeating the same
scoped input or adding a prose assertion that the runtime is ready would not
resolve this gap.

## Recommended boundary

Extend the versioned checkpoint evidence contract with a narrowly observed
runtime record. Keep both scoped and full-issue feasibility checks, canonical
approval, exact dispatch authorization, durable idempotency and every later
operational gate. Do not revise prompts merely to make a rejection pass.

The record should prove only facts available inside the current supervised
process: its exact task/image identity, validated execution-disabled command and
configuration, and an installed hard process deadline. Use an injected,
read-only observation port with a production adapter; a caller-supplied JSON
object or repository prose cannot establish these facts. For ECS task identity,
evaluate the task-local metadata endpoint with fixed destination/path validation,
bounded response size and timeout, and strict identity comparison against the
reviewed pilot task scope. Missing or inconsistent observations fail closed.

Do not claim this proves the state of other ECS tasks, the callback Lambda,
EventBridge, queue, lifecycle record or account-wide emergency controls. If those
are required prerequisites for this dispatch-only checkpoint, identify their
exact read authority and observation source separately before adding access.
No new IAM, endpoint, secret, signing service or credential is proposed here.

Bind the runtime record, its schema version and freshness into the model input
and preflight digest. Define explicitly how a subsequent execute task rechecks
the approved runtime constraints without trusting or impersonating the original
task. A task identifier will legitimately change; approved image, scope and
stop-control requirements must not change silently. Resolve this comparison
contract before implementation, rather than weakening an exact snapshot check.

## Required local proof before another live candidate

- Reject unsupported versions, unknown fields, wrong task/image/repository,
  stale/future observations, unavailable metadata and uninstalled deadlines.
- Reject arbitrary metadata URLs, redirects and oversized responses without
  contacting caller-selected destinations or printing response bodies.
- Prove the configured disabled mode cannot reach run creation, dispatch or
  callback claims, even when the model returns a favorable assessment.
- Test the cross-task preflight/execute comparison, image/configuration drift,
  changed stop controls and expired owner authorization.
- Preserve both feasibility gates, rejection reporting, receipt checks and
  the existing rule that consumed attempts require recovery review.

No new live assessment, dispatch, migration, fixture publication or callback
enablement is authorized by this proposal. A richer packet may still be rejected;
it must improve factual evidence, not guarantee a favorable answer.

## Implemented contract and operating boundary

Checkpoint `v2` requires strict `supervised-runtime-evidence/v1`; existing injected
`v1` callers remain compatible, but the production CLI requires the new runtime
observer and will not accept a `v1` execute snapshot. Runtime facts are included
in the existing hashed model artifact and independently in the preflight digest.
The OpenAI Docs review informed keeping evidence separate from code-owned
instructions: neither the full plan nor the assessment instructions/model was
changed. See [official prompt guidance](https://developers.openai.com/api/docs/guides/prompt-engineering).

The CLI installs a 180-second process-exit timer before initialization and keeps
it active through shutdown. Observations fail once it is closed or expired.
This is a process-local timer, not proof of an account-wide emergency stop or
an OS-level watchdog that can preempt a blocked JavaScript event loop. Existing
external candidate watchdogs remain useful and must not be removed on the
strength of this record.

Production identity comes only from the fixed link-local v4 `/task` endpoint,
with a five-second timeout and 64 KiB body limit. Redirects, proxy routing, DNS,
credentials, tag reads and arbitrary destinations are excluded. The adapter
checks the exact pilot cluster/task-definition revision, account, single named
running Fargate container, ECR image URI and manifest digest. AWS's additive
metadata fields are stripped; unknown versioned evidence fields are rejected.
The response is never logged. See [AWS metadata paths](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-metadata-endpoint-v4-fargate.html)
and [response fields](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-metadata-endpoint-v4-response.html).

The protected task must supply `SUPERVISED_RUNTIME_SCOPE_JSON` containing exactly
`clusterArn`, `taskDefinitionArn`, and `imageDigest`, pinned to the reviewed
candidate. ECS supplies `ECS_CONTAINER_METADATA_URI_V4`. The CLI computes its
configuration fingerprint from parsed adapter, GitHub identity, project and
database connection identity—not passwords, keys, arbitrary environment fields
or caller-provided fingerprints. Existing deployed tasks lacking this scope
cannot run the new CLI without a reviewed candidate configuration.

Preflight requires execution disabled. Execute independently observes its own
active task, checks the same constraints and stop policy, and then reuses the
original disabled preflight observation for the approved digest. The original
task may have stopped; it is never represented as the executing task. Fresh
current observations are at most five seconds old; the original snapshot still
expires within five minutes. Identity is reobserved immediately before writes,
and authorization expiry uses the runtime clock, not a caller's old command
timestamp. Changed image, task revision, configuration or stop policy needs a
new preflight and authorization. Neither a new task ID nor a model's favorable
answer renews authorization or clears a consumed receipt.

Local fixtures cover both sides of this handoff, metadata failures/bounds,
deadline loss before commit, expired approval, missing v2 evidence, preserved
input hashing, and disabled preflight with zero persistence/dispatch calls.
These tests do not prove live ECS metadata compatibility or model acceptance.
