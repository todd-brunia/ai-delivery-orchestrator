import { GetItemCommand, type PutItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { DescribeTasksCommand, RunTaskCommand, ECSClient } from "@aws-sdk/client-ecs";
import { describe, expect, it } from "vitest";
import { CallbackLaunchConfigurationSchema, callbackConfigurationHash, DynamoCallbackLifecycleStore, EcsCallbackTaskLauncher } from "../src/runtime/v1/callback-lifecycle-aws.js";
import { initialCallbackLifecycle, type CallbackSlot } from "../src/runtime/v1/callback-lifecycle.js";

const configuration = CallbackLaunchConfigurationSchema.parse({ version: "callback-launch/v1",
  cluster: "arn:aws:ecs:us-east-1:025540956479:cluster/ai-delivery-orchestrator-pilot-worker",
  repository: "todd-brunia/ai-consulting-client-portal", runtimeConfigurationVersion: "runtime-v1",
  ingress: { taskDefinition: "arn:aws:ecs:us-east-1:025540956479:task-definition/ai-delivery-orchestrator-pilot-callback-ingress:1", subnets: ["subnet-12345678"], securityGroup: "sg-12345678" },
  processor: { taskDefinition: "arn:aws:ecs:us-east-1:025540956479:task-definition/ai-delivery-orchestrator-pilot-callback-processor:1", subnets: ["subnet-87654321"], securityGroup: "sg-87654321" },
});
const taskArn = configuration.cluster.replace(":cluster/", ":task/") + "/" + "c".repeat(32);
const slot: CallbackSlot = { token: "a".repeat(64), generation: 1, wake: 2, reservedAt: 1000, deadline: 181000, taskArn: null, finished: false };
describe("callback AWS boundaries", () => {
  it("pins revisions, network and replay inputs without provider or publishing overrides", async () => {
    const commands: RunTaskCommand[] = [];
    const client = { send: (command: RunTaskCommand) => { commands.push(command); return Promise.resolve({ tasks: [{ taskArn }] }); } } as unknown as ECSClient;
    const launcher = new EcsCallbackTaskLauncher(client, configuration);
    await launcher.launch("ingress", slot); await launcher.launch("ingress", slot);
    expect(commands[0]?.input).toEqual(commands[1]?.input);
    expect(commands[0]?.input).toMatchObject({ count: 1, clientToken: slot.token, taskDefinition: configuration.ingress.taskDefinition,
      networkConfiguration: { awsvpcConfiguration: { assignPublicIp: "DISABLED", subnets: configuration.ingress.subnets } } });
    expect(commands[0]?.input.overrides?.containerOverrides?.[0]?.environment?.map((entry) => entry.name)).toEqual([
      "CALLBACK_LIFECYCLE_CONFIGURATION", "CALLBACK_LIFECYCLE_TOKEN", "CALLBACK_LIFECYCLE_DEADLINE",
    ]);
    await launcher.launch("processor", slot);
    expect(commands[2]?.input.networkConfiguration?.awsvpcConfiguration?.assignPublicIp).toBe("ENABLED");
  });
  it("fails closed on missing and unexpected ECS states", async () => {
    let response: unknown = { failures: [{ reason: "MISSING" }] };
    const commands: DescribeTasksCommand[] = [];
    const client = { send: (command: DescribeTasksCommand) => { commands.push(command); return Promise.resolve(response); } } as unknown as ECSClient;
    const launcher = new EcsCallbackTaskLauncher(client, configuration);
    expect(await launcher.describe(taskArn)).toBe("unknown");
    response = { tasks: [{ taskArn, lastStatus: "NEW_UNKNOWN_STATUS" }] };
    expect(await launcher.describe(taskArn)).toBe("unknown");
    response = { tasks: [{ taskArn, lastStatus: "STOPPED" }] };
    expect(await launcher.describe(taskArn)).toBe("stopped");
    expect(commands[0]?.input).toEqual({ cluster: configuration.cluster, tasks: [taskArn] });
    await expect(launcher.describe(taskArn.replace("pilot-worker", "other"))).rejects.toThrow("callback_task_scope");
  });
  it("requires both exact families in the same account and hashes every launch parameter", () => {
    expect(CallbackLaunchConfigurationSchema.safeParse({ ...configuration, ingress: configuration.processor }).success).toBe(false);
    expect(CallbackLaunchConfigurationSchema.safeParse({ ...configuration, ingress: { ...configuration.ingress, taskDefinition: configuration.ingress.taskDefinition.replace(/:1$/, ":*") } }).success).toBe(false);
    expect(callbackConfigurationHash({ ...configuration, runtimeConfigurationVersion: "runtime-v2" })).not.toBe(callbackConfigurationHash(configuration));
  });
  it("uses strongly consistent reads and conditional revision writes on one scoped record", async () => {
    const state = initialCallbackLifecycle(callbackConfigurationHash(configuration));
    const commands: (GetItemCommand | PutItemCommand)[] = [];
    const client = { send: (command: GetItemCommand | PutItemCommand) => {
      commands.push(command); return Promise.resolve(command instanceof GetItemCommand ? { Item: { revision: { N: "0" }, valueJson: { S: JSON.stringify(state) } } } : {});
    } } as unknown as DynamoDBClient;
    const store = new DynamoCallbackLifecycleStore(client, "coordination", configuration.repository);
    expect(await store.read()).toEqual(state);
    expect((commands[0] as GetItemCommand).input.ConsistentRead).toBe(true);
    expect(await store.compareAndSet(0, { ...state, revision: 1 })).toBe(true);
    expect((commands[1] as PutItemCommand).input).toMatchObject({ ConditionExpression: "revision = :expected", Item: {
      purposeKey: { S: "callback-lifecycle/v1" }, entityKey: { S: configuration.repository }, revision: { N: "1" },
    } });
    await expect(store.compareAndSet(0, { ...state, revision: 3 })).rejects.toThrow("callback_lifecycle_invalid_revision");
  });
  it("distinguishes contention from unavailable storage without exposing SDK errors", async () => {
    let failure = Object.assign(new Error("secret-sentinel"), { name: "ConditionalCheckFailedException" });
    const client = { send: () => Promise.reject(failure) } as unknown as DynamoDBClient;
    const store = new DynamoCallbackLifecycleStore(client, "coordination", configuration.repository);
    const state = initialCallbackLifecycle(callbackConfigurationHash(configuration));
    expect(await store.compareAndSet(undefined, state)).toBe(false);
    failure = new Error("secret-sentinel");
    await expect(store.compareAndSet(undefined, state)).rejects.toThrow("callback_lifecycle_store_unavailable");
  });
});
