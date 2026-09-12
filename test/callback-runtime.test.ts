import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { acceptCallbackEnvelope, CallbackEnvironmentSchema } from "../src/runtime/v1/callback-runtime.js";

describe("callback runtime boundary", () => {
  it("accepts only a matching versioned envelope before queue acknowledgement", async () => {
    const id = randomUUID(); const sha = "a".repeat(64); const time = new Date().toISOString();
    const payload = { version: "github-webhook/v1", deliveryId: id, eventName: "issues", action: "edited", hookId: 1, installationId: 2, repository: "fixture/repository", senderLogin: "user", issueNumber: 3, payloadSha256: sha, receivedAt: time };
    const envelope = { schemaVersion: "runtime-envelope/v1", kind: "callback", repository: payload.repository, runId: `github:${id}`, idempotencyKey: `github:${id}`, correlationId: `github:${id}`, configurationVersion: "fixture:v1", occurredAt: time, contentSha256: sha, payload };
    let accepted = 0;
    const inbox = { accept: () => { accepted++; return Promise.resolve({ event: payload as never, duplicate: false }); } };
    await acceptCallbackEnvelope(JSON.stringify(envelope), "fixture:v1", payload.repository, inbox);
    expect(accepted).toBe(1);
    await expect(acceptCallbackEnvelope(JSON.stringify({ ...envelope, contentSha256: "b".repeat(64) }), "fixture:v1", payload.repository, inbox)).rejects.toThrow("mismatch");
    await expect(acceptCallbackEnvelope(JSON.stringify(envelope), "fixture:v2", payload.repository, inbox)).rejects.toThrow("mismatch");
    expect(accepted).toBe(1);
  });
  it("cannot enable callbacks with incomplete production dependencies", () => {
    expect(CallbackEnvironmentSchema.safeParse({ CALLBACK_PROCESSING_ENABLED: "true" }).success).toBe(false);
    expect(CallbackEnvironmentSchema.safeParse({ CALLBACK_PROCESSING_ENABLED: "false" }).success).toBe(false);
  });
  it("keeps ingress database-secret access separate from processor credentials and exact-delivery scope", () => {
    const ingress = { CALLBACK_PROCESSING_ENABLED: "true", CALLBACK_RUNTIME_MODE: "ingress", CALLBACK_EVENT_FAMILIES: "workflow_run",
      CALLBACK_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/ai-delivery-orchestrator-pilot-callbacks.fifo",
      RUNTIME_CONFIGURATION_VERSION: "fixture:v1", COORDINATION_TABLE_NAME: "ai-delivery-orchestrator-pilot-coordination",
      REPOSITORY_ADAPTER_JSON: "{}", GITHUB_HOOK_ID: "1", GITHUB_REPOSITORY_ID: "2", GITHUB_APP_ID: "3", GITHUB_INSTALLATION_ID: "4", GITHUB_INSTALLATION_ACCOUNT: "fixture",
      PGHOST: "fixture.invalid", PGDATABASE: "orchestrator", DATABASE_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!cluster-fixture-abcdef" };
    expect(CallbackEnvironmentSchema.safeParse(ingress).success).toBe(true);
    const processor = { ...ingress, CALLBACK_RUNTIME_MODE: "processor" };
    expect(CallbackEnvironmentSchema.safeParse(processor).success).toBe(false);
    expect(CallbackEnvironmentSchema.safeParse({ ...processor, PGUSER: "fixture", PGPASSWORD: "fake", CALLBACK_DELIVERY_IDS: randomUUID() }).success).toBe(true);
    expect(CallbackEnvironmentSchema.safeParse({ ...ingress, CALLBACK_EVENT_FAMILIES: "arbitrary" }).success).toBe(false);
  });
});
