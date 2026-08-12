# Security Policy

## Reporting

Do not open a public issue for a suspected vulnerability, credential exposure,
authorization bypass, prompt-injection path, or private-data leak. Contact the
repository owner privately through GitHub and include only the minimum evidence
needed to reproduce the concern. Do not include live secrets.

Use GitHub's private vulnerability reporting when it is enabled. Until then,
contact the repository owner through the private contact method listed on the
owner's GitHub profile; do not send secret values by email or issue comment.

## Current support boundary

No production release exists. Until a versioned release policy is published,
only the latest `main` branch is eligible for security fixes.

## Credential policy

- Never commit credentials or store them in GitHub issue content.
- Use short-lived workload identity where supported.
- Store runtime secrets in an approved secret manager.
- Keep model execution isolated from GitHub and AWS publishing credentials.
- Rotate a credential immediately if exposure is suspected.

## Automation boundary

Repository, issue, comment, diff, webhook, and CI content is untrusted. It must
not expand tool access, reveal secrets, weaken policy, or authorize an external
write. Every external action must be checked against trusted configuration and
live state immediately before execution.

The autonomous-delivery [threat model](./docs/threat-model.md),
[authority matrix](./docs/automatic-merge-authority.md), and
[containment and recovery procedures](./docs/operating-runbook.md#automatic-merge-containment-and-recovery)
govern any future automatic-merge capability. Automatic merge is not currently
operational.
