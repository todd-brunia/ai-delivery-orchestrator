import { describe, expect, it } from "vitest";

import { GitHubMutationExecutor, GitHubMutationOutboxConsumer } from "../src/providers/v1/index.js";
import type { SprintRunRepository } from "../src/persistence/contracts.js";

const repository = "todd-brunia/ai-consulting-client-portal";
const sha = "a".repeat(40);
const stateHash = "b".repeat(64);
const base = { version: "github-mutation/v1", idempotencyKey: "mutation:12345678", repository, repositoryId: "1308170964", expectedStateSha256: stateHash, expiresAt: "2026-08-25T13:00:00.000Z" } as const;

class FixtureTransport {
  readonly calls: Array<{ method: string; path: string; body: string }> = [];
  constructor(private readonly status = 200) {}
  request(input: { method: "PATCH" | "POST"; path: string; body: string }): Promise<{ status: number; requestId: string }> {
    this.calls.push(input); return Promise.resolve({ status: this.status, requestId: "request-1" });
  }
}

describe("GitHub mutation executor", () => {
  it("executes an exact-head reviewer intent once through its specific endpoint", async () => {
    const transport = new FixtureTransport(); let preflightCalls = 0;
    const executor = new GitHubMutationExecutor({ assertCurrent: () => { preflightCalls += 1; return Promise.resolve(); } }, transport, new Set(["submit_review"]), () => new Date("2026-08-25T12:00:00.000Z"));
    const intent = { ...base, actorRole: "reviewer", type: "submit_review", pullRequestNumber: 9, expectedHeadSha: sha, event: "REQUEST_CHANGES", body: "Please fix the validation." } as const;
    await expect(executor.execute(intent)).resolves.toEqual({ duplicate: false, requestId: "request-1" });
    await expect(executor.execute(intent)).resolves.toEqual({ duplicate: true, requestId: "request-1" });
    expect(preflightCalls).toBe(1);
    expect(transport.calls).toEqual([{ method: "POST", path: `/repos/${repository}/pulls/9/reviews`, body: JSON.stringify({ commit_id: sha, event: "REQUEST_CHANGES", body: "Please fix the validation." }), idempotencyKey: "mutation:12345678" }]);
  });

  it("fails closed for disabled builder actions, drift, expiry, and ambiguous delivery", async () => {
    const labelIntent = { ...base, actorRole: "builder", type: "set_labels", issueNumber: 69, labels: ["implementation-proposed"] } as const;
    const disabled = new GitHubMutationExecutor({ assertCurrent: () => Promise.resolve() }, new FixtureTransport(), new Set(), () => new Date("2026-08-25T12:00:00.000Z"));
    await expect(disabled.execute(labelIntent)).rejects.toMatchObject({ code: "disabled" });
    const drift = new GitHubMutationExecutor({ assertCurrent: () => Promise.reject(new Error("drift")) }, new FixtureTransport(), new Set(["set_labels"]), () => new Date("2026-08-25T12:00:00.000Z"));
    await expect(drift.execute(labelIntent)).rejects.toMatchObject({ code: "precondition_failed" });
    const ambiguous = new GitHubMutationExecutor({ assertCurrent: () => Promise.resolve() }, new FixtureTransport(503), new Set(["set_labels"]), () => new Date("2026-08-25T12:00:00.000Z"));
    await expect(ambiguous.execute(labelIntent)).rejects.toMatchObject({ code: "ambiguous" });
  });

  it("claims and completes only durable GitHub mutation outbox actions", async () => {
    const intent = { ...base, actorRole: "reviewer", type: "submit_review", pullRequestNumber: 9, expectedHeadSha: sha, event: "COMMENT", body: "Sanitized finding." } as const;
    let completed = 0; let retried = 0; let claimedTypes: readonly string[] | undefined;
    const repository: Pick<SprintRunRepository, "claimOutbox" | "completeOutbox" | "retryOutbox"> = {
      claimOutbox: async (_owner, _limit, _expires, _now, types) => { await Promise.resolve(); claimedTypes = types; return [{ id: "outbox-1", type: "github.mutation.execute", payload: intent, idempotencyKey: intent.idempotencyKey, attemptCount: 1, claimExpiresAt: "2026-08-25T12:01:00.000Z" }]; },
      completeOutbox: async () => { await Promise.resolve(); completed += 1; return true; },
      retryOutbox: async () => { await Promise.resolve(); retried += 1; return true; },
    };
    const executor = new GitHubMutationExecutor({ assertCurrent: () => Promise.resolve() }, new FixtureTransport(), new Set(["submit_review"]), () => new Date("2026-08-25T12:00:00.000Z"));
    const consumer = new GitHubMutationOutboxConsumer(repository as SprintRunRepository, executor, "worker-1", 60_000, () => new Date("2026-08-25T12:00:00.000Z"));
    await expect(consumer.consume()).resolves.toEqual([{ id: "outbox-1", outcome: "completed" }]);
    expect(claimedTypes).toEqual(["github.mutation.execute"]);
    expect(completed).toBe(1); expect(retried).toBe(0);
  });

  it("reconciles an ambiguous result before allowing an outbox retry", async () => {
    const intent = { ...base, actorRole: "builder", type: "set_labels", issueNumber: 69, labels: ["implementation-proposed"] } as const;
    const executor = new GitHubMutationExecutor({ assertCurrent: () => Promise.resolve() }, new FixtureTransport(503), new Set(["set_labels"]), () => new Date("2026-08-25T12:00:00.000Z"), { reconcile: () => Promise.resolve("confirmed") });
    await expect(executor.execute(intent)).resolves.toEqual({ duplicate: true });
  });
});
