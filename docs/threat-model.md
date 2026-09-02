# Autonomous Delivery Threat Model

## Supervised dispatch authority

Operator input is not an authority source. The supervised command accepts only an allowlisted repository identity, one issue number, bounded correlation evidence, and time. Repository adapter configuration, workflow, ref, provider selection, credentials, App/installation identity, permissions, and operation come from trusted composition plus canonical reads. The preflight digest excludes raw issue/plan text and changing observation timestamps while binding immutable identities and fingerprints. Execution is disabled by default, short-lived, single-item, durably recorded, and restricted to claiming the exact generated outbox row. Reusing an authorization with drift, selecting another repository, or placing instructions in issue/model/webhook content fails closed.

The owner-approved public-subnet exception exposes only ephemeral outbound connectivity. The supervised task has no listening service, load balancer, public ingress rule, schedule, or persistent desired count. Its security group permits TCP 443 internet egress, exact database connectivity, and UDP/TCP 53 only to the `/32` AmazonProvidedDNS address derived from the VPC CIDR. Private DNS routes AWS initialization traffic to interface endpoints whose shared security group accepts TCP 443 from the exact supervised security group, never a CIDR or public source. Public DNS destinations and full-VPC DNS scope remain forbidden because DNS is an exfiltration path. Separate task and execution roles restrict provider secrets to the builder GitHub App and portal-builder OpenAI key and database injection to the RDS-managed secret. Public-IP assignment is authorized only for the named one-off checkpoint; it does not establish a reusable live-worker network policy.

Supervised failures cross a separate versioned diagnostic boundary. Only static stage names and allowlisted categories may leave the process; unknown objects and exceptions collapse to `unexpected`. Raw error messages, causes, stacks, provider responses, request metadata, prompts, canonical artifacts, repository content, database values, and credentials are prohibited because each may contain secrets or attacker-controlled instructions. Nested boundaries retain the narrowest stage, so a secret-access or canonical-read failure is not relabeled as model analysis. These diagnostics improve operator attribution but grant no retry or mutation authority.

## Status and scope

This model covers governed planning, building, independent review, and a future
exact-head automatic-merge path. Automatic merge is **not operational**: the
repository has an immutable authorization domain contract, but reviewer and
merger identities, live adapters, operator controls, and merge execution remain
planned. Control status below is `implemented`, `manual/current`, or `planned`.

Release, production deployment, policy expansion, GitHub App or credential
administration, repository visibility or installation changes, protection
bypass, and cross-repository access always remain human-owner-only.

## Protected assets

- `run-authorization/v1` envelopes and fingerprints, approved-plan digests,
  policy artifacts, and authorizing-human evidence.
- Default-branch, pull-request head, reviewed artifact, check, and review SHAs.
- GitHub App private keys, installation tokens, OpenAI and AWS credentials.
- Repository rulesets, branch protection, allowlists, and kill state.
- Durable transitions, inbox/outbox records, checkpoints, reconciliation
  observations, merge intents, and incident evidence.
- Private repository source and metadata and the authority to build, review,
  merge, release, or deploy.

## Actors and trust boundaries

- The **human owner** is the only principal that can establish or expand
  authority, administer identities and protection, restore after a kill, or
  authorize release and production deployment.
- The **operator** may invoke bounded lifecycle and containment actions but
  cannot manufacture authorization or bypass policy.
- The future **builder**, **reviewer**, and **merger** are separate workload
  identities. Their exact permissions and prohibitions are defined in the
  [authority matrix](./automatic-merge-authority.md).
- GitHub and CI supply canonical state and execution evidence, but issue text,
  comments, webhooks, repository files, diffs, checks, and command output are
  untrusted until authenticated and reconciled.
- Model/provider output proposes content or decisions; it never grants tool or
  publication authority and never receives publisher credentials.
- Webhook ingress, runtime workers, PostgreSQL, the outbox, checkpoint storage,
  and secret storage are separate boundaries. Possession of a platform
  permission does not authorize its use.

Unknown repositories, versions, identities, actions, policy, or unavailable
canonical evidence deny progress.

## Threat and control register

