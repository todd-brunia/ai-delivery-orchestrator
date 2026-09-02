import { createHash, createSign } from "node:crypto";

import { z } from "zod";

import {
  CanonicalCheckSchema,
  CanonicalDiffSchema,
  CanonicalInstallationSchema,
  CanonicalIssueSchema,
  CanonicalHumanBuildApprovalSchema,
  CanonicalPlanSchema,
  CanonicalPullRequestSchema,
  CanonicalRepositoryConfigurationSchema,
  CanonicalReviewSchema,
  CanonicalWorkflowRunSchema,
  GitHubReadConfigV1Schema,
  type CanonicalCheck,
  type CanonicalDiff,
  type CanonicalInstallation,
  type CanonicalIssue,
  type CanonicalHumanBuildApproval,
  type CanonicalPlan,
  type CanonicalPullRequest,
  type CanonicalRepositoryConfiguration,
  type CanonicalReview,
  type CanonicalWorkflowRun,
  type GitHubReadConfigV1,
} from "./contracts.js";
import type { GitHubReadPort } from "./ports.js";

const planMarker = "<!-- codex-implementation-plan -->";

export class GitHubReadError extends Error {
  constructor(readonly code: "authentication" | "authorization" | "not_found" | "rate_limited" | "timeout" | "transport" | "response_bounds" | "invalid_response", message: string) { super(message); }
}

const GitHubReadValidationFieldSchema = z.enum([
  "repository", "repositoryId", "defaultBranch", "visibility", "allowSquashMerge",
  "archive", "configurationSha256", "evidence", "unknownField",
]);
const GitHubReadValidationReasonSchema = z.enum(["missing", "wrong_type", "invalid_value", "unknown_reason"]);
export const GitHubReadValidationFailureSchema = z.object({
  version: z.literal("github-read-validation-failure/v1"),
  field: GitHubReadValidationFieldSchema,
  reason: GitHubReadValidationReasonSchema,
}).strict();
export type GitHubReadValidationFailure = z.infer<typeof GitHubReadValidationFailureSchema>;

class GitHubReadValidationFailureError extends Error implements GitHubReadValidationFailure {
  readonly version = "github-read-validation-failure/v1" as const;

  constructor(readonly field: GitHubReadValidationFailure["field"], readonly reason: GitHubReadValidationFailure["reason"]) {
    super("canonical GitHub response failed validation");
  }
}

