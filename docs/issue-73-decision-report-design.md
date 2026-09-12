# Issue #73: supervised feasibility decision report

Status: implemented locally with owner authorization; not approved for live execution.

## Problem and boundary

Revision 16 rejected portal fixture #142 with `unresolved_decisions` after reading
the exact verified plan and validating the model response. The existing
`FeasibilityResultSchema` contains free-text decision strings. The runtime emits
only the rejection category, so it cannot show what needs human attention.
The prior decision text was not retained for operator review. This proposal
cannot reconstruct it, and a future invocation could return different decisions.

Do not put those strings, a model-generated summary, or a regex-redacted copy in
CloudWatch. Length limits and credential matching cannot guarantee removal of
private source or injected instructions. Do not add a second model call to
summarize or classify a failed response.

## Proposed operator experience

For a future approved preflight, show a bounded report in the existing task's
Logs view. The report contains only validated codes, canonical binding metadata,
and fixed-template text. It is a diagnostic report, not a ready result or an
authorization record. Example, entirely synthetic:

```text
Preflight blocked — human review required
Decision 1: fixture publishing path
Review: identify the existing authorized source/ref publishing path.
Evidence: approved plan, segment P0005
Authority: model-reported question; not independently established
Execution enabled: false
```

The actual source text stays out of logs. An operator can inspect the referenced
section in the bound GitHub comment using existing repository access. A local,
read-only renderer can retrieve it on demand, verify the exact body hash, and
identify the segment; it must not silently use an edited comment. Viewing source
uses existing GitHub access, not a new public endpoint or uploaded artifact.

## Bounded contract

Introduce an explicit `supervised-analysis/v2` wire contract and a separate
`supervised-decision-report/v1` diagnostic event. Do not silently change the
shared `providers/v1` unresolved-decision string contract used by other workflows.
Enable the new wire contract only for the supervised candidate. Old callers keep
their existing contract; absent/unknown versions fail closed, with no model retry
or fallback that declares a result ready.

The new supervised wire result retains the existing feasibility fields, but
represents each unresolved decision as a strict object with only:

- `code`: one of the categories below.
- `evidenceIds`: zero to four identifiers from the input evidence manifest.

Allow at most 16 decisions. Overflow, malformed objects, arbitrary extra keys,
and evidence identifiers outside the supplied manifest reject the response;
never truncate a list to empty or drop an invalid decision. `unclassified` is a
valid conservative category, but still an unresolved decision. Do not expose
model-generated titles, explanations, URLs, paths, quotations, or recommendations.

| Code | Fixed human-review prompt |
| --- | --- |
| `scope_boundary` | Clarify the intended change and explicit exclusions. |
| `acceptance_evidence` | Specify the evidence needed to accept this checkpoint. |
| `dependency_readiness` | Verify the prerequisite and its completion evidence. |
| `fixture_publishing_path` | Identify the existing authorized source/ref publishing path. |
| `checkpoint_consumption` | Verify retained receipts before authorizing another dispatch. |
| `operational_authorization` | Identify the separate operational approval being requested. |
| `runtime_readiness` | Verify the exact runtime, migration, or callback prerequisites. |
| `conflicting_evidence` | Reconcile conflicting issue and plan statements. |
| `unclassified` | Review the bound issue and plan; this report cannot identify the decision precisely. |

These are model-reported categories, not facts. In particular,
`operational_authorization` does not mean a permission change is needed, and is
never automatically removed merely because execution is currently disabled.
The templates are review prompts, not executable remediation instructions.

## Evidence and provenance

Construct the evidence manifest deterministically from the exact issue and plan
text already acquired for the artifact. Assign bounded ordinal IDs to paragraphs
without modifying the original body or its hash. Include issue/plan provenance
and segment IDs in the untrusted input. The report includes only the validated
IDs, not headings or text selected by the model. If a document exceeds the
manifest's documented segment limit, stop rather than silently omit evidence.

Compute report provenance in trusted runtime code: repository/issue identity,
plan comment ID and body hash, default SHA, exact serialized input-artifact hash,
candidate identity where available, and observation time. Do not use model-written
`provenance.artifactSha256` as proof of the supplied input. The implementation
must carry the actual input hash alongside the parsed result through an explicit
internal envelope. Do not expose arbitrary model evidence URIs.

Give each report a deterministic hash of its canonical safe payload. Sort and
deduplicate category/evidence pairs for display only; retain a nonzero unresolved
count and preserve rejection semantics. Duplicate log ingestion must not cause
any dispatch or state transition.

## Integration and unchanged gates

