import { createHash } from "node:crypto";

import { z } from "zod";

import {
  RepositoryAdapterConfigV1Schema,
  RepositoryNameSchema,
  authorizeBuild,
  type RepositoryAdapterConfigV1,
} from "../domain/sprint-delivery/v1/index.js";
import {
  CanonicalInstallationSchema,
  CanonicalIssueSchema,
  CanonicalPlanSchema,
  CanonicalRepositoryConfigurationSchema,
  CanonicalWorkflowRunSchema,
  GitHubExecutionIntentSchema,
  type GitHubExecutionIntent,
  type GitHubReadPort,
  type FeasibilityResult,
} from "../providers/v1/index.js";
import type { PersistedWorkItem, SprintRunRepository } from "../persistence/index.js";

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Immutable, canonical evidence required before a dispatch intent may enter the outbox. */
export const LiveWorkItemBindingSchema = z.object({
  version: z.literal("live-work-item-binding/v1"),
  runId: z.uuid(),
  workItemId: z.uuid(),
  issue: CanonicalIssueSchema,
  plan: CanonicalPlanSchema,
  defaultBranchSha: shaSchema,
  repositoryConfiguration: CanonicalRepositoryConfigurationSchema,
  installation: CanonicalInstallationSchema,
  adapterFingerprint: fingerprintSchema,
  observedAt: z.iso.datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  if (value.issue.number !== value.plan.issueNumber) context.addIssue({ code: "custom", message: "plan must bind the same issue" });
  if (value.issue.repository !== value.repositoryConfiguration.repository || value.issue.repository !== value.installation.repository) context.addIssue({ code: "custom", message: "canonical repository identity mismatch" });
  if (value.repositoryConfiguration.repositoryId !== value.installation.repositoryId) context.addIssue({ code: "custom", message: "canonical repository ID mismatch" });
});
export type LiveWorkItemBinding = z.infer<typeof LiveWorkItemBindingSchema>;

/** Collects the complete canonical evidence set before any live planning step. */
export async function collectLiveWorkItemBinding(input: {
  readonly github: GitHubReadPort;
  readonly adapter: RepositoryAdapterConfigV1;
  readonly runId: string;
  readonly workItemId: string;
  readonly issueNumber: number;
  readonly defaultBranchSha: string;
  readonly observedAt: string;
}): Promise<LiveWorkItemBinding> {
  const adapter = RepositoryAdapterConfigV1Schema.parse(input.adapter);
  if (!adapter.enabled) throw new Error("repository automation is disabled");
  const [issue, plan, repositoryConfiguration, installation] = await Promise.all([
    input.github.getIssue(adapter.repository, input.issueNumber),
    input.github.getMarkedPlan(adapter.repository, input.issueNumber),
    input.github.getRepositoryConfiguration(adapter.repository),
    input.github.getInstallation(adapter.repository),
  ]);
  if (repositoryConfiguration.defaultBranch !== adapter.defaultBranch) throw new Error("repository default branch drifted from adapter");
  return LiveWorkItemBindingSchema.parse({ version: "live-work-item-binding/v1", runId: input.runId, workItemId: input.workItemId, issue, plan, defaultBranchSha: input.defaultBranchSha, repositoryConfiguration, installation, adapterFingerprint: adapterFingerprint(adapter), observedAt: input.observedAt });
}

/** Reads approval only from GitHub's canonical event stream and binds it to the current plan. */
export async function authorizeLiveBuild(input: {
  readonly github: GitHubReadPort;
  readonly repository: string;
  readonly issueNumber: number;
  readonly plan: z.infer<typeof CanonicalPlanSchema>;
  readonly analysis: FeasibilityResult;
}): Promise<ReturnType<typeof authorizeBuild>> {
  const approvals = await input.github.getHumanBuildApprovals(input.repository, input.issueNumber);
  const currentPlanTime = Date.parse(input.plan.updatedAt);
  return authorizeBuild(input.analysis, input.issueNumber, input.plan.bodySha256,
    approvals.filter((approval) => Date.parse(approval.occurredAt) >= currentPlanTime)
      .map((approval) => ({ issueNumber: approval.issueNumber, planSha256: input.plan.bodySha256, actor: { kind: "human" as const, id: approval.actorLogin }, approvedAt: approval.occurredAt, evidenceUri: approval.evidence.uri })));
}

