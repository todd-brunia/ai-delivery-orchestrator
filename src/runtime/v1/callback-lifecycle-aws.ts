import { GetItemCommand, PutItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DescribeTasksCommand, RunTaskCommand, type ECSClient } from "@aws-sdk/client-ecs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CallbackLifecycleStateSchema, type CallbackLifecycleState, type CallbackLifecycleStore,
  type CallbackMode, type CallbackSlot, type CallbackTaskLauncher } from "./callback-lifecycle.js";

export const CALLBACK_LIFECYCLE_PURPOSE = "callback-lifecycle/v1";
export class DynamoCallbackLifecycleStore implements CallbackLifecycleStore {
  constructor(private readonly client: Pick<DynamoDBClient, "send">, private readonly table: string,
    private readonly repository: string) {}
  private key() { return { purposeKey: { S: CALLBACK_LIFECYCLE_PURPOSE }, entityKey: { S: this.repository } }; }
  async read(): Promise<CallbackLifecycleState | undefined> {
    const response = await this.client.send(new GetItemCommand({ TableName: this.table, Key: this.key(), ConsistentRead: true }), { abortSignal: AbortSignal.timeout(5_000) });
    if (!response.Item) return undefined;
    const text = response.Item.valueJson?.S;
    if (!text || Buffer.byteLength(text) > 16_384) throw new Error("callback_lifecycle_invalid_record");
    const value = CallbackLifecycleStateSchema.parse(JSON.parse(text) as unknown);
    if (response.Item.revision?.N !== String(value.revision)) throw new Error("callback_lifecycle_invalid_revision");
    return value;
  }
  async compareAndSet(expectedRevision: number | undefined, next: CallbackLifecycleState): Promise<boolean> {
    const value = CallbackLifecycleStateSchema.parse(next);
    if (value.revision !== (expectedRevision === undefined ? 0 : expectedRevision + 1)) throw new Error("callback_lifecycle_invalid_revision");
    try {
      await this.client.send(new PutItemCommand({ TableName: this.table,
        Item: { ...this.key(), revision: { N: String(value.revision) }, valueJson: { S: JSON.stringify(value) } },
        ConditionExpression: expectedRevision === undefined ? "attribute_not_exists(purposeKey)" : "revision = :expected",
        ...(expectedRevision === undefined ? {} : { ExpressionAttributeValues: { ":expected": { N: String(expectedRevision) } } }),
      }), { abortSignal: AbortSignal.timeout(5_000) });
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      // eslint-disable-next-line preserve-caught-error -- SDK error bodies must not cross this sanitized boundary.
      throw new Error("callback_lifecycle_store_unavailable");
    }
  }
}

const modeNetwork = z.strictObject({
  taskDefinition: z.string().regex(/^arn:aws:ecs:us-east-1:[0-9]{12}:task-definition\/ai-delivery-orchestrator-pilot-callback-(ingress|processor):[1-9][0-9]*$/),
  subnets: z.array(z.string().regex(/^subnet-[a-f0-9]{8,17}$/)).min(1).max(2),
  securityGroup: z.string().regex(/^sg-[a-f0-9]{8,17}$/),
});
export const CallbackLaunchConfigurationSchema = z.strictObject({
  version: z.literal("callback-launch/v1"),
  cluster: z.string().regex(/^arn:aws:ecs:us-east-1:[0-9]{12}:cluster\/ai-delivery-orchestrator-pilot-worker$/),
  repository: z.literal("todd-brunia/ai-consulting-client-portal"),
  runtimeConfigurationVersion: z.string().regex(/^[A-Za-z0-9._:/-]{1,200}$/),
  ingress: modeNetwork, processor: modeNetwork,
}).superRefine((value, context) => {
  const account = value.cluster.split(":")[4];
  for (const mode of ["ingress", "processor"] as const) {
    if (!value[mode].taskDefinition.startsWith(`arn:aws:ecs:us-east-1:${account}:task-definition/ai-delivery-orchestrator-pilot-callback-${mode}:`)) {
      context.addIssue({ code: "custom", message: "callback launch scope mismatch" });
    }
  }
});
export type CallbackLaunchConfiguration = z.infer<typeof CallbackLaunchConfigurationSchema>;
export function callbackConfigurationHash(configuration: CallbackLaunchConfiguration): string {
  return createHash("sha256").update(JSON.stringify(CallbackLaunchConfigurationSchema.parse(configuration))).digest("hex");
}

export class EcsCallbackTaskLauncher implements CallbackTaskLauncher {
  private readonly config: CallbackLaunchConfiguration;
  constructor(private readonly client: Pick<ECSClient, "send">, configuration: CallbackLaunchConfiguration) {
    this.config = CallbackLaunchConfigurationSchema.parse(configuration);
  }
  async launch(mode: CallbackMode, slot: CallbackSlot): Promise<string> {
    const network = this.config[mode];
    const response = await this.client.send(new RunTaskCommand({ cluster: this.config.cluster,
      taskDefinition: network.taskDefinition, count: 1, launchType: "FARGATE", platformVersion: "1.4.0",
      clientToken: slot.token, startedBy: `callback-${mode}`,
      networkConfiguration: { awsvpcConfiguration: { subnets: network.subnets,
        securityGroups: [network.securityGroup], assignPublicIp: mode === "ingress" ? "DISABLED" : "ENABLED" } },
      overrides: { containerOverrides: [{ name: "worker", environment: [
        { name: "CALLBACK_LIFECYCLE_CONFIGURATION", value: callbackConfigurationHash(this.config) },
        { name: "CALLBACK_LIFECYCLE_TOKEN", value: slot.token },
        { name: "CALLBACK_LIFECYCLE_DEADLINE", value: String(slot.deadline) },
      ] }] },
    }), { abortSignal: AbortSignal.timeout(15_000) });
    const taskArn = response.tasks?.[0]?.taskArn;
    if (response.failures?.length || response.tasks?.length !== 1 || !taskArn ||
      !taskArn.startsWith(this.config.cluster.replace(":cluster/", ":task/") + "/")) throw new Error("callback_launch_uncertain");
    return taskArn;
  }
  async describe(taskArn: string): Promise<"active" | "stopped" | "unknown"> {
    if (!taskArn.startsWith(this.config.cluster.replace(":cluster/", ":task/") + "/")) throw new Error("callback_task_scope");
    const response = await this.client.send(new DescribeTasksCommand({ cluster: this.config.cluster, tasks: [taskArn] }),
      { abortSignal: AbortSignal.timeout(10_000) });
    if (response.failures?.length || response.tasks?.length !== 1 || response.tasks[0]?.taskArn !== taskArn) return "unknown";
    const status = response.tasks[0].lastStatus;
    if (status === "STOPPED") return "stopped";
    return ["PROVISIONING", "PENDING", "ACTIVATING", "RUNNING", "DEACTIVATING", "STOPPING", "DEPROVISIONING"].includes(status ?? "") ? "active" : "unknown";
  }
}
