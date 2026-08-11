import { describe, expect, it } from "vitest";
import { RuntimeEnvelopeV1Schema, queueGroupId } from "../src/runtime/v1/index.js";

const valid = {
  schemaVersion: "runtime-envelope/v1",
  kind: "command",
  repository: "todd-brunia/ai-delivery-orchestrator",
  runId: "run-1",
  idempotencyKey: "command:1",
  correlationId: "correlation:1",
  configurationVersion: "runtime-v1",
  occurredAt: "2026-08-11T12:00:00-05:00",
  contentSha256: "a".repeat(64),
  payload: { command: "pause" },
} as const;

describe("runtime coordination v1", () => {
  it("accepts a bounded attributed envelope and derives stable FIFO ordering", () => {
    const parsed = RuntimeEnvelopeV1Schema.parse(valid);
    expect(queueGroupId(parsed)).toBe("todd-brunia/ai-delivery-orchestrator:run-1");
  });

  it("fails closed on unknown versions, fields, and oversized payloads", () => {
    expect(() => RuntimeEnvelopeV1Schema.parse({ ...valid, schemaVersion: "runtime-envelope/v2" })).toThrow();
    expect(() => RuntimeEnvelopeV1Schema.parse({ ...valid, secret: "no" })).toThrow();
    expect(() => RuntimeEnvelopeV1Schema.parse({ ...valid, payload: { body: "x".repeat(33_000) } })).toThrow();
  });
});
