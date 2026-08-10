# Automatic Merge Authority Matrix v1

## Governing rule

This matrix describes maximum application authority, not current capability.
Builder, reviewer, merger, and live operator identities are not yet enabled.
Every action must be supported by the exact repository, issue, plan, policy,
base, and head evidence authorized for the run. Absence, ambiguity, an unknown
value, unavailable canonical evidence, or a kill state denies the action.

GitHub App installation permission is only a technical ceiling. Possessing a
platform permission never creates runtime authority, and unlisted actions are
denied.

| Capability | Builder | Reviewer | Merger | Operator | Human owner |
| --- | --- | --- | --- | --- | --- |
| Read authorized issue, plan, policy, and canonical PR/check state | Allow, issue scope | Allow, review scope | Allow, exact merge preflight only | Allow, allowlisted operations/evidence | Allow |
| Create/update issue-bound branch and PR | Allow through governed publisher | Deny | Deny | Deny | Allow |
| Repair implementation | Allow before independent re-review | Deny | Deny | Deny | Allow |
| Submit independent exact-head review | Deny | Allow through governed reviewer | Deny | Deny | Allow |
| Request exact-head squash merge | Deny | Deny | Allow after all current gates | Deny | Allow |
| Pause, drain, cancel, inspect, or reconcile | Deny | Deny | Deny | Allow within allowlisted repository | Allow |
| Restore after ordinary pause | Deny | Deny | Deny | Allow only when no owner-only trigger exists | Allow |
| Restore after kill, compromise, protection drift, authorization mismatch, or evidence-integrity failure | Deny | Deny | Deny | Deny | Allow after verified recovery |
| Approve sensitive plans or create/expand run authorization | Deny | Deny | Deny | Deny | Allow |
| Change policy, protection, rulesets, repository settings, visibility, or App installation | Deny | Deny | Deny | Deny | Allow |
| Create, grant, revoke, or rotate credentials/permissions | Deny | Deny | Deny | Deny | Allow |
| Bypass protection or required review/check | Deny | Deny | Deny | Deny | Deny; change governed settings instead |
| Release or production deployment | Deny | Deny | Deny | Deny | Allow through separate approval |
| Target another repository or expand cross-repository access | Deny | Deny | Deny | Deny | Allow only through new explicit authorization/governance |

## Separation invariants

- Builder output and model assertions never count as independent review.
- Reviewer cannot push or repair the code it reviews.
- Merger cannot push, review, change settings, choose a different method, or
  merge a different head than the exact authorized and reviewed SHA.
- Operator commands cannot fabricate human evidence or make an unavailable
  control appear satisfied.
- Human owner remains accountable for installations, permissions, policy,
  sensitive approvals, restoration, release, deployment, and scope expansion.
