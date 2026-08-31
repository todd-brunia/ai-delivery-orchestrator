import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GITHUB_WEBHOOK_VERSION, type NormalizedGitHubEvent } from "../../src/github/webhooks/v1/index.js";
import { migrate, PostgresWebhookInbox } from "../../src/persistence/index.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");
const pool = new Pool({ connectionString });
const inbox = new PostgresWebhookInbox(pool);
const event = (deliveryId = randomUUID()): NormalizedGitHubEvent => ({ version: GITHUB_WEBHOOK_VERSION, deliveryId, eventName: "issues", action: "labeled", hookId: 123, installationId: 42, repository: "todd-brunia/ai-consulting-client-portal", senderLogin: "octocat", issueNumber: 81, payloadSha256: "a".repeat(64), receivedAt: "2026-08-01T12:00:00.000Z" });

beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE orchestrator.github_callback_results, orchestrator.github_webhook_inbox"));
afterAll(async () => pool.end());

describe("PostgresWebhookInbox", () => {
  it("deduplicates matching deliveries and rejects fingerprint reuse", async () => {
    const delivery = event();
    await expect(inbox.accept(delivery)).resolves.toMatchObject({ duplicate: false });
    await expect(inbox.accept(delivery)).resolves.toMatchObject({ duplicate: true });
    await expect(inbox.accept({ ...delivery, payloadSha256: "b".repeat(64) })).rejects.toThrow("fingerprint");
    const stored = await pool.query<{ normalized_event: unknown }>("SELECT normalized_event FROM orchestrator.github_webhook_inbox");
    expect(JSON.stringify(stored.rows[0])).not.toContain("rawBody");
  });

  it("claims exclusively, recovers expiry, and completes only for the owner", async () => {
    await inbox.accept(event());
    const now = new Date("2026-08-01T12:00:00Z");
    const [first, competing] = await Promise.all([
      inbox.claim("worker-a", 1, new Date("2026-08-01T12:01:00Z"), 3, now),
      inbox.claim("worker-b", 1, new Date("2026-08-01T12:01:00Z"), 3, now),
    ]);
    expect(first.length + competing.length).toBe(1);
    const owner = first.length === 1 ? "worker-a" : "worker-b";
    const original = first[0] ?? competing[0]!;
    const recoveryOwner = owner === "worker-a" ? "worker-b" : "worker-a";
    const recovered = await inbox.claim(recoveryOwner, 1, new Date("2026-08-01T12:03:00Z"), 3, new Date("2026-08-01T12:02:00Z"));
    expect(recovered[0]?.attemptCount).toBe(2);
    expect(await inbox.complete(original.event.deliveryId, owner, new Date("2026-08-01T12:02:30Z"))).toBe(false);
    expect(await inbox.complete(recovered[0]!.event.deliveryId, recoveryOwner, new Date("2026-08-01T12:02:30Z"))).toBe(true);
  });

  it("dead-letters at the bounded retry limit", async () => {
    const delivery = event(); await inbox.accept(delivery);
    const now = new Date("2026-08-01T12:00:00Z");
    await inbox.claim("worker", 1, new Date("2026-08-01T12:01:00Z"), 1, now);
    await expect(inbox.retry(delivery.deliveryId, "worker", "failed", 1, now)).resolves.toBe("dead_letter");
    await expect(inbox.claim("other", 1, new Date("2026-08-01T12:02:00Z"), 1, now)).resolves.toHaveLength(0);
  });

  it("atomically records sanitized callback evidence and completes a claimed delivery", async () => {
    const delivery = event();
    await inbox.accept(delivery);
    const now = new Date("2026-08-01T12:00:00Z");
    await inbox.claim("callback-worker", 1, new Date("2026-08-01T12:01:00Z"), 3, now);
    await expect(inbox.commitResult({ deliveryId: delivery.deliveryId, deliveryLeaseOwner: "callback-worker", disposition: "ignored", reasonClass: "unsupported_action", evidence: { eventName: "issues", payloadSha256: delivery.payloadSha256 }, recordedAt: now.toISOString() }, now)).resolves.toEqual({ duplicate: false });
    const persisted = await pool.query<{ status: string; evidence: unknown }>(`SELECT i.status, r.evidence
      FROM orchestrator.github_webhook_inbox i JOIN orchestrator.github_callback_results r USING (delivery_id)
      WHERE i.delivery_id = $1`, [delivery.deliveryId]);
    expect(persisted.rows[0]?.status).toBe("completed");
    expect(JSON.stringify(persisted.rows[0]?.evidence)).not.toContain("rawBody");
    await expect(inbox.commitResult({ deliveryId: delivery.deliveryId, deliveryLeaseOwner: "callback-worker", disposition: "ignored", reasonClass: "unsupported_action", evidence: {}, recordedAt: now.toISOString() }, now)).rejects.toThrow("lease");
  });

  it("rejects webhook-body-shaped callback evidence before persistence", async () => {
    const delivery = event();
    await inbox.accept(delivery);
    const now = new Date("2026-08-01T12:00:00Z");
    await inbox.claim("callback-worker", 1, new Date("2026-08-01T12:01:00Z"), 3, now);
    await expect(inbox.commitResult({ deliveryId: delivery.deliveryId, deliveryLeaseOwner: "callback-worker", disposition: "blocked", reasonClass: "malformed_payload", evidence: { rawBody: "hostile untrusted content" }, recordedAt: now.toISOString() }, now)).rejects.toThrow("invalid callback result");
    await expect(pool.query("SELECT count(*) FROM orchestrator.github_callback_results WHERE delivery_id = $1", [delivery.deliveryId])).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });
});
