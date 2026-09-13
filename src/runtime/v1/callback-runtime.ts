import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { Pool } from "pg";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { RepositoryAdapterConfigV1Schema } from "../../domain/sprint-delivery/v1/index.js";
import { NormalizedGitHubEventSchema } from "../../github/webhooks/v1/index.js";
import { PostgresSprintRunRepository, PostgresWebhookInbox } from "../../persistence/index.js";
import { GitHubAppReadAdapter } from "../../providers/v1/github-read.js";
import { CanonicalCallbackResolver } from "./canonical-callback-resolver.js";
import { CallbackWorker, callbackWorkerId } from "./callback-worker.js";
import { RuntimeEnvelopeV1Schema } from "./coordination.js";
import { RuntimeGenerationControl } from "./queue-consumer.js";
import { loadSupervisedTlsCertificate } from "./supervised-tls.js";
import { publishCallbackEvents } from "./callback-projection.js";
import { DynamoCallbackLifecycleStore } from "./callback-lifecycle-aws.js";
import { callbackTaskMayWork, finishCallbackTask, signalCallbackWork } from "./callback-lifecycle.js";

export const CallbackEnvironmentSchema = z.object({
  CALLBACK_PROCESSING_ENABLED: z.literal("true"),
  CALLBACK_RUNTIME_MODE: z.enum(["ingress", "processor"]),
  CALLBACK_RUN_ONCE: z.enum(["true", "false"]).default("true"),
  CALLBACK_LIFECYCLE_REQUIRED: z.enum(["true", "false"]).default("false"),
  CALLBACK_LIFECYCLE_CONFIGURATION: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  CALLBACK_LIFECYCLE_TOKEN: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  CALLBACK_LIFECYCLE_DEADLINE: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  CALLBACK_DELIVERY_IDS: z.string().transform((value) => value.split(",")).pipe(z.array(z.uuid()).min(1).max(100)).optional(),
  CALLBACK_EVENT_FAMILIES: z.string().transform((value) => value.split(",")).pipe(z.array(z.enum(["issues", "issue_comment", "workflow_run", "pull_request", "check_run", "check_suite", "pull_request_review"])).min(1).max(7)),
  CALLBACK_QUEUE_URL: z.string().url().regex(/^https:\/\/sqs\.us-east-1\.amazonaws\.com\/[0-9]{12}\/ai-delivery-orchestrator-pilot-callbacks\.fifo$/),
  RUNTIME_CONFIGURATION_VERSION: z.string().regex(/^[A-Za-z0-9._:/-]{1,200}$/),
  COORDINATION_TABLE_NAME: z.literal("ai-delivery-orchestrator-pilot-coordination"),
  REPOSITORY_ADAPTER_JSON: z.string().min(2).max(32_768),
  GITHUB_HOOK_ID: z.coerce.number().int().positive(),
  GITHUB_REPOSITORY_ID: z.string().regex(/^[1-9][0-9]{0,19}$/),
  GITHUB_APP_ID: z.string().regex(/^[1-9][0-9]{0,19}$/),
  GITHUB_INSTALLATION_ID: z.string().regex(/^[1-9][0-9]{0,19}$/),
  GITHUB_INSTALLATION_ACCOUNT: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
  PGHOST: z.string().min(1).max(253), PGPORT: z.coerce.number().int().min(1).max(65535).default(5432),
  PGDATABASE: z.literal("orchestrator"), PGUSER: z.string().min(1).max(100).optional(), PGPASSWORD: z.string().min(1).max(1000).optional(),
  DATABASE_SECRET_ARN: z.string().regex(/^arn:aws:secretsmanager:us-east-1:[0-9]{12}:secret:rds!cluster-[A-Za-z0-9-]+$/).optional(),
}).passthrough().superRefine((value, context) => {
  const lifecycleFields = [value.CALLBACK_LIFECYCLE_CONFIGURATION, value.CALLBACK_LIFECYCLE_TOKEN, value.CALLBACK_LIFECYCLE_DEADLINE];
  if ((value.CALLBACK_LIFECYCLE_REQUIRED === "true" || lifecycleFields.some((field) => field !== undefined)) && !lifecycleFields.every((field) => field !== undefined)) context.addIssue({ code: "custom", message: "complete lifecycle identity required" });
  if (value.CALLBACK_RUNTIME_MODE === "processor" && value.CALLBACK_RUN_ONCE === "true" && !value.CALLBACK_DELIVERY_IDS) context.addIssue({ code: "custom", message: "bounded callback processing requires exact delivery IDs" });
  if ((!value.PGUSER || !value.PGPASSWORD) && (value.CALLBACK_RUNTIME_MODE !== "ingress" || !value.DATABASE_SECRET_ARN)) context.addIssue({ code: "custom", message: "database credentials are required" });
});

