import { createHash } from "node:crypto";

import type { PersistedWorkItem, SprintRunRepository } from "../persistence/index.js";
import type { GitHubExecutionIntent } from "../providers/v1/index.js";
import { verifyAcceptedImplementationDispatch } from "./live-dispatch.js";

function uuid(scope: string): string {
  const value = createHash("sha256").update(scope).digest("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

export async function advanceAcceptedImplementationDispatch(input: {
  readonly repository: SprintRunRepository;
  readonly workItem: PersistedWorkItem;
  readonly intent: GitHubExecutionIntent;
  readonly acceptedAt: string;
  readonly workflowRuns: readonly unknown[];
}): Promise<{ readonly advanced: boolean; readonly reason?: "workflow_run_not_found" | "wrong_intent" }> {
  const evidence = verifyAcceptedImplementationDispatch({ intent: input.intent, acceptedAt: input.acceptedAt, workflowRuns: input.workflowRuns });
  if (!evidence.accepted) return { advanced: false, reason: evidence.reason };
  if (input.workItem.state === "build_dispatched") return { advanced: false };
  if (input.workItem.state !== "ready_to_build") throw new Error("only ready work items may record a build dispatch");
  if (!input.repository.recordDispatchAttempt) throw new Error("dispatch-attempt persistence is required");
  const fingerprint = createHash("sha256").update(JSON.stringify(input.intent)).digest("hex");
  await input.repository.recordDispatchAttempt({ workItemId: input.workItem.id, intentFingerprint: fingerprint, status: "accepted", workflowRunId: evidence.workflowRunId, evidenceUri: evidence.evidenceUri, recordedAt: input.acceptedAt });
  const scope = `sprint-delivery/v1:${input.workItem.id}:${fingerprint}:build_dispatched`;
  await input.repository.transitionWorkItem({
    workItemId: input.workItem.id,
    event: "build_dispatched",
    metadata: { transitionId: uuid(`${scope}:transition`), aggregateId: input.workItem.id, expectedRevision: input.workItem.revision, idempotencyKey: `workflow:${scope}`, occurredAt: input.acceptedAt, actor: { kind: "system", id: "sprint-delivery/v1" }, evidence: [{ kind: "workflow_run", uri: evidence.evidenceUri }] },
    outbox: { id: uuid(`${scope}:outbox`), type: "projection.update", payload: { workItemId: input.workItem.id, event: "build_dispatched", workflowRunId: evidence.workflowRunId }, idempotencyKey: `outbox:${scope}` },
  });
  return { advanced: true };
}
