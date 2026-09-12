import { createHash } from "node:crypto";
import type { Pool } from "pg";

import { callbackRoute, type CallbackAuthorityBinding, type CanonicalCallbackObservation, type RepositoryAdapterConfigV1, type WorkItemState } from "../../domain/sprint-delivery/v1/index.js";
import type { NormalizedGitHubEvent } from "../../github/webhooks/v1/index.js";
import { PostgresSprintRunRepository } from "../../persistence/index.js";
import type { GitHubReadPort } from "../../providers/v1/ports.js";
import type { CallbackReadPort, CallbackPullRequest } from "../../providers/v1/callback-reads.js";
import { LiveWorkItemBindingSchema, adapterFingerprint } from "../../workflows/live-dispatch.js";

export class CallbackResolutionError extends Error {
  constructor(readonly reason: "identity_mismatch" | "correlation_absent" | "correlation_ambiguous" | "canonical_binding_invalid" | "automation_disabled") { super(reason); }
}

export interface ResolvedCallback {
  readonly workItemId: string;
  readonly runId: string;
  readonly revision: number;
  readonly runRevision: number;
  readonly state: WorkItemState;
  readonly binding: CallbackAuthorityBinding;
  readonly observation: CanonicalCallbackObservation;
  readonly observedAt: string;
  readonly artifacts: readonly { kind: string; id: string; fingerprint: string }[];
  readonly checksStatus?: "success" | "pending" | "failure";
  readonly reviewFactsFingerprint?: string;
}

/** Database identities select work; webhook hints never supply a binding or a state. */
export class CanonicalCallbackResolver {
  private readonly repository: PostgresSprintRunRepository;
  constructor(private readonly pool: Pool, private readonly github: GitHubReadPort & CallbackReadPort,
    private readonly adapter: RepositoryAdapterConfigV1, private readonly identity: { hookId: number; installationId: number; configurationVersion: string },
    private readonly now: () => Date = () => new Date()) { this.repository = new PostgresSprintRunRepository(pool); }

  async locate(event: NormalizedGitHubEvent): Promise<string | undefined> {
    if (event.hookId !== this.identity.hookId || event.installationId !== this.identity.installationId || (event.repository !== undefined && event.repository !== this.adapter.repository)) throw new CallbackResolutionError("identity_mismatch");
    if (event.eventName.startsWith("installation") || callbackRoute(event) === "unsupported") return undefined;
    let ids: readonly string[];
    if (event.eventName === "issues" || event.eventName === "issue_comment") {
      const result = await this.pool.query<{ id: string }>("SELECT w.id FROM orchestrator.work_items w JOIN orchestrator.sprint_runs r ON r.id=w.sprint_run_id WHERE r.repository=$1 AND w.issue_number=$2 AND r.state NOT IN ('completed','failed','cancelled','superseded')", [this.adapter.repository, event.issueNumber]);
      ids = result.rows.map((row) => row.id);
    } else if (event.eventName === "workflow_run") {
      const result = await this.pool.query<{ id: string }>("SELECT w.id FROM orchestrator.work_items w JOIN orchestrator.sprint_runs r ON r.id=w.sprint_run_id JOIN orchestrator.dispatch_attempts d ON d.work_item_id=w.id WHERE r.repository=$1 AND d.workflow_run_id=$2 AND d.status='accepted'", [this.adapter.repository, String(event.workflowRunId)]);
      ids = result.rows.map((row) => row.id);
    } else {
      const numbers = event.pullRequestNumber ? [event.pullRequestNumber] : (await this.github.getCallbackCheckPullRequests(this.adapter.repository, event.eventName === "check_run" ? "check_run" : "check_suite", event.checkRunId ?? event.checkSuiteId!)).pullRequestNumbers;
      const found: string[] = [];
      for (const number of numbers) {
        const pr = await this.github.getCallbackPullRequest(this.adapter.repository, number);
        found.push(pr.marker.split(":")[2]!);
      }
      ids = found;
    }
    const unique = [...new Set(ids)];
    if (unique.length > 1) throw new CallbackResolutionError("correlation_ambiguous");
    if (!unique[0]) throw new CallbackResolutionError("correlation_absent");
    return unique[0];
  }

