import { GitHubExecutionIntentSchema, type GitHubExecutionIntent } from "./contracts.js";
import type { ClaimedOutboxAction, SprintRunRepository } from "../../persistence/contracts.js";

export class GitHubMutationExecutionError extends Error {
  constructor(readonly code: "disabled" | "expired" | "precondition_failed" | "ambiguous" | "transport", message: string) { super(message); }
}

export interface MutationPreflight { assertCurrent(intent: GitHubExecutionIntent): Promise<void>; }
export interface GitHubMutationTransport { request(input: { method: "PATCH" | "POST"; path: string; body: string; idempotencyKey: string }): Promise<{ status: number; requestId?: string }>; }
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

  async consume(limit = 10): Promise<readonly { id: string; outcome: "completed" | "retry" }[]> {
    const now = this.now();
    const actions = await this.repository.claimOutbox(this.ownerId, limit, new Date(now.getTime() + this.leaseMilliseconds), now, ["github.mutation.execute"]);
    return Promise.all(actions.map((action) => this.consumeAction(action, now)));
  }

  private async consumeAction(action: ClaimedOutboxAction, now: Date): Promise<{ id: string; outcome: "completed" | "retry" }> {
    try {
      await this.executor.execute(action.payload);
      if (!await this.repository.completeOutbox(action.id, this.ownerId, now)) throw new Error("mutation outbox lease was lost");
      return { id: action.id, outcome: "completed" };
    } catch (error) {
      const category = error instanceof GitHubMutationExecutionError ? error.code : "invalid_intent";
      await this.repository.retryOutbox(action.id, this.ownerId, `github_mutation:${category}`, now);
      return { id: action.id, outcome: "retry" };
    }
  }
}
