import { createHash } from "node:crypto";

import { z } from "zod";

export const OBSERVABILITY_VERSION = "observability/v1" as const;
export const TelemetryDimensionsSchema = z.strictObject({
  version: z.literal(OBSERVABILITY_VERSION),
  service: z.enum(["webhook", "operator-api", "worker", "migration", "reconciliation"]),
  environment: z.literal("pilot"),
  operation: z.enum(["receive", "validate", "enqueue", "process", "project", "wake", "drain", "migrate", "reconcile", "restore-verify"]),
  outcome: z.enum(["success", "rejected", "retry", "failed", "unavailable"]),
  errorClass: z.enum(["none", "invalid_contract", "unauthorized", "stale", "dependency", "timeout", "internal"]),
});
export type TelemetryDimensions = z.infer<typeof TelemetryDimensionsSchema>;

export const RuntimeMetricNameSchema = z.enum([
  "AuroraWakeSeconds", "WorkerWakeToReadySeconds", "WorkerHeartbeatAgeSeconds",
  "ProjectionLagSeconds", "MigrationFailures", "BackupAgeHours", "TelemetryGap",
]);
export type RuntimeMetricName = z.infer<typeof RuntimeMetricNameSchema>;

const forbiddenKey = /(?:authorization|cookie|password|secret|token|api[_-]?key|body|payload|prompt|reasoning|source|database[_-]?url|connection)/i;
const forbiddenValue = /(?:bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]{8,}|postgres(?:ql)?:\/\/[^\s]+)/i;

export function opaqueTelemetryId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function sanitizeTelemetryDetails(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    if (forbiddenKey.test(key)) { sanitized[key] = "[REDACTED]"; continue; }
    if (typeof item === "string") sanitized[key] = forbiddenValue.test(item) ? "[REDACTED]" : item.slice(0, 500);
    else if (typeof item === "number" || typeof item === "boolean" || item === null) sanitized[key] = item;
    else sanitized[key] = "[OMITTED]";
  }
  return sanitized;
}

export function telemetryRecord(dimensions: TelemetryDimensions, details: Readonly<Record<string, unknown>> = {}, occurredAt = new Date()): Readonly<Record<string, unknown>> {
  return { timestamp: occurredAt.toISOString(), ...TelemetryDimensionsSchema.parse(dimensions), details: sanitizeTelemetryDetails(details) };
}

export function runtimeMetric(name: RuntimeMetricName, value: number): Readonly<{ namespace: "AiDeliveryOrchestrator/Pilot"; name: RuntimeMetricName; value: number; environment: "pilot" }> {
  if (!Number.isFinite(value) || value < 0) throw new Error("metric value must be a finite non-negative number");
  return { namespace: "AiDeliveryOrchestrator/Pilot", name: RuntimeMetricNameSchema.parse(name), value, environment: "pilot" };
}
