import { createHash, createSign } from "node:crypto";

import { GitHubExecutionIntentSchema, GitHubMutationTransportConfigV1Schema, type GitHubExecutionIntent, type GitHubMutationTransportConfigV1 } from "./contracts.js";
import type { ClaimedOutboxAction, SprintRunRepository } from "../../persistence/contracts.js";

export class GitHubMutationExecutionError extends Error {
  constructor(readonly code: "disabled" | "expired" | "precondition_failed" | "ambiguous" | "transport", message: string) { super(message); }
}

export interface MutationPreflight { assertCurrent(intent: GitHubExecutionIntent): Promise<void>; }
export interface GitHubMutationTransport { request(input: { method: "PATCH" | "POST"; path: string; body: string; idempotencyKey: string }): Promise<{ status: number; requestId?: string }>; }
export interface GitHubMutationPrivateKeySource { load(reference: string): Promise<string>; }
export interface GitHubMutationHttpTransport { request(input: { method: "PATCH" | "POST"; url: string; headers: Readonly<Record<string, string>>; body: string; timeoutMilliseconds: number }): Promise<{ status: number; headers: Readonly<Record<string, string | undefined>>; body: string }>; }
export interface MutationReconciler { reconcile(intent: GitHubExecutionIntent): Promise<"confirmed" | "absent" | "ambiguous">; }

const operationPath = (intent: GitHubExecutionIntent): { method: "PATCH" | "POST"; path: string; body: unknown } => {
  const prefix = `/repos/${intent.repository}`;
  switch (intent.type) {
    case "set_labels": return { method: "PATCH", path: `${prefix}/issues/${intent.issueNumber}`, body: { labels: intent.labels } };
    case "dispatch_workflow": return { method: "POST", path: `${prefix}/actions/workflows/${intent.workflow}/dispatches`, body: { ref: intent.ref, inputs: intent.inputs } };
    case "submit_review": return { method: "POST", path: `${prefix}/pulls/${intent.pullRequestNumber}/reviews`, body: { commit_id: intent.expectedHeadSha, event: intent.event, body: intent.body } };
    case "mark_ready_for_review": return { method: "PATCH", path: `${prefix}/pulls/${intent.pullRequestNumber}`, body: { draft: false } };
  }
};