export function validateCallbackEnvironment(environment: NodeJS.ProcessEnv): void {
  const config = CallbackEnvironmentSchema.parse(environment);
  const adapter = RepositoryAdapterConfigV1Schema.parse(JSON.parse(config.REPOSITORY_ADAPTER_JSON) as unknown);
  if (!adapter.enabled) throw new Error("callback_repository_disabled");
}

/** ACK means durable inbox acceptance, never successful callback processing. */
export async function acceptCallbackEnvelope(body: string, configurationVersion: string, repository: string, inbox: Pick<PostgresWebhookInbox, "accept">, signalAccepted?: () => Promise<void>): Promise<void> {
  if (Buffer.byteLength(body) > 65_536) throw new Error("callback_envelope_bounds");
  const envelope = RuntimeEnvelopeV1Schema.parse(JSON.parse(body) as unknown);
  const event = NormalizedGitHubEventSchema.parse(envelope.payload);
  if (envelope.kind !== "callback" || envelope.configurationVersion !== configurationVersion ||
    envelope.contentSha256 !== event.payloadSha256 || envelope.repository !== (event.repository ?? "installation/global") ||
    (event.repository !== undefined && event.repository !== repository) || envelope.idempotencyKey !== `github:${event.deliveryId}`) throw new Error("callback_envelope_mismatch");
  await inbox.accept(event);
  await signalAccepted?.();
}

/** Explicit production composition; it has no model or GitHub publishing port. */
export async function runCallbackRuntime(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const deadline = CallbackEnvironmentSchema.parse(environment).CALLBACK_LIFECYCLE_DEADLINE;
  if (deadline !== undefined && (deadline <= Date.now() || deadline > Date.now() + 180_000)) throw new Error("callback_lifecycle_deadline_invalid");
  // A hard process bound includes initialization, provider requests and pool drain.
  // Abrupt expiry intentionally leaves durable claims for the next bounded task.
  const timer = deadline === undefined ? undefined : setTimeout(() => {
    process.stderr.write('{"event":"callback_task_expired","reason":"bounded_deadline"}\n'); process.exit(1);
  }, deadline - Date.now());
  try { await runCallbackRuntimeWithinDeadline(environment); } finally { if (timer) clearTimeout(timer); }
}

