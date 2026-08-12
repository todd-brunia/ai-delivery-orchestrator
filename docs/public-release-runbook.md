# Public Repository Transition Runbook

Repository publication is an explicit owner checkpoint, not an implementation
side effect. The repository remains private and NO-GO until every control below
is evidenced against the exact current `main` commit.

## Pre-publication gates

- Scan full history for secrets, live cloud identifiers, private URLs, personal
  paths, client content, and credentials.
- Review issues, pull requests, comments, attachments, releases, Actions logs,
  caches, and artifacts because historical Actions logs become public.
- Explicitly decide whether to retain or rewrite author email and operational
  identifiers in Git history. Rewriting changes every commit ID and invalidates
  commit-bound evidence, so it requires its own plan and approval.
- Explicitly decide whether to retain or delete Actions runs and artifacts.
  Deletion is irreversible and requires an approved exact inventory.
- Select a license explicitly. Visibility alone does not grant reuse rights.
- Require current identity and permission evidence for builder, reviewer, and
  merger; unavailable or elevated authority is NO-GO.
- Record that public clones and forks cannot be recalled by making the upstream
  private again.

## Visibility checkpoint

The owner changes visibility only after signing a GO record. Do not combine the
visibility mutation with history rewriting, log deletion, AWS apply, deployment,
or credential rotation.

GitHub can disable push rulesets during the transition. Freeze the repository
immediately after publication. Before any merge or infrastructure dispatch:

1. Require pull requests to `main`, strict required checks, an independent
   approval, stale/last-push protections, conversation resolution, linear
   history, and enforcement for administrators.
2. Allow squash merge only; disable merge commits, rebase merge, auto-merge,
   force pushes, and direct updates outside the reviewed path.
3. Restrict Actions to reviewed actions and require full commit SHA references.
4. Require approval for first-time fork contributors; fork pull requests receive
   no write token or repository/environment secrets.
5. Enable secret scanning, push protection, Dependabot, and private
   vulnerability reporting.
6. Restrict the `pilot` environment to `main` and require the named human
   reviewer before its secrets or OIDC authority are exposed.
7. Re-run readiness and credential-free CI against the exact public commit.

## AWS continuation

Only a post-publication GO permits review of a fresh non-destructive Terraform
plan. Publication never authorizes apply, migration, deployment, restore,
cleanup, or backlog launch.
