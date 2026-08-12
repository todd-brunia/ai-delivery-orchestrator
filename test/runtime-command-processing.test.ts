import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PersistedSprintRun, SprintRunRepository } from "../src/persistence/index.js";
import { InMemoryProjectionWriter, RuntimeCommandProcessor } from "../src/runtime/v1/index.js";

const runId = randomUUID();
const state: PersistedSprintRun = { id: runId, input: { workflowVersion: "sprint-delivery/v1", repository: "owner/repo", issueNumbers: [1], mergePolicy: "human" }, state: "active", revision: 3, createdAt: "2026-08-11T00:00:00Z", updatedAt: "2026-08-11T00:00:00Z", workItems: [] };
let transitioned = false;
const repository = {
  getRun: () => Promise.resolve(state),
  tryAcquireLease: () => Promise.resolve(true),
  transitionRun: (request: { metadata: { expectedRevision: number } }) => {
    if (request.metadata.expectedRevision !== 3) throw new Error("stale");
    const duplicate = transitioned; transitioned = true;
    return Promise.resolve({ duplicate, run: { ...state, state: "paused" as const, revision: 4 } });
  },
} as unknown as SprintRunRepository;
const command = { schemaVersion: "runtime-command/v1", commandId: randomUUID(), operation: "pause", repository: "owner/repo", runId, expectedRevision: 3, idempotencyKey: "operator:pause:1", correlationId: "correlation:1", actor: { kind: "human", id: "operator" }, configurationVersion: "runtime-v1", occurredAt: "2026-08-11T00:01:00Z" } as const;

describe("runtime command processing", () => {
  it("commits authoritative state before a source-revision projection", async () => {
    transitioned = false;
    const projections = new InMemoryProjectionWriter();
    const processor = new RuntimeCommandProcessor(repository, projections, "worker-1");
    await expect(processor.process(command)).resolves.toEqual({ duplicate: false, projection: "updated" });
    expect(projections.runs.get(runId)).toMatchObject({ revision: 4 });
    await expect(processor.process(command)).resolves.toEqual({ duplicate: true, projection: "stale" });
  });
  it("rejects stale revisions, wrong repositories, actors, and versions before transition", async () => {
    const processor = new RuntimeCommandProcessor(repository, new InMemoryProjectionWriter(), "worker-1");
    await expect(processor.process({ ...command, expectedRevision: 2 })).rejects.toThrow("stale");
    await expect(processor.process({ ...command, repository: "other/repo" })).rejects.toThrow("target is unavailable");
    await expect(processor.process({ ...command, actor: { kind: "model", id: "no" } })).rejects.toThrow();
    await expect(processor.process({ ...command, configurationVersion: "runtime-v2" })).rejects.toThrow();
  });
});
