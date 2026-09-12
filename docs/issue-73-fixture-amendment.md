# Proposed portal #142 amendment for orchestrator #73

This is a local proposal, not an approved portal planning record or live-action
authorization. The portal's `implement-approved-issue` skill requires the marked
amendment to be recorded and approved before tracked portal edits. Do not apply
approval labels on the owner's behalf.

## Outcome

Extend the dedicated disposable portal fixture #142 to supply exact workflow,
pull-request, head, and required-check observations for orchestrator #73. Do not
implement portal #74 or orchestrator #74.

## Proposed bounded change

1. Add `run-name: ${{ inputs.correlation }}` to the existing
   `.github/workflows/implementation.yml`. Keep its six-input contract and
   `contents: read` permission unchanged. Update its regression test and workflow
   documentation. Do not turn this evidence-only workflow into a source-writing
   agent or add a model, token, secret, or write permission.
2. Validate the portal's lint, typecheck, unit tests, build, and workflow-specific
   tests on a non-reserved local branch. This workflow change needs human merge
   before a fresh #72 dispatch: the orchestrator binds the immutable default SHA,
   so running a modified workflow on another ref is not equivalent evidence.
   One final orchestrator implementation PR remains the target; a separate portal
   prerequisite PR cannot be represented as a commit in that repository's PR.
3. Refresh the fixture's issue/plan/approval/default/configuration binding only
   after the portal prerequisite is merged. Inspect retained #72 checkpoint and
   receipt state before proposing any dispatch; do not assume #142 remains unused
   and do not replay a consumed dispatch.
4. After separate exact live authorization, establish one disposable draft PR
   with one static evidence-document change, the deterministic branch
   `orchestrator/<run-id>/<work-item-id>`, the bound base, and exactly one binding
   marker in its body. Use the reviewed existing publishing path; do not give
   publishing credentials to the callback processor or expand App permissions.
   This is a test artifact, not another orchestrator implementation increment.
   Freeze its head after first observation and let the repository's ordinary CI
   produce genuine check evidence; never fabricate a successful required check.
5. Observe only the authorized event families and exact delivery IDs using the
   bounded candidate tasks. Retain canonical workflow, PR, head, checks, inbox,
   transitions, and projection evidence. Review observations do not submit a
   review or authorize the next delivery stage.

## Separate gates that this amendment does not approve

- Publishing the amended planning record and human reapproval under portal rules.
- Publishing/merging the prerequisite portal workflow PR.
- New/retried supervised dispatch or creation of the disposable branch/draft PR.
- AWS candidate publishing/deployment, additive pilot migrations, callback
  enablement, redrive, or permanent wake/drain/scale-to-zero wiring.
- Changes to App/IAM/network/credential authority. In particular, verify existing
  `checks:read` installation permission before checks-family testing; its absence
  is a blocker, not permission to add it.

No application behavior, database schema, UI, production deployment, automated
repair, review submission, merge, release, or cleanup deletion is included.
Preserve evidence on failure; report the exact failed gate without silently
switching the fixture issue, actor, default ref, workflow, or credentials.