export const DispatchPreparationSchema = z.object({
  version: z.literal("live-dispatch-preparation/v1"),
  binding: LiveWorkItemBindingSchema,
  adapter: RepositoryAdapterConfigV1Schema,
  expectedAdapterFingerprint: fingerprintSchema,
  expectedPlanSha256: fingerprintSchema,
  expectedDefaultBranchSha: shaSchema,
  now: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();
export type DispatchPreparation = z.infer<typeof DispatchPreparationSchema>;

export type DispatchPreparationResult =
  | { readonly ready: true; readonly intent: GitHubExecutionIntent; readonly bindingFingerprint: string }
  | { readonly ready: false; readonly reason: "automation_disabled" | "adapter_drift" | "plan_drift" | "default_branch_drift" | "issue_closed" | "identity_drift" | "installation_permission_missing" | "invalid_expiry" };
export type DispatchPreparationFailure = Extract<DispatchPreparationResult, { readonly ready: false }>;

export function fingerprintLiveBinding(binding: LiveWorkItemBinding): string {
  return createHash("sha256").update(JSON.stringify(LiveWorkItemBindingSchema.parse(binding)), "utf8").digest("hex");
}

/**
 * Converts only fully bound, current evidence into the narrow #71 workflow-dispatch
 * intent. The caller must atomically persist this result in the durable outbox; this
 * function deliberately does not possess a provider, credential, or mutation method.
 */
export function prepareImplementationDispatch(raw: unknown): DispatchPreparationResult {
  const input = DispatchPreparationSchema.parse(raw);
  const { binding, adapter } = input;
  if (Date.parse(input.expiresAt) <= Date.parse(input.now)) return { ready: false, reason: "invalid_expiry" };
  if (!adapter.enabled) return { ready: false, reason: "automation_disabled" };
  if (adapter.repository !== binding.issue.repository || binding.repositoryConfiguration.defaultBranch !== adapter.defaultBranch) return { ready: false, reason: "identity_drift" };
  if (input.expectedAdapterFingerprint !== binding.adapterFingerprint) return { ready: false, reason: "adapter_drift" };
  if (input.expectedPlanSha256 !== binding.plan.bodySha256) return { ready: false, reason: "plan_drift" };
  if (input.expectedDefaultBranchSha !== binding.defaultBranchSha) return { ready: false, reason: "default_branch_drift" };
  if (binding.issue.state !== "open") return { ready: false, reason: "issue_closed" };
  if (binding.installation.permissions.actions !== "write" || binding.installation.permissions.issues !== "write") return { ready: false, reason: "installation_permission_missing" };
  const bindingFingerprint = fingerprintLiveBinding(binding);
  const marker = `orchestrator:${binding.runId}:${binding.workItemId}:${bindingFingerprint}`;
  return {
    ready: true,
    bindingFingerprint,
    intent: GitHubExecutionIntentSchema.parse({
      version: "github-mutation/v1",
      idempotencyKey: `dispatch:${binding.runId}:${binding.workItemId}:${bindingFingerprint}`,
      repository: RepositoryNameSchema.parse(binding.issue.repository),
      repositoryId: binding.repositoryConfiguration.repositoryId,
      actorRole: "builder",
      issueNumber: binding.issue.number,
      type: "dispatch_workflow",
      workflow: adapter.workflows.implementation,
      ref: binding.defaultBranchSha,
      inputs: {
        issue_number: String(binding.issue.number),
        run_id: binding.runId,
        work_item_id: binding.workItemId,
        plan_sha256: binding.plan.bodySha256,
        binding_sha256: bindingFingerprint,
        correlation: marker,
      },
      expectedStateSha256: bindingFingerprint,
      expiresAt: input.expiresAt,
    }),
  };
}

function deterministicUuid(scope: string): string {
  const value = createHash("sha256").update(scope).digest("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

export type QueueImplementationDispatchResult =
  | { readonly queued: true; readonly intent: GitHubExecutionIntent; readonly outboxId: string; readonly duplicate: boolean }
  | { readonly queued: false; readonly reason: DispatchPreparationFailure["reason"] }
  | { readonly queued: false; readonly reason: "already_queued" | "already_dispatched" };

/**
 * Atomically marks a ready work item as queued and commits its exact, bounded GitHub
 * dispatch intent to the outbox. A queue entry is deliberately not acceptance proof.
 */
export async function queueImplementationDispatch(input: {
  readonly repository: SprintRunRepository;
  readonly workItem: PersistedWorkItem;
  readonly preparation: DispatchPreparation;
}): Promise<QueueImplementationDispatchResult> {
  const preparation = prepareImplementationDispatch(input.preparation);
  if (!preparation.ready) return { queued: false, reason: preparation.reason };
  if (input.workItem.state === "dispatch_queued") return { queued: false, reason: "already_queued" };
  if (input.workItem.state === "build_dispatched") return { queued: false, reason: "already_dispatched" };
  if (input.workItem.state !== "ready_to_build") {
    throw new Error("only build-authorized work items may queue an implementation dispatch");
  }

  const scope = `sprint-delivery/v1:${input.workItem.id}:${preparation.bindingFingerprint}:dispatch_queued`;
  const outboxId = deterministicUuid(`${scope}:outbox`);
  const transitioned = await input.repository.transitionWorkItem({
    workItemId: input.workItem.id,
    event: "dispatch_queued",
    metadata: {
      transitionId: deterministicUuid(`${scope}:transition`),
      aggregateId: input.workItem.id,
      expectedRevision: input.workItem.revision,
      idempotencyKey: `workflow:${scope}`,
      occurredAt: input.preparation.now,
      actor: { kind: "system", id: "sprint-delivery/v1" },
      evidence: [
        { kind: "issue", uri: `github://issues/${preparation.intent.repository}/${preparation.intent.issueNumber}` },
        { kind: "plan", uri: input.preparation.binding.plan.evidence.uri },
        { kind: "policy", uri: input.preparation.binding.repositoryConfiguration.evidence.uri },
        { kind: "policy", uri: input.preparation.binding.installation.evidence.uri },
      ],
    },
    outbox: {
      id: outboxId,
      type: "github.mutation.execute",
      payload: preparation.intent,
      idempotencyKey: `outbox:${scope}`,
    },
  });
  return { queued: true, intent: preparation.intent, outboxId, duplicate: transitioned.duplicate };
}

export function adapterFingerprint(adapter: RepositoryAdapterConfigV1): string {
  return createHash("sha256").update(JSON.stringify(RepositoryAdapterConfigV1Schema.parse(adapter)), "utf8").digest("hex");
}

export const DispatchAcceptanceEvidenceSchema = z.object({
  intent: GitHubExecutionIntentSchema,
  acceptedAt: z.iso.datetime({ offset: true }),
  workflowRuns: z.array(CanonicalWorkflowRunSchema).max(500),
}).strict();

/**
 * A queued intent is never dispatch proof. The caller may transition a work item to
 * build_dispatched only after this check finds GitHub's canonical workflow-run record.
 */
export function verifyAcceptedImplementationDispatch(raw: unknown):
  | { readonly accepted: true; readonly workflowRunId: string; readonly evidenceUri: string }
  | { readonly accepted: false; readonly reason: "wrong_intent" | "workflow_run_not_found" } {
  const input = DispatchAcceptanceEvidenceSchema.parse(raw);
  const { intent } = input;
  if (intent.type !== "dispatch_workflow" || intent.actorRole !== "builder") return { accepted: false, reason: "wrong_intent" };
  const acceptedAt = Date.parse(input.acceptedAt);
  const expectedPath = `.github/workflows/${intent.workflow}`;
  const match = input.workflowRuns.find((run) =>
    run.headSha === intent.ref &&
    run.workflowPath === expectedPath &&
    run.event === "workflow_dispatch" &&
    Date.parse(run.createdAt) >= acceptedAt,
  );
  return match
    ? { accepted: true, workflowRunId: match.id, evidenceUri: match.evidence.uri }
    : { accepted: false, reason: "workflow_run_not_found" };
}
