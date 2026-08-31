import { describe, expect, it } from "vitest";

import { CallbackWorker, RuntimeGenerationControl, type CallbackResolver } from "../src/runtime/v1/index.js";
import type { NormalizedGitHubEvent } from "../src/github/webhooks/v1/index.js";

const event: NormalizedGitHubEvent = { version: "github-webhook/v1", deliveryId: "8dc126aa-dfd8-4c95-8e4d-25c00800721d", eventName: "workflow_run", action: "completed", hookId: 8, installationId: 9, repository: "todd-brunia/ai-delivery-orchestrator", senderLogin: "untrusted", workflowRunId: 81, payloadSha256: "a".repeat(64), receivedAt: "2026-08-31T12:00:00.000Z" };
const resolver: CallbackResolver = { resolve: () => Promise.resolve({ workItemId: "work-item-81", state: "build_dispatched", binding: { repository: event.repository!, hookId: 8, installationId: 9, issueNodeId: "I_81", planningFingerprint: "b".repeat(64), automationMarker: "marker:81", expectedBranch: "automation/81", expectedBaseSha: "c".repeat(40), acceptedWorkflowRunId: "81" }, observation: { repository: event.repository!, hookId: 8, installationId: 9, issueNodeId: "I_81", planningFingerprint: "b".repeat(64), automationMarker: "marker:81", branch: "automation/81", baseSha: "c".repeat(40), workflowRunId: "81", workflowCompleted: true } }) };

describe("callback worker", () => {
  it("claims a bounded FIFO batch, leases the item, and commits canonical catch-up", async () => {
    const commits: unknown[] = []; let retried = false;
    const worker = new CallbackWorker(new RuntimeGenerationControl(), { claim: () => Promise.resolve([{ event, attemptCount: 1 }]), retry: () => { retried = true; return Promise.resolve("pending" as const); } }, { tryAcquireLease: () => Promise.resolve(true) }, resolver, { commit: (value) => { commits.push(value); return Promise.resolve({ duplicate: false }); } }, { ownerId: "worker-a", configurationVersion: "config:1", maxBatch: 2, maxAttempts: 3, leaseMilliseconds: 60_000 }, () => new Date("2026-08-31T12:00:00Z"));
    await expect(worker.drainOnce()).resolves.toEqual(["completed"]);
    expect(commits).toHaveLength(1);
    const committed = commits[0] as { readonly events: readonly string[]; readonly semanticKey: string };
    expect(committed.events).toEqual(["build_started"]);
    expect(committed.semanticKey).toContain("build_started");
    expect(retried).toBe(false);
  });

  it("does not claim while draining and retries canonical/lease failures without a commit", async () => {
    const control = new RuntimeGenerationControl(); control.drain(0); const calls: string[] = [];
    const worker = new CallbackWorker(control, { claim: () => { calls.push("claim"); return Promise.resolve([]); }, retry: () => Promise.resolve("pending" as const) }, { tryAcquireLease: () => Promise.resolve(false) }, resolver, { commit: () => Promise.resolve({ duplicate: false }) }, { ownerId: "worker-a", configurationVersion: "config:1", maxBatch: 2, maxAttempts: 3, leaseMilliseconds: 60_000 });
    await expect(worker.drainOnce()).resolves.toEqual([]); expect(calls).toEqual([]);
  });
});
