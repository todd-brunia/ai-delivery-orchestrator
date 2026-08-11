import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

import { queueGroupId, RuntimeEnvelopeV1Schema } from "../../../runtime/v1/index.js";
import { handleWebhookHttp, type WebhookHttpRequest, type WebhookHttpResponse } from "./http-handler.js";

const secrets = new SecretsManagerClient({});
const sqs = new SQSClient({});

function required(name: "WEBHOOK_SECRET_ARN" | "CALLBACK_QUEUE_URL" | "RUNTIME_CONFIGURATION_VERSION"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function handler(event: WebhookHttpRequest): Promise<WebhookHttpResponse> {
  return handleWebhookHttp(event, {
    loadSecret: async () => {
      const result = await secrets.send(new GetSecretValueCommand({ SecretId: required("WEBHOOK_SECRET_ARN"), VersionStage: "AWSCURRENT" }));
      if (!result.SecretString) throw new Error("webhook secret value is unavailable");
      return result.SecretString;
    },
    enqueue: async (normalized) => {
      const envelope = RuntimeEnvelopeV1Schema.parse({
        schemaVersion: "runtime-envelope/v1", kind: "callback",
        repository: normalized.repository ?? "installation/global",
        runId: `github:${normalized.deliveryId}`,
        idempotencyKey: `github:${normalized.deliveryId}`,
        correlationId: `github:${normalized.deliveryId}`,
        configurationVersion: required("RUNTIME_CONFIGURATION_VERSION"),
        occurredAt: normalized.receivedAt,
        contentSha256: normalized.payloadSha256,
        payload: normalized,
      });
      await sqs.send(new SendMessageCommand({
        QueueUrl: required("CALLBACK_QUEUE_URL"), MessageBody: JSON.stringify(envelope),
        MessageGroupId: queueGroupId(envelope), MessageDeduplicationId: normalized.deliveryId,
      }));
      return "accepted";
    },
  });
}
