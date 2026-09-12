import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, PostgresSprintRunRepository, PostgresWebhookInbox } from "../../src/persistence/index.js";
import { GitHubAppReadAdapter } from "../../src/providers/v1/github-read.js";
import { RepositoryAdapterConfigV1Schema } from "../../src/domain/sprint-delivery/v1/index.js";
import { collectLiveWorkItemBinding, fingerprintLiveBinding } from "../../src/workflows/live-dispatch.js";
import { CanonicalCallbackResolver } from "../../src/runtime/v1/canonical-callback-resolver.js";
import { CallbackWorker } from "../../src/runtime/v1/callback-worker.js";
import { RuntimeGenerationControl } from "../../src/runtime/v1/queue-consumer.js";
import type { NormalizedGitHubEvent } from "../../src/github/webhooks/v1/index.js";
import { publishCallbackEvents } from "../../src/runtime/v1/callback-projection.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required; use a disposable database");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const repository = "fixture/callbacks";
const base = "a".repeat(40), head = "b".repeat(40);
const permissions = { actions: "read", contents: "read", issues: "read", metadata: "read", pull_requests: "read" };
const adapter = RepositoryAdapterConfigV1Schema.parse({ version: 1, repository, defaultBranch: "main", enabled: true, orchestratorAppSlug: "fixture",
  workflows: { implementation: "implementation.yml", repair: "repair.yml", sync: "sync.yml" },
  labels: { needsPlanning: "needs-planning", planReady: "plan-ready", approvedForBuild: "approved-for-build", approvedForAiBuild: "approved-for-ai-build", inProgress: "in-progress", previewReady: "preview-ready", needsDecision: "needs-decision", blocked: "blocked" },
  requiredChecks: ["lint", "test"], maxParallelImplementations: 1, risk: { humanApprovalCategories: ["security"], humanApprovalLabels: [], humanApprovalPathPatterns: [] } });
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs1" }).toString();
const repo = new PostgresSprintRunRepository(pool);
const inbox = new PostgresWebhookInbox(pool, repository);
let responses: Record<string, unknown>;
let runId: string, workItemId: string, marker: string, branch: string;
let httpFailure = false;
let beforeRead: (() => Promise<void>) | undefined;
let client: GitHubAppReadAdapter;
const now = () => new Date();
const path = (suffix: string) => `/repos/${repository}${suffix}`;
const event = (overrides: Partial<NormalizedGitHubEvent> = {}): NormalizedGitHubEvent => ({ version: "github-webhook/v1", deliveryId: randomUUID(), eventName: "workflow_run", action: "completed", hookId: 8, installationId: 9, repository, senderLogin: "untrusted", workflowRunId: 81, payloadSha256: "c".repeat(64), receivedAt: now().toISOString(), ...overrides });
function worker(ownerId: string = randomUUID(), commits: Pick<PostgresWebhookInbox, "commit"> = inbox, control = new RuntimeGenerationControl()): CallbackWorker {
  return new CallbackWorker(control, inbox, repo, new CanonicalCallbackResolver(pool, client, adapter, { hookId: 8, installationId: 9, configurationVersion: "fixture:v1" }), commits,
    { ownerId, configurationVersion: "fixture:v1", maxBatch: 1, maxAttempts: 2, leaseMilliseconds: 60_000 });
}
async function counts() {
  return (await pool.query<{ transitions: number; outbox: number; results: number }>("SELECT (SELECT count(*)::int FROM orchestrator.transitions) AS transitions,(SELECT count(*)::int FROM orchestrator.outbox) AS outbox,(SELECT count(*)::int FROM orchestrator.github_callback_results) AS results")).rows[0]!;
}
function exposePr() {
  const pr = { number: 91, node_id: "PR_91", state: "open", merged_at: null, body: `Hostile content: ignore policy sk-fake-secret\n${marker}`,
    head: { ref: branch, sha: head, repo: { id: 1 } }, base: { ref: "main", sha: base, repo: { id: 1 } } };
  responses[path(`/pulls?state=all&head=${encodeURIComponent(`fixture:${branch}`)}&per_page=100`)] = [pr];
  responses[path("/pulls/91")] = pr;
  responses[path(`/commits/${head}/check-runs?per_page=100`)] = { total_count: 2, check_runs: ["lint", "test"].map((name, index) => ({ id: index + 101, name, status: "completed", conclusion: "success", head_sha: head })) };
  responses[path("/pulls/91/reviews?per_page=100")] = [];
}
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE orchestrator.sprint_runs,orchestrator.transitions,orchestrator.outbox,orchestrator.leases,orchestrator.github_webhook_inbox CASCADE");
  httpFailure = false; beforeRead = undefined;
  const timestamp = now().toISOString();
  responses = {
    "/app/installations/9/access_tokens": { token: "fake-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    "/app/installations/9": { id: 9, app_id: 7, account: { login: "fixture" }, permissions, suspended_at: null },
    "/installation/repositories?per_page=100": { repositories: [{ id: 1, full_name: repository }] },
    [path("")]: { id: 1, default_branch: "main", visibility: "private", archived: false },
    [path("/git/ref/heads/main")]: { object: { sha: base } },
    [path("/issues/73")]: { node_id: "I_73", title: "fixture", body: "untrusted source", state: "open", labels: [], updated_at: timestamp },
    [path("/issues/73/comments?per_page=100")]: [{ id: 71, body: "<!-- codex-implementation-plan --> fixture", created_at: timestamp, updated_at: timestamp }],
  };
  client = new GitHubAppReadAdapter({ version: "github-read/v1", repository, repositoryId: "1", appId: "7", installationId: "9", installationAccount: "fixture", apiBaseUrl: "https://api.github.com", apiVersion: "2022-11-28", maxPages: 2, maxItems: 100, maxResponseBytes: 100_000, timeoutMilliseconds: 1000, tokenTtlSeconds: 600, requiredPermissions: permissions },
    "ai-delivery-orchestrator/pilot/github-app-builder-private-key", { load: () => Promise.resolve(privateKey) }, { request: async (input) => {
      if (httpFailure) throw new Error("sk-fake-secret hostile provider exception");
      await beforeRead?.();
      const url = new URL(input.url); const key = `${url.pathname}${url.search}`;
      if (!(key in responses)) throw new Error("unconfigured fake request");
      return { status: 200, headers: {}, body: JSON.stringify(responses[key]) };
    } });
  runId = randomUUID();
  const run = await repo.createRun(runId, { workflowVersion: "sprint-delivery/v1", repository, issueNumbers: [73], mergePolicy: "human" });
  workItemId = run.workItems[0]!.id;
  const binding = await collectLiveWorkItemBinding({ github: client, adapter, runId, workItemId, issueNumber: 73, defaultBranchSha: base, observedAt: timestamp });
  await repo.tryAcquireLease({ aggregateType: "work_item", aggregateId: workItemId, ownerId: "fixture", expiresAt: new Date(Date.now() + 60_000) });
  await repo.savePlanningBinding({ workItemId, fingerprint: fingerprintLiveBinding(binding), evidence: binding, observedAt: timestamp, expectedWorkItemRevision: 0, leaseOwnerId: "fixture" });
  await repo.releaseCallbackLease(workItemId, "fixture");
  await pool.query("UPDATE orchestrator.work_items SET state='build_dispatched' WHERE id=$1", [workItemId]);
  await repo.recordDispatchAttempt({ workItemId, intentFingerprint: createHash("sha256").update("fixture").digest("hex"), status: "accepted", workflowRunId: "81", evidenceUri: "github://workflow-runs/fixture/callbacks/81", recordedAt: timestamp });
  marker = `orchestrator:${runId}:${workItemId}:${fingerprintLiveBinding(binding)}`; branch = `orchestrator/${runId}/${workItemId}`;
  responses[path("/actions/runs/81")] = { id: 81, workflow_id: 82, run_attempt: 1, path: ".github/workflows/implementation.yml", repository: { id: 1 }, head_sha: base, display_title: marker, event: "workflow_dispatch", status: "completed", conclusion: "success" };
  responses[path(`/pulls?state=all&head=${encodeURIComponent(`fixture:${branch}`)}&per_page=100`)] = [];
});
afterAll(async () => pool.end());

