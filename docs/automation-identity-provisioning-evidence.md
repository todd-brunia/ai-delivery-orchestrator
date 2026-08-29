# Automation Identity Provisioning Evidence

## Scope

This document records sanitized acceptance evidence for issue #59. It contains
only public/non-secret identifiers and canonical GitHub/AWS metadata. Private
keys, JWTs, installation tokens, secret values, and value-derived fingerprints
are deliberately excluded.

Tracked contracts contain role-specific secret container names, never the AWS
account ID or generated ARN suffix. A trusted operator supplies the exact
`AUTOMATION_IDENTITY_SECRET_ARN` only while running verification.

Configuration revision:
`230423a2f2b92e0c607d4989e75942e827a8342de3139e4a8a5c76b671016448`.

## Canonical preflight

On 2026-08-10, canonical GitHub reads confirmed repository ID `1308170964` is
the public `todd-brunia/ai-consulting-client-portal`, with base `main`, strict
`CI Gate`, one independent approval, stale-review dismissal, last-push
approval, resolved conversations, admin enforcement, linear history,
squash-only merging, force-push/deletion prevention, and auto-merge disabled.

[Terraform apply run 31351272293](https://github.com/todd-brunia/ai-delivery-orchestrator/actions/runs/31351272293)
created the empty role-specific secret containers and updated the unattached
runtime IAM policy. Subsequent read-only AWS metadata confirmed separate
reviewer and merger ARNs and value-update timestamps without retrieving either
value.

## Reviewer

- Slug/App ID: `todd-brunia-ai-delivery-reviewer` / `4545788`
- Installation ID/account: `152627422` / `todd-brunia`
- Repository selection: selected; only portal ID `1308170964`
- Canonical permissions: Checks read, Contents read, Metadata read, Pull
  requests write
- Secret container: role-specific reviewer name pinned in tracked configuration
- Attribution proof: disposable client-portal
  [PR #133](https://github.com/todd-brunia/ai-consulting-client-portal/pull/133),
  exact head `cdeac61a0a192f5425ddb9b2d1f2fd4c50aed521`, review ID
  `4902433717`, actor `todd-brunia-ai-delivery-reviewer[bot]`, state
  `COMMENTED`, submitted `2026-08-11T02:11:37Z`
- Canonical close proof: the PR remained draft, had no auto-merge request, was
  blocked from merge, and was closed without merging after evidence capture

Reviewer Pull requests: write is the platform ceiling required to submit the
review. The review neither approved nor merged. Static policy denies source/ref
writes, PR mutation, branch update, review dismissal, settings changes, and
merge.

## Merger

- Slug/App ID: `todd-brunia-ai-delivery-merger` / `4545894`
- Installation ID/account: `152629499` / `todd-brunia`
- Repository selection: selected; only portal ID `1308170964`
- Canonical permissions: Contents write, Metadata read; no Pull requests write
- Secret container: role-specific merger name pinned in tracked configuration
- Non-mutation proof: the trusted diagnostic minted a repository-constrained,
  short-lived installation token and read canonical identity, installation,
  repository, and permission metadata; it accepted no PR number and invoked no
  merge endpoint

Merger Contents: write is a platform ceiling, not application authorization.
Static policy permits only one future exact-head squash-merge request after all
gates and denies build, review, settings, bypass, release, deployment, and
other ref/content writes. No automatic merge path is enabled by issue #59.

## Builder supervised fixture

On 2026-08-28, the human owner approved and GitHub accepted the builder's
repository-scoped Contents write platform permission, required for GitHub's
`markPullRequestReadyForReview` GraphQL mutation. The checked-in builder
contract remains restricted to portal repository ID `1308170964`, with only
Metadata read, Contents write, Issues write, Actions write, and Pull requests
write. Application policy continues to forbid source writes, ref writes,
review, approval, merge, settings, workflow-settings, secret, environment,
deployment, release, organization, and installation-management operations.

The owner-supervised, non-merge fixture used portal
[issue #136](https://github.com/todd-brunia/ai-consulting-client-portal/issues/136)
and [PR #137](https://github.com/todd-brunia/ai-consulting-client-portal/pull/137),
bound to exact head `52db6e3e5cf96dfec0976bff749e1f46b1a2dc40`:

- Label replacement succeeded with GitHub request ID
  `D116:319892:418640:DC9F4D:6A91DAEB`; canonical issue labels contained only
  `m3e1-builder-fixture`.
- Allowlisted workflow dispatch succeeded with request ID
  `55D5:4FB5C:540A87:119F0E5:6A91DCF9`; portal workflow run
  [33202619662](https://github.com/todd-brunia/ai-consulting-client-portal/actions/runs/33202619662)
  completed successfully on its observed `main` SHA.
- Exact-head draft readiness succeeded with request ID
  `3556:D3773:AA57C:235857:6A91E4A9`; canonical reconciliation confirmed PR
  #137 remained open at the same head and changed from draft to ready for
  review. No merge was requested or performed.

The fixture runner is human-supervised, hard-coded to those disposable portal
targets, requires an exact confirmation phrase, refuses shell tracing, mints a
short-lived selected-repository token, and verifies canonical preconditions
before every mutation. It is not a runtime worker or enabled consumer.

## Rotation and revocation drill

On 2026-08-10, the human owner rotated each App independently:

- Reviewer secret version `AWSCURRENT` was updated at `2026-08-11T02:16:06Z`.
  A new installation token was successfully constrained to the expected
  identity, permissions, and portal audience. After the older GitHub key was
  revoked, the diagnostic selected `AWSPREVIOUS` and GitHub rejected its JWT
  with HTTP 401.
- Merger secret version `AWSCURRENT` was updated at `2026-08-11T02:24:13Z`.
  A new installation token was successfully constrained to the expected
  identity, permissions, and portal audience. After the older GitHub key was
  revoked, the diagnostic selected `AWSPREVIOUS` and GitHub rejected its JWT
  with HTTP 401.
- The operator then removed the `AWSPREVIOUS` staging label from each revoked
  version without retrieving or deleting a secret value. Each verified new
  version remains `AWSCURRENT`; short-lived tokens minted before revocation
  were treated as live until their recorded expiry.

Runtime consumers, schedules, queues, workflows, automatic merge, release, and
deployment remain disabled. Emergency response is human-owned: revoke the App
key or suspend/uninstall only the affected App, remove/disable its secret
stage/access, treat issued tokens as live until expiry, audit sanitized App and
repository events, rerun canonical preflight, and restore only through a fresh
human action after contract and installation state match.