  async resolve(input: { event: NormalizedGitHubEvent; configurationVersion: string; workItemId: string }): Promise<ResolvedCallback> {
    if (input.configurationVersion !== this.identity.configurationVersion) throw new CallbackResolutionError("identity_mismatch");
    const rows = await this.pool.query<{ run_id: string }>("SELECT sprint_run_id AS run_id FROM orchestrator.work_items WHERE id=$1", [input.workItemId]);
    const run = rows.rows[0] ? await this.repository.getRun(rows.rows[0].run_id) : undefined;
    const item = run?.workItems.find((value) => value.id === input.workItemId);
    const stored = await this.repository.getPlanningBinding(input.workItemId);
    if (!run || !item || !stored || run.input.repository !== this.adapter.repository) throw new CallbackResolutionError("correlation_absent");
    const original = LiveWorkItemBindingSchema.parse(stored.evidence);
    if (original.workItemId !== item.id || original.runId !== run.id || original.issue.number !== item.issueNumber) throw new CallbackResolutionError("canonical_binding_invalid");
    const [issue, plan, configuration, installation, head] = await Promise.all([
      this.github.getIssue(this.adapter.repository, item.issueNumber), this.github.getMarkedPlan(this.adapter.repository, item.issueNumber),
      this.github.getRepositoryConfiguration(this.adapter.repository), this.github.getInstallation(this.adapter.repository),
      this.github.getDefaultBranchHead(this.adapter.repository, this.adapter.defaultBranch),
    ]);
    const prior = await this.repository.getCallbackCorrelation(item.id);
    const marker = `orchestrator:${run.id}:${item.id}:${stored.fingerprint}`;
    const branch = `orchestrator/${run.id}/${item.id}`;
    const binding: CallbackAuthorityBinding = { repository: this.adapter.repository, ...this.identity, workItemId: item.id, issueNodeId: original.issue.nodeId,
      planningFingerprint: stored.fingerprint, automationMarker: marker, expectedBranch: branch, expectedBaseSha: original.defaultBranchSha, requiredCheckNames: this.adapter.requiredChecks };
    const observation: CanonicalCallbackObservation = { repository: configuration.repository, hookId: this.identity.hookId, installationId: Number(installation.installationId), issueNodeId: issue.nodeId,
      planningFingerprint: stored.fingerprint, automationMarker: marker, branch, baseSha: head.sha };
    let invalidationReason: string | undefined;
    if (!this.adapter.enabled || ["paused", "cancelled", "superseded", "failed", "completed", "blocked"].includes(run.state)) invalidationReason = "automation_disabled";
    else if (adapterFingerprint(this.adapter) !== original.adapterFingerprint || configuration.configurationSha256 !== original.repositoryConfiguration.configurationSha256 ||
      configuration.repositoryId !== original.repositoryConfiguration.repositoryId || installation.repositoryId !== configuration.repositoryId ||
      installation.appId !== original.installation.appId || installation.installationId !== original.installation.installationId ||
      JSON.stringify(Object.entries(installation.permissions).sort()) !== JSON.stringify(Object.entries(original.installation.permissions).sort()) || head.sha !== original.defaultBranchSha || configuration.archive ||
      issue.nodeId !== original.issue.nodeId || issue.state !== "open" || plan.commentId !== original.plan.commentId || plan.bodySha256 !== original.plan.bodySha256) invalidationReason = "canonical_binding_drift";
    const artifacts: { kind: string; id: string; fingerprint: string }[] = [];
    let checksStatus: ResolvedCallback["checksStatus"];
    let reviewFactsFingerprint: string | undefined;
    const result = (bound: CallbackAuthorityBinding = binding, observed: CanonicalCallbackObservation = observation): ResolvedCallback => ({ workItemId: item.id, runId: run.id, revision: item.revision, runRevision: run.revision, state: item.state, binding: bound,
      observation: { ...observed, ...(invalidationReason ? { invalidationReason } : {}) }, observedAt: this.now().toISOString(), artifacts,
      ...(checksStatus ? { checksStatus } : {}), ...(reviewFactsFingerprint ? { reviewFactsFingerprint } : {}) });
    if (invalidationReason || input.event.eventName === "issues" || input.event.eventName === "issue_comment") return result();
    const accepted = await this.pool.query<{ workflow_run_id: string }>("SELECT workflow_run_id FROM orchestrator.dispatch_attempts WHERE work_item_id=$1 AND status='accepted'", [item.id]);
    if (accepted.rows.length !== 1) throw new CallbackResolutionError("correlation_ambiguous");
    const workflow = await this.github.getCallbackWorkflow(this.adapter.repository, accepted.rows[0]!.workflow_run_id);
    if (workflow.id !== accepted.rows[0]!.workflow_run_id || workflow.marker !== marker || workflow.repositoryId !== configuration.repositoryId || workflow.headSha !== original.defaultBranchSha || workflow.path !== `.github/workflows/${this.adapter.workflows.implementation}` || workflow.attempt !== 1) invalidationReason = "workflow_binding_drift";
    if (workflow.status === "completed" && workflow.conclusion !== "success") invalidationReason = "implementation_failed";
    if (invalidationReason) return result();
    artifacts.push({ kind: "workflow", id: workflow.id, fingerprint: hash({ workflowId: workflow.workflowId, attempt: workflow.attempt, headSha: workflow.headSha }) });
    const prs = prior?.pullRequestNumber ? [await this.github.getCallbackPullRequest(this.adapter.repository, prior.pullRequestNumber)] : await this.github.findCallbackPullRequests(this.adapter.repository, branch);
    if (prs.length > 1) throw new CallbackResolutionError("correlation_ambiguous");
    const pr = prs[0];
    if (pr && !this.matchesPullRequest(pr, marker, branch, original.defaultBranchSha, configuration.repositoryId)) invalidationReason = "pull_request_binding_drift";
    if (pr && prior?.currentHeadSha && (pr.headSha !== prior.currentHeadSha || pr.nodeId !== prior.pullRequestNodeId || pr.number !== prior.pullRequestNumber)) invalidationReason = "head_lineage_drift";
    if (input.event.pullRequestNumber && input.event.pullRequestNumber !== pr?.number) invalidationReason = "pull_request_binding_drift";
    if (input.event.eventName === "check_run" || input.event.eventName === "check_suite") {
      const check = await this.github.getCallbackCheckPullRequests(this.adapter.repository, input.event.eventName, input.event.checkRunId ?? input.event.checkSuiteId!);
      if (check.headSha !== pr?.headSha || !pr || !check.pullRequestNumbers.includes(pr.number)) invalidationReason = "stale_check_observation";
    }
    if (invalidationReason) return result();
    const checks: Record<string, "success" | "pending" | "failure" | "unknown"> = {};
    let reviewHeadSha: string | undefined;
    if (pr) {
      artifacts.push({ kind: "pull_request", id: pr.nodeId, fingerprint: hash({ number: pr.number, headSha: pr.headSha, baseSha: pr.baseSha }) });
      const observedChecks = await this.github.getChecks(this.adapter.repository, pr.headSha);
      for (const name of this.adapter.requiredChecks) {
        const matching = observedChecks.filter((check) => check.name === name);
        checks[name] = matching.length !== 1 ? "pending" : matching[0]!.headSha !== pr.headSha ? "unknown" : matching[0]!.status !== "completed" ? "pending" : matching[0]!.conclusion === "success" ? "success" : "failure";
      }
      for (const check of observedChecks) {
        const id = check.evidence.uri.split("/").at(-1)!;
        if (!/^[1-9][0-9]*$/.test(id)) throw new CallbackResolutionError("canonical_binding_invalid");
        artifacts.push({ kind: "check", id, fingerprint: hash({ headSha: check.headSha, name: check.name }) });
      }
      const reviews = await this.github.getReviews(this.adapter.repository, pr.number);
      checksStatus = Object.values(checks).includes("failure") ? "failure" : Object.values(checks).every((value) => value === "success") ? "success" : "pending";
      reviewFactsFingerprint = hash(reviews.map((review) => ({ id: review.id, headSha: review.headSha, state: review.state, actor: review.authorLogin })).sort((a,b) => a.id.localeCompare(b.id)));
      for (const review of reviews) artifacts.push({ kind: "review", id: review.id, fingerprint: hash({ headSha: review.headSha, actor: review.authorLogin }) });
      if (input.event.eventName === "pull_request_review") reviewHeadSha = reviews.every((review) => review.headSha === pr.headSha || review.state === "DISMISSED") ? pr.headSha : undefined;
    }
    for (const artifact of artifacts) {
      const existing = await this.pool.query<{ work_item_id: string; fingerprint: string }>("SELECT work_item_id,fingerprint FROM orchestrator.github_callback_artifacts WHERE repository=$1 AND kind=$2 AND external_id=$3", [this.adapter.repository, artifact.kind, artifact.id]);
      if (existing.rows[0] && (existing.rows[0].work_item_id !== item.id || existing.rows[0].fingerprint !== artifact.fingerprint)) invalidationReason = "external_artifact_reused";
    }
    return result({ ...binding, acceptedWorkflowRunId: workflow.id, ...(pr ? { pullRequestNodeId: pr.nodeId, pullRequestNumber: pr.number, currentHeadSha: pr.headSha } : {}) },
      { ...observation, workflowRunId: workflow.id, workflowStarted: ["in_progress", "completed"].includes(workflow.status), ...(pr ? { pullRequestNodeId: pr.nodeId, pullRequestNumber: pr.number, pullRequestOpen: pr.open, headSha: pr.headSha, requiredChecks: checks } : {}), ...(reviewHeadSha ? { reviewHeadSha } : {}) });
  }

  private matchesPullRequest(pr: CallbackPullRequest, marker: string, branch: string, baseSha: string, repositoryId: string): boolean {
    return pr.marker === marker && pr.branch === branch && pr.baseSha === baseSha && pr.baseBranch === this.adapter.defaultBranch && pr.repositoryId === repositoryId && pr.headRepositoryId === repositoryId && pr.open;
  }
}

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