/** Narrow GitHub App transport; it has no generic endpoint or cross-role credential path. */
export class GitHubAppMutationTransport implements GitHubMutationTransport {
  private readonly config: GitHubMutationTransportConfigV1; private token?: { value: string; expiresAt: number };
  constructor(rawConfig: unknown, private readonly secretReference: string, private readonly keys: GitHubMutationPrivateKeySource, private readonly http: GitHubMutationHttpTransport, private readonly now: () => Date = () => new Date()) {
    this.config = GitHubMutationTransportConfigV1Schema.parse(rawConfig);
    if (secretReference !== `ai-delivery-orchestrator/pilot/github-app-${this.config.actorRole}-private-key`) throw new Error("GitHub mutation secret is not role-specific");
  }
  private async tokenValue(): Promise<string> {
    if (this.token && this.token.expiresAt - this.now().getTime() > 30_000) return this.token.value;
    const key = await this.keys.load(this.secretReference); if (!key.includes("BEGIN") || key.length > 20_000) throw new GitHubMutationExecutionError("transport", "GitHub App key is unavailable");
    const iat = Math.floor(this.now().getTime() / 1000) - 30; const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"); const payload = Buffer.from(JSON.stringify({ iat, exp: iat + 540, iss: this.config.appId })).toString("base64url"); const signer = createSign("RSA-SHA256"); signer.update(`${header}.${payload}`); signer.end(); const jwt = `${header}.${payload}.${signer.sign(key).toString("base64url")}`;
    const response = await this.http.request({ method: "POST", url: `${this.config.apiBaseUrl}/app/installations/${this.config.installationId}/access_tokens`, headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "x-github-api-version": this.config.apiVersion }, body: JSON.stringify({ repositories: [this.config.repository.split("/")[1]], permissions: this.config.permissions }), timeoutMilliseconds: this.config.timeoutMilliseconds });
    const parsed = JSON.parse(response.body) as { token?: unknown; expires_at?: unknown }; if (response.status < 200 || response.status >= 300 || typeof parsed.token !== "string" || typeof parsed.expires_at !== "string") throw new GitHubMutationExecutionError("transport", "GitHub installation token is unavailable"); const expiresAt = Date.parse(parsed.expires_at); if (!Number.isFinite(expiresAt) || expiresAt <= this.now().getTime()) throw new GitHubMutationExecutionError("transport", "GitHub installation token expiry is invalid"); this.token = { value: parsed.token, expiresAt }; return parsed.token;
  }
  async request(input: { method: "PATCH" | "POST"; path: string; body: string; idempotencyKey: string }): Promise<{ status: number; requestId?: string }> {
    const allowed = new RegExp(`^/repos/${this.config.repository.replace("/", "\\/")}/(?:issues/[1-9][0-9]*|actions/workflows/[A-Za-z0-9_.-]+\\.ya?ml/dispatches|pulls/[1-9][0-9]*(?:/reviews)?)$`); if (!allowed.test(input.path)) throw new GitHubMutationExecutionError("transport", "GitHub mutation path is not allowlisted");
    const token = await this.tokenValue(); const response = await this.http.request({ method: input.method, url: `${this.config.apiBaseUrl}${input.path}`, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": this.config.apiVersion, "x-ai-orchestrator-idempotency-key": input.idempotencyKey }, body: input.body, timeoutMilliseconds: this.config.timeoutMilliseconds }); return { status: response.status, ...(response.headers["x-github-request-id"] ? { requestId: response.headers["x-github-request-id"] } : {}) };
  }
}

/** Executes only reviewed, operation-specific intents. It deliberately has no generic mutation API. */
export class GitHubMutationExecutor {
  private readonly completed = new Map<string, { requestId?: string }>();

  constructor(private readonly preflight: MutationPreflight, private readonly transport: GitHubMutationTransport, private readonly enabledOperations: ReadonlySet<GitHubExecutionIntent["type"]>, private readonly now: () => Date = () => new Date(), private readonly reconciler?: MutationReconciler) {}

  async execute(rawIntent: unknown): Promise<{ duplicate: boolean; requestId?: string }> {
    const intent = GitHubExecutionIntentSchema.parse(rawIntent);
    if (!this.enabledOperations.has(intent.type)) throw new GitHubMutationExecutionError("disabled", "GitHub mutation operation is disabled");
    if (Date.parse(intent.expiresAt) <= this.now().getTime()) throw new GitHubMutationExecutionError("expired", "GitHub mutation intent has expired");
    const duplicate = this.completed.get(intent.idempotencyKey);
    if (duplicate) return { duplicate: true, ...duplicate };
    try { await this.preflight.assertCurrent(intent); } catch { throw new GitHubMutationExecutionError("precondition_failed", "canonical GitHub state no longer matches intent"); }
    const request = operationPath(intent);
    const result = await this.transport.request({ ...request, body: JSON.stringify(request.body), idempotencyKey: intent.idempotencyKey });
    if (result.status >= 200 && result.status < 300) {
      const completed = result.requestId ? { requestId: result.requestId } : {};
      this.completed.set(intent.idempotencyKey, completed);
      return { duplicate: false, ...completed };
    }
    if (result.status >= 500 || result.status === 408) {
      const reconciliation = this.reconciler ? await this.reconciler.reconcile(intent) : "ambiguous";
      if (reconciliation === "confirmed") { this.completed.set(intent.idempotencyKey, {}); return { duplicate: true }; }
      throw new GitHubMutationExecutionError("ambiguous", reconciliation === "absent" ? "GitHub mutation outcome was absent after reconciliation" : "GitHub mutation outcome requires canonical reconciliation");
    }
    throw new GitHubMutationExecutionError("transport", `GitHub mutation was rejected with HTTP ${result.status}`);
  }
}

/** Consumes only GitHub mutation actions through the durable M2 outbox. */
export class GitHubMutationOutboxConsumer {
  constructor(private readonly repository: SprintRunRepository, private readonly executor: GitHubMutationExecutor, private readonly ownerId: string, private readonly leaseMilliseconds = 60_000, private readonly now: () => Date = () => new Date()) {}

  async consume(limit = 10): Promise<readonly { id: string; outcome: "completed" | "retry" | "blocked" }[]> {
    const now = this.now();
    const actions = await this.repository.claimOutbox(this.ownerId, limit, new Date(now.getTime() + this.leaseMilliseconds), now, ["github.mutation.execute"]);
    return Promise.all(actions.map((action) => this.consumeAction(action, now)));
  }

  private async consumeAction(action: ClaimedOutboxAction, now: Date): Promise<{ id: string; outcome: "completed" | "retry" | "blocked" }> {
    let intent: GitHubExecutionIntent | undefined;
    try {
      intent = GitHubExecutionIntentSchema.parse(action.payload);
      const result = await this.executor.execute(intent);
      await this.recordReceipt(action, intent, "completed", now, result.requestId);
      if (!await this.repository.completeOutbox(action.id, this.ownerId, now)) throw new Error("mutation outbox lease was lost");
      return { id: action.id, outcome: "completed" };
    } catch (error) {
      const category = error instanceof GitHubMutationExecutionError ? error.code : "invalid_intent";
      if (intent) await this.recordReceipt(action, intent, category === "ambiguous" ? "ambiguous" : "retry", now, undefined, category);
      if (category === "ambiguous") {
        await this.repository.blockOutbox(action.id, this.ownerId, "github_mutation:ambiguous", now);
        return { id: action.id, outcome: "blocked" };
      }
      await this.repository.retryOutbox(action.id, this.ownerId, `github_mutation:${category}`, now);
      return { id: action.id, outcome: "retry" };
    }
  }

  private async recordReceipt(action: ClaimedOutboxAction, intent: GitHubExecutionIntent, outcome: "completed" | "retry" | "ambiguous", now: Date, requestId?: string, errorClass?: string): Promise<void> {
    await this.repository.recordGitHubMutationReceipt?.({ outboxId: action.id, attempt: action.attemptCount, operation: intent.type, actorRole: intent.actorRole, intentSha256: createHash("sha256").update(JSON.stringify(intent), "utf8").digest("hex"), outcome, ...(requestId ? { requestId } : {}), ...(errorClass ? { errorClass } : {}), recordedAt: now.toISOString() });
  }
}
