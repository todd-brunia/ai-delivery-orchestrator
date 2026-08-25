import { createHash, createSign } from "node:crypto";

import {
  CanonicalCheckSchema,
  CanonicalIssueSchema,
  CanonicalPlanSchema,
  CanonicalPullRequestSchema,
  GitHubReadConfigV1Schema,
  type CanonicalCheck,
  type CanonicalIssue,
  type CanonicalPlan,
  type CanonicalPullRequest,
  type GitHubReadConfigV1,
} from "./contracts.js";
import type { GitHubReadPort } from "./ports.js";

const planMarker = "<!-- codex-implementation-plan -->";

export class GitHubReadError extends Error {
  constructor(readonly code: "authentication" | "authorization" | "not_found" | "rate_limited" | "timeout" | "transport" | "response_bounds" | "invalid_response", message: string) { super(message); }
}

export interface GitHubPrivateKeySource { load(secretReference: string): Promise<string>; }
export interface GitHubHttpResponse { readonly status: number; readonly headers: Readonly<Record<string, string | undefined>>; readonly body: string; }
export interface GitHubHttpTransport { request(input: { method: "GET" | "POST"; url: string; headers: Readonly<Record<string, string>>; body?: string; timeoutMilliseconds: number }): Promise<GitHubHttpResponse>; }

const base64url = (value: string | Buffer): string => Buffer.from(value).toString("base64url");
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const iso = (value: unknown): string => new Date(String(value)).toISOString();

function githubPath(config: GitHubReadConfigV1, path: string): string {
  return `${config.apiBaseUrl}${path}`;
}

/** A narrow GitHub App reader. It deliberately exposes no generic REST client or mutation method. */
export class GitHubAppReadAdapter implements GitHubReadPort {
  private token: { value: string; expiresAt: number } | undefined;

  constructor(
    rawConfig: unknown,
    private readonly secretReference: string,
    private readonly keys: GitHubPrivateKeySource,
    private readonly transport: GitHubHttpTransport,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.config = GitHubReadConfigV1Schema.parse(rawConfig);
    if (!/^ai-delivery-orchestrator\/pilot\/github-app-(builder|reviewer)-private-key$/.test(secretReference)) throw new Error("GitHub secret reference is not role-specific");
  }

  private readonly config: GitHubReadConfigV1;

