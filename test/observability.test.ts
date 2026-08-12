import { describe, expect, it } from "vitest";
import { opaqueTelemetryId, runtimeMetric, sanitizeTelemetryDetails, telemetryRecord } from "../src/observability/v1/index.js";

describe("observability v1", () => {
  it("emits only bounded low-cardinality dimensions", () => {
    const record = telemetryRecord({ version: "observability/v1", service: "worker", environment: "pilot", operation: "process", outcome: "retry", errorClass: "dependency" }, { attempt: 2, latencyMs: 45 }, new Date("2026-08-11T00:00:00Z"));
    expect(record).toMatchObject({ timestamp: "2026-08-11T00:00:00.000Z", service: "worker", outcome: "retry", details: { attempt: 2, latencyMs: 45 } });
    expect(() => telemetryRecord({ version: "observability/v1", service: "worker", environment: "pilot", operation: "process", outcome: "retry", errorClass: "provider-shaped-client-value" } as never)).toThrow();
  });
  it("redacts credentials, source, prompts, reasoning, bodies, and database URLs", () => {
    const injected = sanitizeTelemetryDetails({ authorization: "Bearer token", webhookBody: "private", sourceCode: "private", prompt: "private", reasoning: "private", password: "private", innocent: "postgresql://user:pass@host/db", safe: "bounded" });
    expect(injected).toMatchObject({ authorization: "[REDACTED]", webhookBody: "[REDACTED]", sourceCode: "[REDACTED]", prompt: "[REDACTED]", reasoning: "[REDACTED]", password: "[REDACTED]", innocent: "[REDACTED]", safe: "bounded" });
    expect(JSON.stringify(injected)).not.toContain("private");
  });
  it("uses stable opaque identifiers instead of client-controlled labels", () => {
    expect(opaqueTelemetryId("run-sensitive-value")).toMatch(/^[a-f0-9]{16}$/);
    expect(opaqueTelemetryId("run-sensitive-value")).toBe(opaqueTelemetryId("run-sensitive-value"));
  });
  it("bounds runtime measurements to named non-negative metrics", () => {
    expect(runtimeMetric("AuroraWakeSeconds", 42)).toMatchObject({ namespace: "AiDeliveryOrchestrator/Pilot", environment: "pilot", value: 42 });
    expect(() => runtimeMetric("WorkerWakeToReadySeconds", -1)).toThrow(/finite non-negative/);
  });
});
