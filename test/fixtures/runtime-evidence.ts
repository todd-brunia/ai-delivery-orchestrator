import type { RuntimeObservation } from "../../src/domain/sprint-delivery/v1/runtime-evidence.js";

export function runtimeEvidence(at = "2026-09-12T16:00:00.000Z", execute = false): RuntimeObservation {
  return {
    version: "supervised-runtime-evidence/v1", source: "ecs-task-local-metadata-v4_and_process_guard",
    handoffPolicy: "exact_constraints_fresh_current_task/v1",
    constraints: {
      repository: "todd-brunia/ai-consulting-client-portal",
      clusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/ai-delivery-orchestrator-pilot-worker",
      taskDefinitionArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/ai-delivery-orchestrator-pilot-supervised-dispatch:21",
      imageDigest: `sha256:${"a".repeat(64)}`, configurationFingerprint: "b".repeat(64),
      stopPolicy: "supervised-process-deadline/v1", maximumDurationMilliseconds: 180_000,
    },
    taskArn: `arn:aws:ecs:us-east-1:123456789012:task/ai-delivery-orchestrator-pilot-worker/${(execute ? "d" : "c").repeat(32)}`,
    observedAt: at, startedAt: at, deadlineAt: new Date(Date.parse(at) + 180_000).toISOString(),
    mode: execute ? "execute" : "preflight", executionEnabled: execute, deadlineInstalled: true, otherRuntimeControls: "not_observed",
  };
}
