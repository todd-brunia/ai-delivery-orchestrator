# Issue #73: checkpoint evidence packet

Status: local proposal following the owner's publishing-route choice; not
implemented and not authorization for another live invocation.

## Decision already made

The later disposable portal fixture PR will use the existing local operator
GitHub identity, not an expanded runtime mutation role. Before creating it,
present its exact repository, branch/run/work-item binding, base SHA, static
document change, and draft PR body for separate owner approval. No credentials
are transferred to the model or callback processor. This decision selects a
route; it does not establish current credential availability or grant publication.

## Why another input change needs a defined contract

Revision 17 produced five model-reported concerns, but its input still describes
the entire staged issue/plan without a complete operational-evidence packet.
Verified observations and future authorization boundaries must not be conflated.
The model's references include broad headings and are not authoritative findings.
Do not make the model approve by deleting decisions, hiding later work, or
inserting an assertion that everything is ready.

The next evaluated boundary is readiness for the evidence-only implementation
workflow dispatch and its observation, not acceptance of the full callback epic.
The invocation itself remains a disabled preflight. The full plan stays in the
input; the packet explicitly identifies the current checkpoint and lists later
gates. A favorable assessment cannot authorize execution or complete #73.

## Proposed `supervised-checkpoint-evidence/v1`

Use a strict runtime-built packet, passed alongside the supervised analysis
request and included in the exact hashed input artifact. It contains:

- Checkpoint identifier `implementation_dispatch_observation`, actual invocation
  mode, and `executionEnabled: false` for the disabled test path.
- Canonical repository/issue identity, plan ID/hash, default SHA, workflow path,
  adapter/configuration fingerprint, and installation identity/permission digest.
- Fresh attributable plan approval, independently selected using the existing
  human-approval policy, with actor identity, event time, and evidence reference.
  A label alone or prose saying “approved” is not approval evidence.
- Receipt observation status: `not_observed`, `clear_at_observation`, or
  `records_present`, with fixed table/count fields, repository/issue binding,
  actual runtime observation time, and a policy-bounded freshness interval.
  Empty workflow listings and historical notes cannot populate this observation.
- Publishing route `local_operator`, `selection: owner_selected`,
  `capability: not_evaluated`, and `creationAuthorized: false`. The selected route
  is explicit reviewed configuration, not a claim that live capability was checked.
- Future gates, all explicitly `not_authorized`: workflow dispatch, disposable
  fixture publication, AWS migrations, and callback enablement. Do not represent
  these as completed prerequisites or omit them from the full plan.
- Fixed checkpoint acceptance criteria: accepted immutable workflow receipt,
  canonical workflow identity/ref/attempt/correlation, successful evidence-only
  validation, and preserved sanitized records. These are requirements, not results.

No free-text operator assertion can become a verified observation. Unknown
statuses, extra keys, mismatched identities/hashes, future timestamps, stale
observations, or partial reads fail closed. Construction/validation failures
stop before model access. Include packet content in the input hash and therefore
the preflight digest; changing checkpoint or observations invalidates old evidence.

## Observation and authority boundaries

GitHub observations can reuse existing read methods and permissions. Receipt
verification should be an exact repository/issue-scoped read-only database
transaction in the supervised preflight process, using its existing database
access. It must create no run, work item, authorization, or receipt. Define and
test the query's coverage of the six previously inspected record families before
calling it authoritative. Unknown tables/schema/access errors mean unavailable,
not zero. Avoid broad scans, raw rows, payloads, or unfiltered SQL diagnostics.

Receipt clearance is a point-in-time observation, not a concurrency guarantee.
Execute mode still requires fresh canonical evidence and the existing durable,
idempotent authorization/claim checks. Do not move mutation authorization into
the model or replace those checks with a count. Do not reuse the earlier task's
zero counts as fresh data. A failed or consumed checkpoint requires human review.

The configured route records the owner's design choice only. It cannot mint a
token, change App permissions, authorize source/ref writes, or trigger publication.
Do not add a signing service or credential merely to carry this descriptive choice.
The runtime still has no local-operator publishing credential.

## Local implementation and acceptance plan

1. Add pure versioned packet schemas/builders and injected read-only observation
   ports. Preserve legacy analysis contracts and the existing decision report.
2. Build the packet from fresh observations before model invocation; include it
   as structured evidence, never as instructions that override the full plan.
   The model may still report any unresolved decision, including future gates.
3. Revalidate packet/input/binding integrity at preflight handoff. Preserve all
   domain feasibility, approval, execution-disabled, and idempotency checks.
4. Test wrong repository/issue, stale/partial observations, changed plan/default
   SHA, label-only approval, nonzero receipts, future timestamps, unknown status,
   and fabricated operator claims. None may yield a ready or authorized result.
5. Test the DB read against local fixtures for every record family, both clear
   and populated; prove zero writes. Test a concurrent claim is still rejected
   by the existing execute path even if an earlier count was zero.
6. Run all required repository checks, compiled fixtures, and local PostgreSQL
   integration tests. Keep one feature branch and one final orchestrator PR.

Review the concrete implementation and its freshness bound before publishing a
candidate or proposing another bounded live test. This proposal does not approve
AWS execution, database writes/migrations, dispatch, fixture publication, or #74.
