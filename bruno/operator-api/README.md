# Operator API Bruno collection

Select the placeholder `pilot` environment and replace `baseUrl` and `runId`
locally. Requests use AWS SigV4 (`execute-api`, `us-east-1`) and read temporary
credentials from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and
`AWS_SESSION_TOKEN`. Never commit resolved endpoints, account IDs, credentials,
run data, or response bodies. Mutation idempotency keys are examples and must be
changed deliberately for a new command.

The run-events request includes `callback-result/v1` records after callback
projection publication. Inspect disposition, reasonClass, canonicalObservedAt,
committed revision/state, and checksStatus. `projectionAsOf` is evidence freshness,
not permission to continue automation. Pending/dead-letter requests and unpublished
results can be inspected with the bounded SQL diagnostics in the operating runbook;
the collection does not automatically replay them.
