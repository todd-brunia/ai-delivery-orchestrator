# Contributing

This repository uses autonomous, feature-level implementation with human review
at the pull-request boundary. A feature request authorizes Codex to investigate,
implement, validate, create a non-default branch, commit, push it, and create
or update the linked GitHub issue and draft pull request. Do not push directly
to `main`.

Keep each change focused on the requested outcome. Use an issue when it is
useful for tracking and handoff, rather than as an approval gate for every
tracked-file change. Preserve unrelated pre-existing work and report blocked or
skipped validation truthfully.

Pull requests must describe:

- The outcome and originating issue.
- Important security and authority changes.
- Tests and validation performed.
- Infrastructure, migration, and cost impact.
- Known limitations and rollback behavior.

Never include credentials, private keys, access tokens, live account identifiers,
private repository contents, raw webhook payloads, or model reasoning in issues,
commits, logs, fixtures, or pull requests.

Report security concerns privately according to [SECURITY.md](./SECURITY.md).

Only a human may approve or merge a pull request, delete a remote branch,
rewrite published history, change repository settings or visibility, publish a
release, deploy production infrastructure, create or modify credentials, or
broaden GitHub/AWS authority.
