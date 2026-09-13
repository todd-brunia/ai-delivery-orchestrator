# Issue #73: runtime evidence decision

Status: proposal for owner review; not implementation or live-test authorization.

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