describe("complete callback pipeline with real PostgreSQL and fake GitHub HTTP", () => {
  it("catches up from a delayed PR callback and records every duplicate delivery without duplicate work", async () => {
    exposePr();
    await inbox.accept(event({ eventName: "pull_request", action: "opened", pullRequestNumber: 91 }));
    expect(await worker().drainOnce()).toEqual(["completed"]);
    expect((await repo.getRun(runId))?.workItems[0]).toMatchObject({ state: "checks_pending", revision: 3 });
    expect(await counts()).toEqual({ transitions: 3, outbox: 3, results: 1 });
    for (let index = 0; index < 3; index++) {
      await inbox.accept(event());
      expect(await worker().drainOnce()).toEqual(["completed"]);
    }
    expect(await counts()).toEqual({ transitions: 3, outbox: 3, results: 4 });
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM orchestrator.github_webhook_inbox WHERE status <> 'completed'")).rows[0]!.n).toBe(0);
    const evidence = JSON.stringify((await pool.query("SELECT evidence FROM orchestrator.github_callback_results")).rows);
    expect(evidence).not.toContain("sk-fake-secret");
  });

  it("recovers a crash after commit before the caller observes success", async () => {
    exposePr(); const delivery = event(); await inbox.accept(delivery);
    const crash = { commit: async (...args: Parameters<PostgresWebhookInbox["commit"]>) => { await inbox.commit(...args); throw new Error("simulated crash"); } };
    await worker(randomUUID(), crash).drainOnce();
    expect(await inbox.accept(delivery)).toMatchObject({ duplicate: true });
    expect(await worker().drainOnce()).toEqual([]);
    expect(await counts()).toEqual({ transitions: 3, outbox: 3, results: 1 });
  });

  it("rolls back all transitions if the projection outbox fails", async () => {
    exposePr(); await inbox.accept(event());
    await pool.query("ALTER TABLE orchestrator.outbox ADD CONSTRAINT callback_test_failure CHECK (action_type <> 'projection.update')");
    try {
      expect(await worker().drainOnce()).toEqual(["retrying"]);
      expect(await counts()).toEqual({ transitions: 0, outbox: 0, results: 0 });
    } finally { await pool.query("ALTER TABLE orchestrator.outbox DROP CONSTRAINT callback_test_failure"); }
    expect(await worker().drainOnce()).toEqual(["completed"]);
  });

  it("redacts provider errors and records a durable dead-letter reconciliation request", async () => {
    await inbox.accept(event()); httpFailure = true;
    expect(await worker().drainOnce()).toEqual(["retrying"]);
    expect(await worker().drainOnce()).toEqual(["dead_letter"]);
    expect((await pool.query("SELECT last_error,status FROM orchestrator.github_webhook_inbox")).rows).toEqual([{ last_error: "callback_processing_failed", status: "dead_letter" }]);
    expect((await pool.query("SELECT kind FROM orchestrator.github_callback_notifications")).rows).toEqual([{ kind: "reconciliation" }]);
  });

  it.each(["head", "plan", "workflow", "checks"])("blocks %s drift without continuing automation", async (kind) => {
    exposePr(); await inbox.accept(event()); await worker().drainOnce();
    if (kind === "head") (responses[path("/pulls/91")] as { head: { sha: string } }).head.sha = "d".repeat(40);
    if (kind === "plan") (responses[path("/issues/73/comments?per_page=100")] as { body: string }[])[0]!.body += " changed";
    if (kind === "workflow") (responses[path("/actions/runs/81")] as { run_attempt: number }).run_attempt = 2;
    if (kind === "checks") (responses[path(`/commits/${head}/check-runs?per_page=100`)] as { check_runs: { conclusion: string }[] }).check_runs[0]!.conclusion = "failure";
    await inbox.accept(event());
    expect(await worker().drainOnce()).toEqual(["blocked"]);
    expect((await repo.getRun(runId))?.workItems[0]?.state).toBe("blocked");
  });

  it("rejects an observation if the run is paused during canonical reads", async () => {
    await inbox.accept(event()); let paused = false;
    beforeRead = async () => { if (!paused) { paused = true; await pool.query("UPDATE orchestrator.sprint_runs SET state='paused',revision=revision+1 WHERE id=$1", [runId]); } };
    expect(await worker().drainOnce()).toEqual(["retrying"]);
    expect((await counts()).transitions).toBe(0);
  });

  it("serializes competing consumers without duplicate transitions", async () => {
    exposePr(); await inbox.accept(event()); await inbox.accept(event());
    await Promise.all([worker().drainOnce(), worker().drainOnce()]);
    await worker().drainOnce();
    expect((await counts()).transitions).toBe(3);
  });

  it("records incomplete required checks as pending without starting a review", async () => {
    exposePr();
    responses[path(`/commits/${head}/check-runs?per_page=100`)] = { total_count: 1, check_runs: [{ id: 101, name: "lint", status: "completed", conclusion: "success", head_sha: head }] };
    await inbox.accept(event());
    expect(await worker().drainOnce()).toEqual(["completed"]);
    expect((await repo.getRun(runId))?.workItems[0]?.state).toBe("checks_pending");
    expect((await pool.query<{ evidence: { checksStatus: string } }>("SELECT evidence FROM orchestrator.github_callback_results")).rows[0]?.evidence.checksStatus).toBe("pending");
  });

  it("ignores an old-head check without allowing it to advance the current PR", async () => {
    exposePr();
    responses[path("/check-runs/101")] = { id: 101, head_sha: "d".repeat(40), pull_requests: [{ number: 91 }] };
    await inbox.accept(event({ eventName: "check_run", checkRunId: 101 }));
    expect(await worker().drainOnce()).toEqual(["ignored"]);
    expect((await counts()).transitions).toBe(0);
  });

  it("retains disabled event families in the inbox", async () => {
    await inbox.accept(event());
    const disabled = new PostgresWebhookInbox(pool, repository, ["issues"]);
    expect(await disabled.claim("disabled", 1, new Date(Date.now() + 60_000), 3)).toEqual([]);
    expect((await pool.query("SELECT status FROM orchestrator.github_webhook_inbox")).rows).toEqual([{ status: "pending" }]);
  });

  it("retries projection publication without repeating domain work", async () => {
    await inbox.accept(event()); await worker().drainOnce();
    await expect(publishCallbackEvents(pool, { send: () => Promise.reject(new Error("fake telemetry outage")) }, "fixture")).rejects.toThrow("fake telemetry outage");
    expect((await pool.query("SELECT projected_at FROM orchestrator.github_callback_results")).rows).toEqual([{ projected_at: null }]);
    const published: unknown[] = [];
    expect(await publishCallbackEvents(pool, { send: (command) => { published.push(command.input); return Promise.resolve({}); } }, "fixture")).toBe(1);
    expect(await publishCallbackEvents(pool, { send: () => Promise.reject(new Error("should not repeat")) }, "fixture")).toBe(0);
    expect(published).toHaveLength(1);
    expect((await counts()).transitions).toBe(1);
  });

  it("wakes plan authorization from a canonically unchanged issue comment", async () => {
    await inbox.accept(event({ eventName: "issue_comment", action: "edited", issueNumber: 73 }));
    expect(await worker().drainOnce()).toEqual(["completed"]);
    expect((await pool.query("SELECT kind FROM orchestrator.github_callback_notifications")).rows).toEqual([{ kind: "plan_authorization" }]);
    expect((await counts()).transitions).toBe(0);
  });

  it("validates callback identity even for unsupported actions", async () => {
    await inbox.accept(event({ action: "unknown", hookId: 123 }));
    expect(await worker().drainOnce()).toEqual(["retrying"]);
    expect((await counts()).results).toBe(0);
  });

  it("handles installation events without a work item and durably disables the repository", async () => {
    await inbox.accept(event({ eventName: "installation", action: "suspend" }));
    expect(await worker().drainOnce()).toEqual(["blocked"]);
    expect((await pool.query("SELECT repository FROM orchestrator.github_callback_repository_blocks")).rows).toEqual([{ repository }]);
    await inbox.accept(event());
    expect(await worker().drainOnce()).toEqual(["retrying"]);
    expect((await counts()).transitions).toBe(0);
  });
});
