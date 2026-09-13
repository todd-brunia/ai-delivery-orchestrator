import assert from "node:assert/strict";
import process from "node:process";
import { createSupervisedRuntimeObserver, installSupervisedDeadline, readSupervisedTaskMetadata } from "../dist/runtime/v1/supervised-runtime-evidence.js";
import { revalidateRuntimeHandoff } from "../dist/domain/sprint-delivery/v1/runtime-evidence.js";

const scope = {
  repository: "todd-brunia/ai-consulting-client-portal",
  clusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/ai-delivery-orchestrator-pilot-worker",
  taskDefinitionArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/ai-delivery-orchestrator-pilot-supervised-dispatch:21",
  imageDigest: `sha256:${"a".repeat(64)}`, configurationFingerprint: "b".repeat(64),
  stopPolicy: "supervised-process-deadline/v1", maximumDurationMilliseconds: 180000,
};
const now = () => new Date("2026-09-13T15:00:00.000Z");
const deadline = installSupervisedDeadline(now);
try {
  const observer = createSupervisedRuntimeObserver({ constraints: scope, mode: "preflight", executionEnabled: false, metadataUri: "http://169.254.170.2/v4/fixture", deadline, now,
    readMetadata: async () => ({ Cluster: scope.clusterArn, TaskARN: `arn:aws:ecs:us-east-1:123456789012:task/ai-delivery-orchestrator-pilot-worker/${"c".repeat(32)}`,
      Family: "ai-delivery-orchestrator-pilot-supervised-dispatch", Revision: "21", DesiredStatus: "RUNNING", KnownStatus: "RUNNING", LaunchType: "FARGATE",
      Containers: [{ Name: "supervised-dispatch", Image: `123456789012.dkr.ecr.us-east-1.amazonaws.com/ai-delivery-orchestrator-worker@${scope.imageDigest}`, ImageID: scope.imageDigest, KnownStatus: "RUNNING" }], ignored: "private-sentinel",
    }),
  });
  const observation = await observer.observe();
  assert.equal(observation.deadlineInstalled, true);
  assert.equal(JSON.stringify(observation).includes("private-sentinel"), false);
  const current = { ...observation, taskArn: observation.taskArn.replace("c".repeat(32), "d".repeat(32)), mode: "execute", executionEnabled: true };
  assert.deepEqual(revalidateRuntimeHandoff(observation, current, now()), observation);
  assert.throws(() => revalidateRuntimeHandoff(observation, { ...current, constraints: { ...scope, imageDigest: `sha256:${"e".repeat(64)}` } }, now()));
  await assert.rejects(readSupervisedTaskMetadata("http://localhost/credentials", () => { throw new Error("must not request"); }), /task metadata unavailable/);
  deadline.close();
  await assert.rejects(observer.observe(), /runtime observation unavailable/);
  process.stdout.write("Compiled offline runtime identity and handoff checks passed.\n");
} finally { deadline.close(); }
