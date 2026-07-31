# ADR 0001: Establish a minimal TypeScript worker foundation

## Status

Accepted for repository bootstrap.

## Decision

Use Node.js 22, strict TypeScript, ESLint, Vitest, a non-root multi-stage Docker
image, and GitHub Actions CI as the initial implementation foundation.

Keep the bootstrap worker deliberately provider-neutral. Add LangGraph,
PostgreSQL, AWS, GitHub, and OpenAI dependencies only with the bounded feature
that first uses each dependency.

## Consequences

- The repository has a reproducible build and validation contract immediately.
- Security and lifecycle behavior can be tested before cloud provisioning.
- Future architecture decisions remain reviewable rather than being embedded
  in a large bootstrap commit.
