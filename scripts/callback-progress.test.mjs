import { test } from "node:test";
import assert from "node:assert/strict";
import { collectCallbackProgress as collect } from "./callback-progress.mjs";

const collectCallbackProgress = (arns, read) => collect(arns, read, "123456789012");

const cluster = "ai-delivery-orchestrator-pilot-worker";
const arn = `arn:aws:ecs:us-east-1:123456789012:task/${cluster}/${"a".repeat(32)}`;
function reader(calls, override = {}) {
  return (args) => {
    calls.push(args);
    const operation = args.slice(0, 2).join(" ");
    const responses = {
      "sts get-caller-identity": { Account: "123456789012" },
      "ecs describe-services": { services: [{ serviceName: cluster, status: "ACTIVE", desiredCount: 0, runningCount: 0, pendingCount: 0 }], failures: [] },
      "sqs get-queue-attributes": { Attributes: { ApproximateNumberOfMessages: "0", ApproximateNumberOfMessagesNotVisible: "0", ApproximateNumberOfMessagesDelayed: "0" } },
      "ecs describe-tasks": { tasks: [{ taskArn: arn, taskDefinitionArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/ai-delivery-orchestrator-pilot-worker:42", lastStatus: "RUNNING", desiredStatus: "RUNNING", overrides: { secret: "never-output" }, containers: [{ name: "worker", lastStatus: "RUNNING", imageDigest: null, exitCode: null }] }], failures: [] },
      ...override,
    };
    assert.ok(Object.hasOwn(responses, operation), `unexpected AWS operation: ${operation}`);
    return responses[operation];
  };
}
test("baseline observes only metadata and does not infer processing success", () => {
  const calls = [];
  const result = collectCallbackProgress([], reader(calls));
  assert.equal(calls.length, 3);
  assert.equal(result.service.runningCount, 0);
  assert.deepEqual(result.tasks, []);
  assert.match(result.interpretation, /does not prove/);
});
test("exact task observations strip private metadata and tolerate pending optional fields", () => {
  const calls = [];
  const result = collectCallbackProgress([arn], reader(calls));
  assert.equal(calls.length, 4);
  assert.equal(result.tasks[0].taskArn, arn);
  assert.equal(JSON.stringify(result).includes("never-output"), false);
});
test("wrong account stops before resource reads", () => {
  const calls = [];
  assert.throws(() => collectCallbackProgress([], reader(calls, { "sts get-caller-identity": { Account: "000000000000" } })));
  assert.equal(calls.length, 1);
});
test("out-of-scope task arguments are rejected before AWS calls", () => {
  const calls = [];
  for (const invalid of ["--debug", arn.replace("us-east-1", "us-west-2"), arn.replace(cluster, "other"), arn.replace("123456789012", "000000000000")]) {
    assert.throws(() => collectCallbackProgress([invalid], reader(calls)));
  }
  assert.equal(calls.length, 0);
});
test("live reader rejects account overrides before any AWS call", () => {
  assert.throws(() => collect([], undefined, "123456789012"), /account_override_forbidden/);
});
test("missing or mismatched task evidence fails closed", () => {
  for (const response of [{ tasks: [], failures: [] }, { tasks: [], failures: [{ reason: "MISSING" }] }]) {
    assert.throws(() => collectCallbackProgress([arn], reader([], { "ecs describe-tasks": response })));
  }
});
