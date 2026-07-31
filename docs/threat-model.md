# Initial Threat Model

## Protected assets

- GitHub App private keys and installation tokens.
- OpenAI and AWS credentials.
- Private repository source and metadata.
- Workflow policy, approval evidence, and audit history.
- The authority to label issues, dispatch builds, review pull requests, merge,
  release, or deploy.

## Trust boundaries

Trusted inputs are limited to versioned default-branch configuration, verified
human approvals, authenticated operator commands, workload identity, and
policy-controlled secrets. GitHub content, webhook bodies, model output,
repository files, patches, dependencies, and command output remain untrusted.

## Principal threats

1. Prompt injection attempts to obtain credentials or broaden authority.
2. Forged, replayed, duplicated, delayed, or reordered webhooks.
3. Stale approvals or artifact substitution between review and publication.
4. A compromised dependency, build, or repository script reading credentials.
5. Cross-repository targeting or accidental mutation outside an allowlist.
6. Concurrent workers issuing duplicate or contradictory GitHub actions.
7. Logs, traces, fixtures, or errors leaking private content or secrets.
8. Infrastructure credentials or policies granting broader access than needed.

## Required controls

- Verify GitHub webhook HMAC before parsing or enqueueing.
- Deduplicate deliveries and reconcile against canonical GitHub state.
- Bind approvals and reviews to immutable fingerprints and commit SHAs.
- Separate model generation from trusted publishing credentials and jobs.
- Use least-privilege, short-lived identities scoped to allowlisted resources.
- Make external writes idempotent and transactional through an outbox.
- Redact logs and retain structured decisions instead of raw model reasoning.
- Provide pause, drain, kill, retry, reconciliation, and recovery paths.
- Require human approval for sensitive plans, merge, release, and deployment in
  the first release.

This threat model must be revised before enabling automated merge, installing
the GitHub App on additional owners' repositories, or operating a multi-client
hosted service.
