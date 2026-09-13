import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ECSClient } from "@aws-sdk/client-ecs";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { z } from "zod";
import { callbackModes, tickCallbackMode } from "./callback-lifecycle.js";
import { CallbackLaunchConfigurationSchema, callbackConfigurationHash, DynamoCallbackLifecycleStore, EcsCallbackTaskLauncher } from "./callback-lifecycle-aws.js";

const environmentSchema = z.object({
  CALLBACK_LIFECYCLE_ENABLED: z.enum(["true", "false"]).default("false"),
  CALLBACK_LAUNCH_CONFIGURATION_JSON: z.string().max(16_384),
  COORDINATION_TABLE_NAME: z.literal("ai-delivery-orchestrator-pilot-coordination"),
  CALLBACK_QUEUE_URL: z.string().regex(/^https:\/\/sqs\.us-east-1\.amazonaws\.com\/[0-9]{12}\/ai-delivery-orchestrator-pilot-callbacks\.fifo$/),
});

/** Schedule payloads cannot supply launch parameters, credentials, or enablement. */
export async function handler(): Promise<{ status: string }> {
  const clients = { dynamo: new DynamoDBClient({ region: "us-east-1", maxAttempts: 2 }),
    ecs: new ECSClient({ region: "us-east-1", maxAttempts: 1 }),
    sqs: new SQSClient({ region: "us-east-1", maxAttempts: 2 }) };
  try {
    const environment = environmentSchema.parse(process.env);
    if (environment.CALLBACK_LIFECYCLE_ENABLED === "false") return { status: "disabled" };
    const configuration = CallbackLaunchConfigurationSchema.parse(JSON.parse(environment.CALLBACK_LAUNCH_CONFIGURATION_JSON) as unknown);
    const store = new DynamoCallbackLifecycleStore(clients.dynamo, environment.COORDINATION_TABLE_NAME, configuration.repository);
    const state = await store.read();
    const fingerprint = callbackConfigurationHash(configuration);
    if (!state || state.configuration !== fingerprint || !state.enabled || state.draining) return { status: "disabled" };
    const queue = await clients.sqs.send(new GetQueueAttributesCommand({ QueueUrl: environment.CALLBACK_QUEUE_URL,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"] }),
    { abortSignal: AbortSignal.timeout(5_000) });
    // Missing or malformed queue metadata is uncertainty, never zero.
    const counts = z.object({ ApproximateNumberOfMessages: z.string().regex(/^\d+$/),
      ApproximateNumberOfMessagesNotVisible: z.string().regex(/^\d+$/),
      ApproximateNumberOfMessagesDelayed: z.string().regex(/^\d+$/) }).parse(queue.Attributes);
    const hasWork = Object.values(counts).some((count) => BigInt(count) > 0n);
    const launcher = new EcsCallbackTaskLauncher(clients.ecs, configuration);
    for (const mode of callbackModes) {
      const outcome = await tickCallbackMode(store, launcher, fingerprint, mode, hasWork);
      process.stdout.write(`${JSON.stringify({ event: "callback_lifecycle_tick", mode, outcome })}\n`);
    }
    return { status: "observed" };
  } catch {
    process.stderr.write('{"event":"callback_lifecycle_failed","reason":"lifecycle_unavailable"}\n');
    throw new Error("callback_lifecycle_unavailable");
  } finally { clients.dynamo.destroy(); clients.ecs.destroy(); clients.sqs.destroy(); }
}