  private async installationToken(): Promise<string> {
    if (this.token && this.token.expiresAt - this.now().getTime() > 30_000) return this.token.value;
    const key = await this.keys.load(this.secretReference);
    if (!key.includes("BEGIN") || key.length > 20_000) throw new GitHubReadError("authentication", "GitHub App key is unavailable");
    const issuedAt = Math.floor(this.now().getTime() / 1000) - 30;
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: this.config.appId }));
    const signer = createSign("RSA-SHA256"); signer.update(`${header}.${payload}`); signer.end();
    const jwt = `${header}.${payload}.${signer.sign(key).toString("base64url")}`;
    const response = await this.transport.request({ method: "POST", url: githubPath(this.config, `/app/installations/${this.config.installationId}/access_tokens`), headers: this.headers(jwt), body: JSON.stringify({ repositories: [this.config.repository.split("/")[1]], permissions: { metadata: "read" } }), timeoutMilliseconds: this.config.timeoutMilliseconds });
    const parsed = this.parse(response) as { token?: unknown; expires_at?: unknown };
    if (typeof parsed.token !== "string" || typeof parsed.expires_at !== "string") throw new GitHubReadError("invalid_response", "GitHub token response is incomplete");
    const expiresAt = Date.parse(parsed.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now().getTime()) throw new GitHubReadError("invalid_response", "GitHub token expiry is invalid");
    this.token = { value: parsed.token, expiresAt };
    return parsed.token;
  }

  private headers(token: string): Record<string, string> { return { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": this.config.apiVersion, "user-agent": "ai-delivery-orchestrator/github-read-v1" }; }

  private parse(response: GitHubHttpResponse): unknown {
    if (Buffer.byteLength(response.body, "utf8") > this.config.maxResponseBytes) throw new GitHubReadError("response_bounds", "GitHub response exceeds configured bound");
    if (response.status === 401) throw new GitHubReadError("authentication", "GitHub authentication failed");
    if (response.status === 403) throw new GitHubReadError(response.headers["x-ratelimit-remaining"] === "0" ? "rate_limited" : "authorization", "GitHub request was denied");
    if (response.status === 404) throw new GitHubReadError("not_found", "GitHub resource is unavailable");
    if (response.status < 200 || response.status >= 300) throw new GitHubReadError("transport", `GitHub returned HTTP ${response.status}`);
    try { return JSON.parse(response.body) as unknown; } catch { throw new GitHubReadError("invalid_response", "GitHub response was not valid JSON"); }
  }

  private async get(path: string): Promise<unknown> { const token = await this.installationToken(); return this.parse(await this.transport.request({ method: "GET", url: githubPath(this.config, path), headers: this.headers(token), timeoutMilliseconds: this.config.timeoutMilliseconds })); }
  private assertRepository(repository: string): void { if (repository !== this.config.repository) throw new GitHubReadError("authorization", "repository is outside configured audience"); }

  async getIssue(repository: string, number: number): Promise<CanonicalIssue> {
    this.assertRepository(repository); const item = await this.get(`/repos/${repository}/issues/${number}`) as Record<string, unknown>;
    const body = typeof item.body === "string" ? item.body.slice(0, 100_000) : "";
    return CanonicalIssueSchema.parse({ version: "providers/v1", repository, number, nodeId: item.node_id, title: item.title, body, state: item.state, labels: Array.isArray(item.labels) ? item.labels.map((label) => typeof label === "string" ? label : (label as { name?: unknown }).name).filter((label): label is string => typeof label === "string").slice(0, 100) : [], updatedAt: iso(item.updated_at) });
  }

  async getPullRequest(repository: string, number: number): Promise<CanonicalPullRequest> {
    this.assertRepository(repository); const item = await this.get(`/repos/${repository}/pulls/${number}`) as Record<string, unknown>; const base = item.base as { sha?: unknown } | undefined; const head = item.head as { sha?: unknown } | undefined;
    return CanonicalPullRequestSchema.parse({ version: "providers/v1", repository, number, nodeId: item.node_id, issueNumber: number, state: item.merged_at ? "merged" : item.state, draft: item.draft, baseSha: base?.sha, headSha: head?.sha, changedFiles: [], updatedAt: iso(item.updated_at) });
  }

  async getMarkedPlan(repository: string, number: number): Promise<CanonicalPlan> {
    this.assertRepository(repository); const comments = await this.get(`/repos/${repository}/issues/${number}/comments?per_page=${this.config.maxItems}`);
    if (!Array.isArray(comments) || comments.length >= this.config.maxItems) throw new GitHubReadError("response_bounds", "GitHub plan comments are incomplete");
    const plans = comments.filter((comment): comment is Record<string, unknown> => !!comment && typeof comment === "object" && typeof (comment as Record<string, unknown>).body === "string" && ((comment as Record<string, unknown>).body as string).includes(planMarker));
    if (plans.length !== 1) throw new GitHubReadError("invalid_response", "expected exactly one marked implementation plan");
    const plan = plans[0]!; const body = plan.body as string;
    return CanonicalPlanSchema.parse({ issueNumber: number, commentId: String(plan.id), bodySha256: digest(body), createdAt: iso(plan.created_at), updatedAt: iso(plan.updated_at), evidence: { uri: `github://issues/${repository}/${number}/comments/${String(plan.id)}`, observedAt: this.now().toISOString(), sha256: digest(body) } });
  }

  async getChecks(repository: string, headSha: string): Promise<readonly CanonicalCheck[]> {
    this.assertRepository(repository); const response = await this.get(`/repos/${repository}/commits/${headSha}/check-runs?per_page=${this.config.maxItems}`) as { check_runs?: unknown };
    if (!Array.isArray(response.check_runs) || response.check_runs.length >= this.config.maxItems) throw new GitHubReadError("response_bounds", "GitHub check list is incomplete");
    return response.check_runs.map((check) => { const item = check as Record<string, unknown>; return CanonicalCheckSchema.parse({ name: item.name, status: item.status, conclusion: item.conclusion ?? undefined, headSha, evidence: { uri: `github://checks/${repository}/${headSha}/${String(item.id)}`, observedAt: this.now().toISOString() } }); });
  }
}
