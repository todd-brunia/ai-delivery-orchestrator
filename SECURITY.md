# Security Policy

## Reporting

Do not open a public issue for a suspected vulnerability, credential exposure,
authorization bypass, prompt-injection path, or private-data leak. Contact the
repository owner privately through GitHub and include only the minimum evidence
needed to reproduce the concern. Do not include live secrets.

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