async function runCallbackRuntimeWithinDeadline(environment: NodeJS.ProcessEnv): Promise<void> {
  const config = CallbackEnvironmentSchema.parse(environment);
  const adapter = RepositoryAdapterConfigV1Schema.parse(JSON.parse(config.REPOSITORY_ADAPTER_JSON) as unknown);
  if (!adapter.enabled) throw new Error("callback_repository_disabled");
  const secrets = config.CALLBACK_RUNTIME_MODE === "processor" ? new SecretsManagerClient({ region: "us-east-1" }) : undefined;
  const sqs = config.CALLBACK_RUNTIME_MODE === "ingress" ? new SQSClient({ region: "us-east-1" }) : undefined;
  const dynamo = config.CALLBACK_RUNTIME_MODE === "ingress" || config.CALLBACK_LIFECYCLE_TOKEN ? new DynamoDBClient({ region: "us-east-1", maxAttempts: 2 }) : undefined;
  const lifecycle = config.CALLBACK_LIFECYCLE_TOKEN && dynamo ? new DynamoCallbackLifecycleStore(dynamo, config.COORDINATION_TABLE_NAME, adapter.repository) : undefined;
  const mayWork = async () => {
    if (!lifecycle) return true;
    const state = await lifecycle.read();
    return !!state && state[config.CALLBACK_RUNTIME_MODE].slot?.deadline === config.CALLBACK_LIFECYCLE_DEADLINE &&
      callbackTaskMayWork(state, config.CALLBACK_LIFECYCLE_CONFIGURATION!, config.CALLBACK_RUNTIME_MODE, config.CALLBACK_LIFECYCLE_TOKEN!, Date.now());
  };
  if (!await mayWork()) { dynamo?.destroy(); secrets?.destroy(); sqs?.destroy(); throw new Error("callback_lifecycle_fenced"); }
  const reference = "ai-delivery-orchestrator/pilot/github-app-builder-private-key";
  const github = secrets ? new GitHubAppReadAdapter({ version: "github-read/v1", repository: adapter.repository, repositoryId: config.GITHUB_REPOSITORY_ID,
    appId: config.GITHUB_APP_ID, installationId: config.GITHUB_INSTALLATION_ID, installationAccount: config.GITHUB_INSTALLATION_ACCOUNT,
    apiBaseUrl: "https://api.github.com", apiVersion: "2022-11-28", maxPages: 10, maxItems: 100, maxResponseBytes: 1_000_000,
    timeoutMilliseconds: 10_000, tokenTtlSeconds: 600, requiredPermissions: { actions: "read", contents: "read", issues: "read", metadata: "read", pull_requests: "read", checks: "read" } },
  reference, { load: async (selected) => {
    if (selected !== reference) throw new Error("callback_secret_scope");
    const result = await secrets.send(new GetSecretValueCommand({ SecretId: reference, VersionStage: "AWSCURRENT" }));
    if (!result.SecretString) throw new Error("callback_secret_unavailable");
    return result.SecretString;
  } }, { request: async (input) => {
    const response = await fetch(input.url, { method: input.method, headers: input.headers, ...(input.body ? { body: input.body } : {}), signal: AbortSignal.timeout(input.timeoutMilliseconds) });
    // Bound the body while streaming, before constructing provider text in memory.
    const chunks: Uint8Array[] = []; let bytes = 0;
    for await (const chunk of response.body ?? []) { bytes += chunk.length; if (bytes > 1_000_000) throw new Error("callback_response_bounds"); chunks.push(chunk); }
    return { status: response.status, headers: { link: response.headers.get("link") ?? undefined, "x-ratelimit-remaining": response.headers.get("x-ratelimit-remaining") ?? undefined }, body: Buffer.concat(chunks).toString("utf8") };
  } }) : undefined;
  const certificate = await loadSupervisedTlsCertificate();
  let databaseUser = config.PGUSER, databasePassword = config.PGPASSWORD;
  if ((!databaseUser || !databasePassword) && config.DATABASE_SECRET_ARN) {
    const databaseSecrets = new SecretsManagerClient({ region: "us-east-1" });
    try {
      const response = await databaseSecrets.send(new GetSecretValueCommand({ SecretId: config.DATABASE_SECRET_ARN, VersionStage: "AWSCURRENT" }));
      const credentials = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(1000) }).parse(JSON.parse(response.SecretString ?? "null") as unknown);
      databaseUser = credentials.username; databasePassword = credentials.password;
    } finally { databaseSecrets.destroy(); }
  }
  const pool = new Pool({ host: config.PGHOST, port: config.PGPORT, database: config.PGDATABASE, user: databaseUser, password: databasePassword, ssl: { ca: certificate, rejectUnauthorized: true }, max: 3, statement_timeout: 15_000, connectionTimeoutMillis: 45_000 });
  const inbox = new PostgresWebhookInbox(pool, adapter.repository, [...config.CALLBACK_EVENT_FAMILIES, "installation", "installation_repositories"], config.CALLBACK_DELIVERY_IDS);
  const control = new RuntimeGenerationControl();
  const stop = () => { control.drain(control.generation); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  const resolver = github ? new CanonicalCallbackResolver(pool, github, adapter, { hookId: config.GITHUB_HOOK_ID, installationId: Number(config.GITHUB_INSTALLATION_ID), configurationVersion: config.RUNTIME_CONFIGURATION_VERSION }) : undefined;
  const worker = resolver ? new CallbackWorker(control, inbox, new PostgresSprintRunRepository(pool), resolver, inbox, { ownerId: callbackWorkerId(), configurationVersion: config.RUNTIME_CONFIGURATION_VERSION, maxBatch: 10, maxAttempts: 5, leaseMilliseconds: 120_000, mayWork }) : undefined;
  try {
    while (control.mayClaim && await mayWork()) {
      let empty = false;
      if (sqs && dynamo) {
      const batch = await sqs.send(new ReceiveMessageCommand({ QueueUrl: config.CALLBACK_QUEUE_URL, MaxNumberOfMessages: 10, WaitTimeSeconds: 10, VisibilityTimeout: 30 }));
      for (const message of batch.Messages ?? []) {
        if (!control.mayClaim || !await mayWork()) break;
        try {
          await acceptCallbackEnvelope(message.Body ?? "", config.RUNTIME_CONFIGURATION_VERSION, adapter.repository, inbox,
            lifecycle ? () => signalCallbackWork(lifecycle, config.CALLBACK_LIFECYCLE_CONFIGURATION!, "processor") : undefined);
          if (!message.ReceiptHandle) throw new Error("callback_receipt_absent");
          if (!control.mayClaim || !await mayWork()) throw new Error("callback_lifecycle_fenced");
          await sqs.send(new DeleteMessageCommand({ QueueUrl: config.CALLBACK_QUEUE_URL, ReceiptHandle: message.ReceiptHandle }));
        } catch { process.stderr.write('{"event":"callback_ingress_retry","reason":"callback_acceptance_failed"}\n'); }
      }
      if (!control.mayClaim || !await mayWork()) break;
      const published = await publishCallbackEvents(pool, dynamo, config.COORDINATION_TABLE_NAME, mayWork);
      empty = !batch.Messages?.length && published === 0;
      }
      if (worker) {
        const dispositions = await worker.drainOnce();
        if (dispositions.length) process.stdout.write(`${JSON.stringify({ event: "callback_batch", dispositions })}\n`);
        if (lifecycle) {
          // Also signal after an empty retry: a predecessor may have crashed after
          // its PostgreSQL commit but before notifying the projection publisher.
          await signalCallbackWork(lifecycle, config.CALLBACK_LIFECYCLE_CONFIGURATION!, "ingress");
          empty = !await inbox.hasPendingWork();
        }
      }
      if (lifecycle && (empty || Date.now() >= config.CALLBACK_LIFECYCLE_DEADLINE! - 30_000)) {
        await finishCallbackTask(lifecycle, config.CALLBACK_LIFECYCLE_CONFIGURATION!, config.CALLBACK_RUNTIME_MODE, config.CALLBACK_LIFECYCLE_TOKEN!, empty, Date.now());
        break;
      }
      if (config.CALLBACK_RUN_ONCE === "true") break;
      if (worker && control.mayClaim) await delay(1000);
    }
  } finally {
    process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
    await pool.end(); sqs?.destroy(); secrets?.destroy(); dynamo?.destroy();
  }
}
