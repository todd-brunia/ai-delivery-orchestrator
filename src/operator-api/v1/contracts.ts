import { z } from "zod";

import { SprintRunInputSchema } from "../../domain/sprint-delivery/v1/index.js";

export const OPERATOR_API_VERSION = "operator-api/v1" as const;
export const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/);
export const RunIdSchema = z.uuid();

export const CreateRunRequestSchema = z.strictObject({
  apiVersion: z.literal(OPERATOR_API_VERSION),
  run: SprintRunInputSchema,
});
export const ControlRequestSchema = z.strictObject({
  apiVersion: z.literal(OPERATOR_API_VERSION),
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});
export const WakeDrainRequestSchema = z.strictObject({
  apiVersion: z.literal(OPERATOR_API_VERSION),
  expectedGeneration: z.number().int().nonnegative(),
});

export interface OperatorCommand {
  readonly commandId: string;
  readonly principalArn: string;
  readonly route: string;
  readonly idempotencyKey: string;
  readonly payloadSha256: string;
  readonly payload: unknown;
}

export interface OperatorReadResult {
  readonly source: "authoritative" | "projection";
  readonly projectionAsOf?: string;
  readonly value: unknown;
}

export interface OperatorApiPort {
  submit(command: OperatorCommand): Promise<{ commandId: string; duplicate: boolean }>;
  read(input: { route: string; cursor?: string; limit: number }): Promise<OperatorReadResult>;
}
