import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { GitHubAppReadAdapter } from "../src/providers/v1/index.js";
import type { GitHubReadError } from "../src/providers/v1/index.js";

const repository = "todd-brunia/ai-consulting-client-portal";
const sha = "a".repeat(40);
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs1" }).toString();
const config = { version: "github-read/v1", repository, repositoryId: "1308170964", appId: "4545788", installationId: "152627422", installationAccount: "todd-brunia", apiBaseUrl: "https://api.github.com", apiVersion: "2022-11-28", maxPages: 2, maxItems: 10, maxResponseBytes: 10_000, timeoutMilliseconds: 1_000, tokenTtlSeconds: 600 } as const;

class FixtureTransport {
  readonly calls: Array<{ method: string; url: string; headers: Readonly<Record<string, string>> }> = [];
  constructor(private readonly responses: Record<string, { status: number; body: unknown; headers?: Record<string, string> }>) {}
  request(input: { method: "GET" | "POST"; url: string; headers: Readonly<Record<string, string>> }): Promise<{ status: number; body: string; headers: Readonly<Record<string, string>> }> {
    this.calls.push(input); const response = this.responses[`${input.method} ${input.url}`] ?? { status: 404, body: {} };
    return Promise.resolve({ status: response.status, body: JSON.stringify(response.body), headers: response.headers ?? {} });
  }
}

function adapter(transport: FixtureTransport): GitHubAppReadAdapter {
  return new GitHubAppReadAdapter(config, "ai-delivery-orchestrator/pilot/github-app-reviewer-private-key", { load: () => Promise.resolve(privateKey) }, transport, () => new Date("2026-08-25T12:00:00.000Z"));
}

describe("GitHub App canonical read adapter", () => {
  it("uses a short-lived installation token, bounds results, and returns canonical observations", async () => {
    const transport = new FixtureTransport({
      "POST https://api.github.com/app/installations/152627422/access_tokens": { status: 201, body: { token: "installation-token", expires_at: "2026-08-25T13:00:00.000Z" } },
      [`GET https://api.github.com/repos/${repository}/issues/69`]: { status: 200, body: { node_id: "I_69", title: "Read", body: "untrusted", state: "open", labels: [{ name: "approved-for-build" }], updated_at: "2026-08-25T11:00:00Z" } },
      [`GET https://api.github.com/repos/${repository}/issues/69/comments?per_page=10`]: { status: 200, body: [{ id: 99, body: "<!-- codex-implementation-plan -->\nplan", created_at: "2026-08-25T10:00:00Z", updated_at: "2026-08-25T10:00:00Z" }] },
      [`GET https://api.github.com/repos/${repository}/commits/${sha}/check-runs?per_page=10`]: { status: 200, body: { check_runs: [{ id: 4, name: "CI Gate", status: "completed", conclusion: "success" }] } },
    });
    const client = adapter(transport);
    await expect(client.getIssue(repository, 69)).resolves.toMatchObject({ number: 69, labels: ["approved-for-build"] });
    await expect(client.getMarkedPlan(repository, 69)).resolves.toMatchObject({ commentId: "99" });
    await expect(client.getChecks(repository, sha)).resolves.toEqual([expect.objectContaining({ name: "CI Gate", headSha: sha })]);
    expect(transport.calls).toHaveLength(4);
    expect(transport.calls[1]!.headers.authorization).toBe("Bearer installation-token");
    expect(transport.calls[0]!.headers.authorization).not.toContain(privateKey);
  });

  it("fails closed for a cross-repository request and ambiguous plans", async () => {
    const transport = new FixtureTransport({
      "POST https://api.github.com/app/installations/152627422/access_tokens": { status: 201, body: { token: "installation-token", expires_at: "2026-08-25T13:00:00.000Z" } },
      [`GET https://api.github.com/repos/${repository}/issues/69/comments?per_page=10`]: { status: 200, body: [{ id: 1, body: "<!-- codex-implementation-plan -->\na", created_at: "2026-08-25T10:00:00Z", updated_at: "2026-08-25T10:00:00Z" }, { id: 2, body: "<!-- codex-implementation-plan -->\nb", created_at: "2026-08-25T10:00:00Z", updated_at: "2026-08-25T10:00:00Z" }] },
    });
    const client = adapter(transport);
    await expect(client.getIssue("other/repository", 69)).rejects.toMatchObject({ code: "authorization" } satisfies Partial<GitHubReadError>);
    await expect(client.getMarkedPlan(repository, 69)).rejects.toMatchObject({ code: "invalid_response" } satisfies Partial<GitHubReadError>);
  });
});
