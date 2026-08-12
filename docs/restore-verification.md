# Pilot Restore Verification

Restore verification is a two-checkpoint operation. Neither workflow runs on a
push or schedule, and both require approval through the protected `pilot`
environment at the exact current `main` commit.

## Verification checkpoint

Dispatch `Verify pilot database restore` with an approved Aurora cluster
snapshot, a unique lowercase verification ID, and `RESTORE VERIFY`. The
workflow proves that the snapshot belongs to the authoritative pilot cluster,
restores it into the existing isolated database subnets with no public access,
and runs a read-only check for migration history plus the `orchestrator` and
`langgraph_checkpoints` schemas. It does not alter the authoritative cluster,
run migrations, print an endpoint or secret, or clean up automatically.

Record the workflow URL, exact commit, verification ID, snapshot creation time,
restore start/end times, schema result, observed recovery point objective (time
between snapshot creation and verification request), and recovery time
objective (request to successful integrity check). Do not copy account IDs,
ARNs, endpoints, credentials, row contents, prompts, or source into evidence.

Any failure preserves the temporary cluster for diagnosis. A password mismatch,
unavailable snapshot, unexpected source cluster, missing schema, empty migration
history, task failure, or ambiguous result fails closed and requires owner
review. Do not repair the restored database to make verification pass.

## Cleanup checkpoint

After evidence review, separately dispatch `Clean up pilot restore verification`
for the exact verification ID with `DELETE RESTORE VERIFY`. The workflow refuses
the authoritative identifier and proves both `Purpose=restore-verification` and
the exact `VerificationId` tags before deletion. Cleanup deliberately skips a
final snapshot because the approved source snapshot remains the recovery
artifact and the cluster is a temporary copy.
