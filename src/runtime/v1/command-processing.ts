import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { SprintRunEvent } from "../../domain/sprint-delivery/v1/index.js";
import type { PersistedSprintRun, SprintRunRepository } from "../../persistence/index.js";

export const RuntimeCommandV1Schema = z.strictObject({
  schemaVersion: z.literal("runtime-command/v1"),
  commandId: z.uuid(),
  operation: z.enum(["pause", "resume", "cancel", "reconcile"]),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  runId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/),
  correlationId: z.string().min(1).max(200),
  causationId: z.string().min(1).max(200).optional(),
  actor: z.strictObject({ kind: z.enum(["human", "system"]), id: z.string().min(1).max(200) }),
  configurationVersion: z.literal("runtime-v1"),
  occurredAt: z.iso.datetime({ offset: true }),
  resumeTarget: z.enum(["collecting_plans", "analyzing", "active", "waiting_for_human"]).optional(),
}).superRefine((value, context) => {
  if ((value.operation === "resume") !== (value.resumeTarget !== undefined)) {
    context.addIssue({ code: "custom", path: ["resumeTarget"], message: "resumeTarget is required only for resume" });
  }
});
export type RuntimeCommandV1 = z.infer<typeof RuntimeCommandV1Schema>;

export interface ProjectionWriter {
  putRun(run: PersistedSprintRun, sourceEventId: string, projectionAsOf: Date): Promise<"updated" | "stale">;
}

const eventFor = (command: RuntimeCommandV1): SprintRunEvent => {
  switch (command.operation) {
    case "pause": return { type: "paused" };
    case "cancel": return { type: "cancelled" };
    case "reconcile": return { type: "reconciled" };
    case "resume": return { type: "resumed", target: command.resumeTarget! };
  }
};

export class RuntimeCommandProcessor {
  constructor(
    private readonly repository: SprintRunRepository,
    private readonly projections: ProjectionWriter,
    private readonly workerId: string,
  ) {}

  async process(raw: unknown, now = new Date()): Promise<{ duplicate: boolean; projection: "updated" | "stale" }> {
    const command = RuntimeCommandV1Schema.parse(raw);
    const current = await this.repository.getRun(command.runId);
    if (!current || current.input.repository !== command.repository) throw new Error("command target is unavailable");
    const acquired = await this.repository.tryAcquireLease({ aggregateType: "sprint_run", aggregateId: command.runId, ownerId: this.workerId, expiresAt: new Date(now.getTime() + 60_000) }, now);
    if (!acquired) throw new Error("aggregate lease unavailable");
    const result = await this.repository.transitionRun({
      runId: command.runId,
      event: eventFor(command),
      metadata: {
        transitionId: command.commandId,
        aggregateId: command.runId,
        expectedRevision: command.expectedRevision,
        idempotencyKey: command.idempotencyKey,
        occurredAt: command.occurredAt,
        actor: command.actor,
        evidence: [{ kind: "policy", uri: `runtime://commands/${command.commandId}` }],
      },
      outbox: {
        id: randomUUID(), type: "projection.run.update",
        payload: { runId: command.runId, revision: command.expectedRevision + 1 },
        idempotencyKey: `projection:${command.idempotencyKey}`,
      },
    });
    const projection = await this.projections.putRun(result.run, command.commandId, now);
    return { duplicate: result.duplicate, projection };
  }
}

export class InMemoryProjectionWriter implements ProjectionWriter {
  readonly runs = new Map<string, { revision: number; projectionAsOf: Date; run: PersistedSprintRun }>();
  putRun(run: PersistedSprintRun, _sourceEventId: string, projectionAsOf: Date): Promise<"updated" | "stale"> {
    const existing = this.runs.get(run.id);
    if (existing && existing.revision >= run.revision) return Promise.resolve("stale");
    this.runs.set(run.id, { revision: run.revision, projectionAsOf, run });
    return Promise.resolve("updated");
  }
}