The provider validates the supervised wire response, then a pure adapter creates
the safe report and normalizes nonempty decision objects to fixed category strings
for the existing domain feasibility validator. This retains the nonempty-list
rejection without storing or emitting raw decision text. It must not alter
feasible status, risk assessment, conflict coverage, or dependency scope.

The supervised runtime emits the safe report before returning its ordinary
feasibility rejection. Validation still runs, and the task still fails. Reporting
failure must never enable continuation; fall back to the existing static failure
diagnostic without serializing the failed report or exception.

No new database rows, operator API routes, S3 buckets, credentials, permissions,
or service wiring are required for this initial diagnostic. The current operator
API is run-oriented, while disabled preflight deliberately creates no durable
run. Adding an API-backed report store would be a separate reviewed design.
Existing CloudWatch retention and access remain unchanged. Do not copy reports
automatically into public issues or PR comments.

## Local acceptance tests before a cloud proposal

- Synthetic end-to-end Responses fixtures produce exact safe codes and templates,
  preserve a failed feasibility result, and make zero persistence/dispatch calls.
- Prompt-injection text, credentials, private source, reasoning metadata, arbitrary
  paths/URLs, and free-text summaries cannot appear in serialized reports/errors.
- Invalid versions, unknown codes, extra fields, fabricated evidence IDs, excessive
  counts/bytes, malformed JSON, refusal, and incomplete output fail closed without
  a retry. A valid `unclassified` report remains blocked.
- Unicode/line endings, segment determinism, missing evidence, and plan edits are
  covered. A renderer rejects hash drift and never prints source to task logs.
- Spoofed model provenance does not replace the runtime-computed input hash.
- Legacy feasibility callers retain their existing behavior. New reports do not
  become dispatch authorizations or bypass the immutable preflight binding.
- Run repository-required lint, typecheck, tests, build, Docker build, compiled
  diagnostic checks, and local PostgreSQL integration tests after implementation.

## Implemented operator usage and limits

The supervised CLI explicitly opts into the new provider method. Other callers
retain their legacy feasibility/review schemas. The model envelope is revalidated
against the current canonical repository, issue, plan comment/hash, and default
SHA before reporting. The normalized result also uses the actual input hash, so
the existing preflight digest no longer relies on a model-written artifact hash
on this new path. No other feasibility fields or authorization gates are changed.

Each document is limited to 100,000 UTF-8 bytes and 256 nonblank paragraphs; the
serialized input including the manifest is limited to 500,000 UTF-8 bytes.
Issue reads now reject oversized bodies instead of silently truncating them;
this conservative bound applies to existing canonical issue readers as well.
Blank lines delimit paragraphs; CRLF, LF, and CR line endings are counted without
changing the bytes used for hashing. IDs are `I0001`/`P0001` onward for the single
supervised issue. Reports contain at most 16 decisions, four references per
decision, 64 referenced ranges, and 32,768 UTF-8 bytes. Empty documents have no
segments. Empty references are allowed but provide no source location.

The task emits `supervised_decision_report` JSON only for a nonempty unresolved
list, followed by the existing failure diagnostic. A missing/invalid envelope
or reporting failure stops the task; there is no legacy fallback or decision
suppression. Task identity is available from the ECS task/log stream, not from
model output. The report hash provides deterministic integrity, not a signature
or evidence that the model's assertions are true.

After an authorized live test, save only the report JSON (not a raw log export)
to an operator-controlled local file and inspect one reference:

```sh
npm run build
node scripts/review-supervised-decision.mjs /path/to/report.json P0002
```

This helper makes one fixed GitHub GET using existing `gh` authentication,
rechecks the original body hash and line ranges, and prints only the canonical
GitHub URL and verified line range. It never prints the source text. Errors are
static; edited/missing documents fail closed. Do not commit report files or use
the helper to post anything publicly. Tests inject the GET reader and make no
live calls. The helper is local-only and is not copied into the runtime image.

The implementation follows the strict, required-field schema requirements in
the official [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs).
Schema tests check these properties; runtime validation additionally checks
evidence membership and canonical provenance. Existing models and tool-free,
non-stored request settings remain unchanged.

## Handoff

Do not infer the unresolved decisions from the last task, remove any approval
boundary, or edit the fixture to seek a favorable model result. This report can
describe only a new response, not recover the previous decision text. A valid
`unclassified` response remains blocked and may still require direct human
review of the bound source. Image publication and one live preflight require
fresh explicit authorization. Keep the single final orchestrator PR and leave
issue #74 out of scope.