| Threat | Prevention | Detection | Containment | Recovery and re-entry | Evidence | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Compromised builder | `automation-identities/v1` issue-bound scope, no review/merge operation, isolated credential/container | Unexpected refs, actor, repository, permission, or outbox intent | Pause run; kill builder publication; revoke installation token | Rotate/revoke, audit all writes, discard affected output, reconcile, obtain new authorization when a bound value changed | Actor, installation, refs, commits, transitions, outbox IDs | Human owner | contract implemented; runtime planned |
| Compromised reviewer | Independent identity cannot push, repair, or merge; reviews bind exact head and authorization | Review actor/head/policy mismatch | Block work item, kill reviewer authority, revoke credential | Audit reviews, rotate identity, obtain fresh independent review and authorization if evidence changed | Review ID, actor, head SHA, fingerprint, policy digest | Human owner | planned |
| Compromised merger or kill bypass | Merger can request one exact-head squash merge only after live checks; human-only restoration | Any request during kill, wrong head/method/repository, or settings mutation | Repository/global kill, revoke merger installation/credential, preserve state | Verify kill effectiveness, audit attempts and merged state, rotate, reconcile, new authorization, human restore | Kill revision, request/delivery IDs, PR/head/base SHAs, GitHub audit data | Human owner | planned |
| Confused deputy or cross-repository target | Authorization repository plus installation/repository allowlists | Target differs from envelope or runtime allowlist | Deny and kill affected identity if attempted | Confirm no external mutation, correct configuration, new authorization | Fingerprint, canonical target, installation/repository IDs | Human owner | implemented contract; enforcement planned |
| Stale plan, policy, base, review, check, head, or artifact substitution | Immutable digests and exact SHAs; re-read canonical state immediately before action | Any binding or fingerprint drift | Block and cancel pending merge intent | Reconcile; regenerate/review changed artifact; new human authorization for any bound change | Expected/observed hashes and canonical timestamps | Operator | implemented contract; live read planned |
| Dispatch response accepted but target workflow absent or mismatched | Immutable binding, typed intent, durable attempt state, canonical workflow-run verification | Missing/wrong workflow path, SHA, event, or chronology | Keep work item ready; mark attempt ambiguous or blocked | Reconcile canonical runs; never blindly dispatch again | Intent fingerprint, attempt state, workflow-run ID and URI | Operator | persistence and policy boundary implemented; live orchestration planned |
| Forged, replayed, delayed, reordered, or duplicate callback | HMAC before parse, global delivery dedupe, canonical immutable bindings, semantic keys, leases, atomic transition/outbox/result commit | Invalid signature, duplicate delivery, identity/SHA/check drift, lease or revision loss | Reject, block, or dead-letter; pause on contradictory state | Reviewed replay or reconciliation re-fetches canonical state and reuses semantic idempotency | Delivery ID/hash, stable reason, semantic/transition/outbox key; never raw body | Operator | implemented; live claims disabled |
| Duplicate/concurrent merge request or crash-after-request ambiguity | Idempotent intent, exact-head key, lease, canonical preflight | Duplicate key, expired claim, GitHub/application disagreement | Stop retries and mark uncertain | Query canonical PR/merge state before completing or retrying; never blindly replay | Intent/idempotency key, claim, request ID, merge commit | Operator | outbox implemented; merger planned |
| Branch protection or ruleset drift | Expected protection fingerprint and no bypass permission | Canonical protection differs or required check/review disappears | Repository kill; invalidate pending intents | Human repairs settings, audits changes, reconciles exact state, creates new authorization, restores | Before/after rules, actor, time, affected runs | Human owner | planned |
| Credential leak or overbroad platform permission | Secret manager, short-lived tokens, separated jobs, least privilege | Secret scanning, unexpected token use, permission inventory drift | Revoke/disable identity and kill affected authority | Rotate, audit scope and use, reduce permission, reconcile, human restore | Sanitized credential ID/version, audit events, permission diff | Human owner | manual/current; identities planned |
| Compromised dependency/build script reads publisher secret | Builder environment contains no reviewer/merger secrets; generation separated from publication | Egress/secret-access anomaly, unexpected process/output | Stop build and publication; revoke exposed identity | Replace dependency/image, rotate, rebuild from reviewed base, re-review | Lock/image digest, workflow run, sanitized detection | Human owner | separation policy implemented; runtime planned |
| Audit/history deletion or unsafe recovery | Append-only transitions, immutable migrations/authorization, retained evidence | Missing sequence, checksum conflict, update/delete failure | Kill and preserve surviving storage | Restore from verified backup; reconcile; never edit history/checkpoints/outbox to force progress | Checksums, backup/restore record, sequence gaps | Human owner | partial |
| GitHub, provider, database, or canonical-read outage | Required evidence must be available; no fail-open fallback | Timeout/unavailable result | Pause progression and do not emit/retry merge blindly | Restore service, reconcile all uncertain work, then explicitly resume | Outage window, attempts, claims, reconciliation report | Operator | policy implemented; live controls planned |
| Prompt injection or untrusted-content authority expansion | Strict schemas, allowlisted actions, publisher isolation | Unknown fields/actions, policy denial, attempted secret/tool request | Reject content; pause repeated attempts | Inspect sanitized decision evidence, correct plan/input, reauthorize if scope changes | Policy reason, content hash, transition; no raw reasoning | Operator | implemented domain boundary |

## Recovery invariants

1. Pause is resumable, cancellation is terminal for its target, and kill removes
   automatic publication/merge authority until human restoration.
2. Recovery begins with authoritative read and reconciliation. It never deletes
   or edits transitions, outbox/inbox rows, authorization, audit evidence, or
   checkpoints to manufacture success.
3. A merge with an uncertain response is queried by repository, PR, exact head,
   and idempotency evidence before any retry.
4. Identity compromise, protection drift, authorization mismatch, or evidence
   integrity failure requires human-owner restoration. Any changed bound value
   requires a new immutable authorization.
5. Incident records contain sanitized identifiers, hashes, times, and decisions,
   never credentials, source dumps, raw webhook bodies, prompts, responses, or
   model reasoning.

See the [automatic-merge recovery runbook](./operating-runbook.md#automatic-merge-containment-and-recovery)
for entry triggers, steps, completion conditions, and prohibited shortcuts.

## Enablement prerequisites and residual risk

Before automatic merge can be enabled, separately reviewed issues must deliver
and test live canonical reads; independent reviewer and merger Apps; exact-head
review/check/protection enforcement; bounded operator pause, drain, cancel,
kill, and reconciliation controls; credential revocation; alarms; audit
retention; and crash-after-request recovery. Scenario exercises must cover all
register rows. Even then GitHub control-plane compromise, malicious human-owner
action, zero-day dependency compromise, and incomplete provider evidence remain
residual risks and require human incident response.

Installing on another owner's repository or operating a multi-client hosted
service requires a new threat review and explicit cross-tenant isolation policy.
