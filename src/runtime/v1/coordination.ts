import { z } from "zod";

const opaqueId = z.string().min(1).max(200).regex(/^[A-Za-z0-9:._/-]+$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const RuntimeEnvelopeV1Schema = z.strictObject({
  schemaVersion: z.literal("runtime-envelope/v1"),
  kind: z.enum(["command", "callback", "projection", "wake"]),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  runId: opaqueId,
  workItemId: opaqueId.optional(),
  idempotencyKey: opaqueId,
  correlationId: opaqueId,
  causationId: opaqueId.optional(),
  configurationVersion: opaqueId,
  occurredAt: z.iso.datetime({ offset: true }),
  contentSha256: sha256,
  payload: z.record(z.string(), z.unknown()).refine(
    (payload) => Buffer.byteLength(JSON.stringify(payload), "utf8") <= 32_768,
    "payload exceeds 32 KiB",
  ),
});
export type RuntimeEnvelopeV1 = z.infer<typeof RuntimeEnvelopeV1Schema>;

export interface CoordinationStore {
  claimDeduplication(purpose: "github" | "command", key: string, expiresAt: Date): Promise<boolean>;
  advanceWakeGeneration(repository: string, expectedGeneration: number): Promise<number>;
  putProjection(input: { key: string; sourceEventId: string; sourceRevision: number; projectionAsOf: Date; value: unknown }): Promise<"updated" | "stale">;
}

export const queueGroupId = (message: RuntimeEnvelopeV1): string =>
  `${message.repository}:${message.runId}`;
