import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleWebhookHttp } from "../src/github/webhooks/v1/index.js";

const secret = "synthetic-secret";
const body = JSON.stringify({ action: "opened", installation: { id: 1 }, sender: { login: "bot" }, repository: { full_name: "owner/repo" }, issue: { number: 2 } });
const request = (signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`) => ({ body, headers: {
  "X-GitHub-Delivery": randomUUID(), "X-GitHub-Event": "issues", "X-GitHub-Hook-ID": "7", "X-Hub-Signature-256": signature,
} });

describe("webhook HTTP ingress", () => {
  it("verifies before enqueueing and returns only a bounded receipt", async () => {
    const seen: unknown[] = [];
    const result = await handleWebhookHttp(request(), { loadSecret: () => Promise.resolve(secret), enqueue: (event) => { seen.push(event); return Promise.resolve("accepted"); } });
    expect(result).toMatchObject({ statusCode: 202, body: '{"result":"accepted"}' });
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toContain(body);
  });
  it("rejects a forged signature without enqueueing", async () => {
    let called = false;
    const result = await handleWebhookHttp(request(`sha256=${"0".repeat(64)}`), { loadSecret: () => Promise.resolve(secret), enqueue: () => { called = true; return Promise.resolve("accepted"); } });
    expect(result.statusCode).toBe(401);
    expect(called).toBe(false);
  });
});
