# Issue #73: checkpoint evidence packet

Status: implemented locally following the owner's approval, with local unit and
PostgreSQL validation. Not deployed and not authorization for a live invocation.
See `issue-73-pause-handoff.md` before resuming.

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

- Checkpoint identifier `implementation_dispatch_observation`,
  `assessmentMode: preflight`, and `assessmentExecutionEnabled: false` describing
  the original read-only assessment. The outer runtime result separately records
  its actual execution flag; these descriptive fields never authorize execution.
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
candidate or proposing another bounded live test. This implementation does not approve
AWS execution, database writes/migrations, dispatch, fixture publication, or #74.

## Implemented freshness and handoff

The CLI opts into this packet; legacy injected callers retain their previous
contract. The runtime acquires canonical facts, human approval events, and a
repeatable-read, read-only PostgreSQL snapshot. Connection establishment is bounded
to 45 seconds to accommodate Aurora auto-resume; statements remain bounded to
ten seconds. Only exact repository/issue lineage counts leave the reader;
schema, access, partial-read, and parsing failures cannot become zero counts.

Evidence expires five minutes after acquisition, with receipt age also bounded
to five minutes. Time comes from the runtime clock, not the command timestamp.
Validation runs before model access and again after feasibility/approval checks.
The full plan remains in the model artifact and the packet changes its input hash.

Execute commands must carry the returned `checkpointEvidence` snapshot when this
feature is enabled. Execute independently rereads canonical facts, approval, and
receipt counts, compares them with the snapshot, and reuses original timestamps
only while fresh. This keeps the approved input digest reproducible without
trusting a caller's old observation. Any changed binding, approval, nonzero count,
or expiration blocks; a consumed checkpoint requires recovery review, not an
automatic replay of its old execute command. Existing authorization and exact
durable outbox claims remain mandatory. A clear count is not a transaction lock
or a cross-authorization exactly-once guarantee.

## Explicit assessment instructions

The September 13 live assessment reached the model with the packet but still
returned four unresolved categories. The previous developer message specified
only JSON formatting and distrust of repository instructions, not the checkpoint
being assessed. `supervised-checkpoint-assessment/v1` now defines the staged
assessment in a static code-owned developer message. Repository prose cannot
select it: only the validated checkpoint argument activates it. The policy
version and instructions SHA-256 are included in the hashed artifact, so a prompt
change invalidates old input/preflight digests. Legacy full-issue analysis is
unchanged. A real prerequisite from a later stage must still block the current
checkpoint; no result or decision is deleted, overridden, or coerced to feasible.

This follows [official prompt guidance](https://developers.openai.com/api/docs/guides/prompt-engineering)
on explicit application instructions, code-managed prompt versions and fixtures.
The tests verify instruction selection, input provenance, untrusted-text isolation,
and rejection preservation; they do not establish live model quality or authorize
execution. The execute workflow's subsequent full-issue assessment remains a
separate integration gate; a scoped assessment must not silently replace it.

## Read-only execution-readiness guard

Checkpoint-enabled preflight now also invokes the existing full-issue analysis
port after the scoped assessment passes. Both results must pass the unchanged
domain feasibility and human-approval policies before preflight can be ready.
The full-issue input artifact fingerprint joins the preflight digest, so a
different full-issue input invalidates the owner's earlier authorization. Packet
freshness is checked again after both assessments. Legacy callers without a
checkpoint packet retain their previous preflight behavior.

This adds an assessment call, not an authorization route or a replacement
assessment. The live workflow still performs its own independent full-issue
check. A later rejection can still consume an execution attempt and require
recovery review; preflight cannot guarantee a future model result or freeze
external state. The new guard catches currently observable full-issue rejection
before run, authorization or planning-binding writes. No live calls were made
to validate this change, and the last live scoped rejection remains unresolved.