export function githubReadValidationFailure(error: unknown): GitHubReadValidationFailure | undefined {
  const parsed = GitHubReadValidationFailureSchema.safeParse(error);
  return parsed.success ? parsed.data : undefined;
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

  private appJwt(): Promise<string> {
    return this.keys.load(this.secretReference).then((key) => {
      if (!key.includes("BEGIN") || key.length > 20_000) throw new GitHubReadError("authentication", "GitHub App key is unavailable");
      const issuedAt = Math.floor(this.now().getTime() / 1000) - 30;
      const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
      const payload = base64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: this.config.appId }));
      const signer = createSign("RSA-SHA256"); signer.update(`${header}.${payload}`); signer.end();
      return `${header}.${payload}.${signer.sign(key).toString("base64url")}`;
    });
  }

  private async installationToken(): Promise<string> {
    if (this.token && this.token.expiresAt - this.now().getTime() > 30_000) return this.token.value;
    const jwt = await this.appJwt();
    const response = await this.transport.request({ method: "POST", url: githubPath(this.config, `/app/installations/${this.config.installationId}/access_tokens`), headers: this.headers(jwt), body: JSON.stringify({ repositories: [this.config.repository.split("/")[1]], permissions: this.config.requiredPermissions }), timeoutMilliseconds: this.config.timeoutMilliseconds });
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
  private evidence(uri: string, value?: string) { return { uri, observedAt: this.now().toISOString(), ...(value ? { sha256: digest(value) } : {}) }; }

  private async list(path: string): Promise<readonly unknown[]> {
    const items: unknown[] = [];
    let next: string | undefined = githubPath(this.config, path);
    for (let page = 0; next && page < this.config.maxPages; page += 1) {
      const token = await this.installationToken();
      const response = await this.transport.request({ method: "GET", url: next, headers: this.headers(token), timeoutMilliseconds: this.config.timeoutMilliseconds });
      const parsed = this.parse(response);
      if (!Array.isArray(parsed)) throw new GitHubReadError("invalid_response", "GitHub list response was not an array");
      items.push(...(parsed as unknown[]));
      if (items.length > this.config.maxItems) throw new GitHubReadError("response_bounds", "GitHub list exceeds configured item bound");
      const match = response.headers.link?.match(/<([^>]+)>;\s*rel="next"/);
      next = match?.[1];
      if (next) {
        const url = new URL(next);
        if (url.origin !== this.config.apiBaseUrl || !url.pathname.startsWith(`/repos/${this.config.repository}/`)) throw new GitHubReadError("authorization", "GitHub pagination escaped configured repository");
      }
    }
    if (next) throw new GitHubReadError("response_bounds", "GitHub pagination exceeds configured page bound");
    return items;
  }

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

  async getHumanBuildApprovals(repository: string, number: number): Promise<readonly CanonicalHumanBuildApproval[]> {
    this.assertRepository(repository);
    const events = await this.list(`/repos/${repository}/issues/${number}/events?per_page=${this.config.maxItems}`);
    return events.flatMap((raw) => {
      const item = raw as Record<string, unknown>; const label = item.label as Record<string, unknown> | undefined; const actor = item.actor as Record<string, unknown> | undefined;
      if (item.event !== "labeled" || label?.name !== "approved-for-build" || actor?.type !== "User") return [];
      return [CanonicalHumanBuildApprovalSchema.parse({ issueNumber: number, label: "approved-for-build", actorLogin: actor.login, actorType: "User", occurredAt: iso(item.created_at), evidence: this.evidence(`github://issues/${repository}/${number}/events/${String(item.id)}`) })];
    });
  }

  async getChecks(repository: string, headSha: string): Promise<readonly CanonicalCheck[]> {
    this.assertRepository(repository); const response = await this.get(`/repos/${repository}/commits/${headSha}/check-runs?per_page=${this.config.maxItems}`) as { check_runs?: unknown };
    if (!Array.isArray(response.check_runs) || response.check_runs.length >= this.config.maxItems) throw new GitHubReadError("response_bounds", "GitHub check list is incomplete");
    return response.check_runs.map((check) => { const item = check as Record<string, unknown>; return CanonicalCheckSchema.parse({ name: item.name, status: item.status, conclusion: item.conclusion ?? undefined, headSha, evidence: { uri: `github://checks/${repository}/${headSha}/${String(item.id)}`, observedAt: this.now().toISOString() } }); });
  }

  async getExactDiff(repository: string, baseSha: string, headSha: string): Promise<CanonicalDiff> {
    this.assertRepository(repository);
    const response = await this.get(`/repos/${repository}/compare/${baseSha}...${headSha}`) as Record<string, unknown>;
    if (!Array.isArray(response.files) || response.files.length > 500) throw new GitHubReadError("response_bounds", "GitHub diff files are incomplete");
    const files = response.files.map((raw) => {
      const item = raw as Record<string, unknown>;
      return { path: item.filename, status: item.status, ...(typeof item.previous_filename === "string" ? { previousPath: item.previous_filename } : {}), ...(typeof item.patch === "string" ? { patch: item.patch } : {}) };
    });
    const bytes = JSON.stringify({ baseSha, headSha, files });
    return CanonicalDiffSchema.parse({ repository, baseSha, headSha, sha256: digest(bytes), files, evidence: this.evidence(`github://compare/${repository}/${baseSha}...${headSha}`, bytes) });
  }

  async getReviews(repository: string, pullRequestNumber: number): Promise<readonly CanonicalReview[]> {
    this.assertRepository(repository);
    const reviews = await this.list(`/repos/${repository}/pulls/${pullRequestNumber}/reviews?per_page=${this.config.maxItems}`);
    return reviews.map((raw) => {
      const item = raw as Record<string, unknown>; const user = item.user as Record<string, unknown> | undefined;
      return CanonicalReviewSchema.parse({ id: String(item.id), pullRequestNumber, headSha: item.commit_id, state: item.state, submittedAt: item.submitted_at ?? undefined, authorLogin: user?.login, evidence: this.evidence(`github://reviews/${repository}/${String(item.id)}`) });
    });
  }

  async getWorkflowRuns(repository: string, headSha: string): Promise<readonly CanonicalWorkflowRun[]> {
    this.assertRepository(repository);
    const response = await this.get(`/repos/${repository}/actions/runs?head_sha=${headSha}&per_page=${this.config.maxItems}`) as Record<string, unknown>;
    if (!Array.isArray(response.workflow_runs) || response.workflow_runs.length >= this.config.maxItems) throw new GitHubReadError("response_bounds", "GitHub workflow runs are incomplete");
    return response.workflow_runs.map((raw) => {
      const item = raw as Record<string, unknown>;
      return CanonicalWorkflowRunSchema.parse({ id: String(item.id), workflowId: String(item.workflow_id), workflowPath: item.path, event: item.event, status: item.status, conclusion: item.conclusion ?? null, headSha: item.head_sha, createdAt: iso(item.created_at), updatedAt: iso(item.updated_at), evidence: this.evidence(`github://workflow-runs/${repository}/${String(item.id)}`) });
    });
  }

  async getRepositoryConfiguration(repository: string): Promise<CanonicalRepositoryConfiguration> {
    this.assertRepository(repository);
    const item = await this.get(`/repos/${repository}`) as Record<string, unknown>;
    const snapshot = JSON.stringify({ id: item.id, default_branch: item.default_branch, visibility: item.visibility, allow_squash_merge: item.allow_squash_merge, archived: item.archived });
    const raw: Record<string, unknown> = { repository, repositoryId: String(item.id), defaultBranch: item.default_branch, visibility: item.visibility, allowSquashMerge: item.allow_squash_merge, archive: item.archived, configurationSha256: digest(snapshot), evidence: this.evidence(`github://repositories/${repository}/configuration`, snapshot) };
    const parsed = CanonicalRepositoryConfigurationSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    const issue = parsed.error.issues[0];
    const segment = issue?.path[0];
    const fieldResult = GitHubReadValidationFieldSchema.safeParse(segment);
    const field = fieldResult.success ? fieldResult.data : "unknownField";
    const input = field !== "unknownField" ? raw[field] : undefined;
    const reason = issue?.code === "invalid_type"
      ? (input === undefined ? "missing" : "wrong_type")
      : issue && ["invalid_value", "invalid_format", "too_big", "too_small", "not_multiple_of"].includes(issue.code)
        ? "invalid_value"
        : "unknown_reason";
    const failure = new GitHubReadValidationFailureError(field, reason);
    Object.freeze(failure);
    throw failure;
  }

  async getInstallation(repository: string): Promise<CanonicalInstallation> {
    this.assertRepository(repository);
    const jwt = await this.appJwt();
    const response = await this.transport.request({ method: "GET", url: githubPath(this.config, `/app/installations/${this.config.installationId}`), headers: this.headers(jwt), timeoutMilliseconds: this.config.timeoutMilliseconds });
    const item = this.parse(response) as Record<string, unknown>; const account = item.account as Record<string, unknown> | undefined;
    const permissions = item.permissions as Record<string, unknown> | undefined;
    const selected = await this.get(`/installation/repositories?per_page=${this.config.maxItems}`) as Record<string, unknown>;
    const repositories = selected.repositories;
    if (!Array.isArray(repositories) || !repositories.some((raw) => {
      const value = raw as Record<string, unknown>;
      return String(value.id) === this.config.repositoryId && value.full_name === repository;
    })) throw new GitHubReadError("authorization", "GitHub installation does not select configured repository");
    const observedPermissions: Record<string, string> = Object.fromEntries(Object.entries(permissions ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const satisfies = (required: string, observed: string | undefined) => observed === required || (required === "read" && observed === "write");
    if (String(item.app_id) !== this.config.appId || account?.login !== this.config.installationAccount || Object.entries(this.config.requiredPermissions).some(([name, level]) => !satisfies(level, observedPermissions[name]))) throw new GitHubReadError("authorization", "GitHub installation identity or permissions drifted");
    return CanonicalInstallationSchema.parse({ appId: this.config.appId, installationId: String(item.id), accountLogin: account?.login, repositoryId: this.config.repositoryId, repository, permissions: observedPermissions, evidence: this.evidence(`github://installations/${this.config.installationId}`) });
  }

  /** Narrow canonical control used by the supervised operator; it cannot select another repository or path. */
  async getDefaultBranchHead(repository: string, branch: string): Promise<{ readonly sha: string; readonly evidenceUri: string }> {
    this.assertRepository(repository);
    const configuration = await this.getRepositoryConfiguration(repository);
    if (branch !== configuration.defaultBranch) throw new GitHubReadError("authorization", "branch is not the canonical default branch");
    const item = await this.get(`/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`) as { object?: { sha?: unknown } };
    if (typeof item.object?.sha !== "string" || !/^[a-f0-9]{40}$/.test(item.object.sha)) throw new GitHubReadError("invalid_response", "default branch head is invalid");
    return { sha: item.object.sha, evidenceUri: `github://repositories/${repository}/refs/heads/${branch}/${item.object.sha}` };
  }

  /** Proves the one configured workflow exists in GitHub's immutable tree at the exact bound SHA. */
  async assertWorkflowAtRef(repository: string, workflow: string, ref: string): Promise<{ readonly evidenceUri: string }> {
    this.assertRepository(repository);
    if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow) || !/^[a-f0-9]{40}$/.test(ref)) throw new GitHubReadError("authorization", "workflow observation is outside the bounded path or ref");
    const item = await this.get(`/repos/${repository}/contents/.github/workflows/${workflow}?ref=${ref}`) as Record<string, unknown>;
    if (item.type !== "file" || item.path !== `.github/workflows/${workflow}` || typeof item.sha !== "string") throw new GitHubReadError("invalid_response", "implementation workflow is absent at the bound ref");
    return { evidenceUri: `github://repositories/${repository}/contents/.github/workflows/${workflow}@${ref}` };
  }
}
