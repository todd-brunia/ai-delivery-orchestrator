import { describe, expect, it } from "vitest";

import { CallbackWorker, RuntimeGenerationControl, type CallbackResolver } from "../src/runtime/v1/index.js";
import type { NormalizedGitHubEvent } from "../src/github/webhooks/v1/index.js";

const event: NormalizedGitHubEvent = { version: "github-webhook/v1", deliveryId: "8dc126aa-dfd8-4c95-8e4d-25c00800721d", eventName: "workflow_run", action: "completed", hookId: 8, installationId: 9, repository: "todd-brunia/ai-delivery-orchestrator", senderLogin: "untrusted", workflowRunId: 81, payloadSha256: "a".repeat(64), receivedAt: "2026-08-31T12:00:00.000Z" };
const resolver: CallbackResolver = { locate: () => Promise.resolve("work-item-81"), resolve: () => Promise.resolve({ runId: "run-81", revision: 0, runRevision: 0, observedAt: event.receivedAt, artifacts: [], workItemId: "work-item-81", state: "build_dispatched", binding: { repository: event.repository!, hookId: 8, installationId: 9, issueNodeId: "I_81", planningFingerprint: "b".repeat(64), automationMarker: "marker:81", expectedBranch: "automation/81", expectedBaseSha: "c".repeat(40), acceptedWorkflowRunId: "81" }, observation: { repository: event.repository!, hookId: 8, installationId: 9, issueNodeId: "I_81", planningFingerprint: "b".repeat(64), automationMarker: "marker:81", branch: "automation/81", baseSha: "c".repeat(40), workflowRunId: "81", workflowCompleted: true } }) };

describe("callback worker", () => {
  it("claims a bounded FIFO batch, leases the item, and commits canonical catch-up", async () => {
    const commits: unknown[] = []; let retried = false;
    const worker = new CallbackWorker(new RuntimeGenerationControl(), { claim: () => Promise.resolve([{ event, attemptCount: 1 }]), retry: () => { retried = true; return Promise.resolve("pending" as const); } }, { tryAcquireLease: () => Promise.resolve(true) }, resolver, { commit: (value) => { commits.push(value); return Promise.resolve({ duplicate: false }); } }, { ownerId: "worker-a", configurationVersion: "config:1", maxBatch: 1, maxAttempts: 3, leaseMilliseconds: 60_000 }, () => new Date("2026-08-31T12:00:00Z"));
    await expect(worker.drainOnce()).resolves.toEqual(["completed"]);
    expect(commits).toHaveLength(1);
    const committed = commits[0] as { readonly events: readonly string[]; readonly semanticKey: string };
    expect(committed.events).toEqual(["build_started"]);
    expect(committed.semanticKey).toContain("callback:v1:work-item-81");
    expect(retried).toBe(false);
  });

  it("does not claim while draining and retries canonical/lease failures without a commit", async () => {
    const control = new RuntimeGenerationControl(); control.drain(0); const calls: string[] = [];
    const worker = new CallbackWorker(control, { claim: () => { calls.push("claim"); return Promise.resolve([]); }, retry: () => Promise.resolve("pending" as const) }, { tryAcquireLease: () => Promise.resolve(false) }, resolver, { commit: () => Promise.resolve({ duplicate: false }) }, { ownerId: "worker-a", configurationVersion: "config:1", maxBatch: 2, maxAttempts: 3, leaseMilliseconds: 60_000 });
    await expect(worker.drainOnce()).resolves.toEqual([]); expect(calls).toEqual([]);
  });

  it("does not commit a canonical response received after the delivery deadline", async () => {
    let clock = new Date("2026-08-31T12:00:00Z"); let commits = 0;
    const slow: CallbackResolver = { locate: (event) => resolver.locate(event), resolve: async (input) => { const value = await resolver.resolve(input); clock = new Date(clock.getTime() + 120_000); return value; } };
    const worker = new CallbackWorker(new RuntimeGenerationControl(), { claim: () => Promise.resolve([{ event, attemptCount: 1 }]), retry: () => Promise.resolve("not_owned" as const) },
      { tryAcquireLease: () => Promise.resolve(true) }, slow, { commit: () => { commits++; return Promise.resolve({ duplicate: false }); } },
      { ownerId: "deadline", configurationVersion: "config:1", maxBatch: 1, maxAttempts: 3, leaseMilliseconds: 60_000 }, () => clock);
    expect(await worker.drainOnce()).toEqual(["retrying"]);
    expect(commits).toBe(0);
  });

  it("does not persist provider exception messages on retries", async () => {
    const errors: string[] = [];
    const worker = new CallbackWorker(new RuntimeGenerationControl(), { claim: () => Promise.resolve([{ event, attemptCount: 1 }]), retry: (_delivery, _owner, reason) => { errors.push(reason); return Promise.resolve("pending" as const); } },
      { tryAcquireLease: () => Promise.resolve(true) }, { locate: (event) => resolver.locate(event), resolve: () => Promise.reject(new Error("sk-secret hostile private source")) }, { commit: () => Promise.reject(new Error("must not commit")) },
      { ownerId: "redaction", configurationVersion: "config:1", maxBatch: 1, maxAttempts: 3, leaseMilliseconds: 60_000 });
    expect(await worker.drainOnce()).toEqual(["retrying"]);
    expect(errors).toEqual(["callback_processing_failed"]);
  });
});
