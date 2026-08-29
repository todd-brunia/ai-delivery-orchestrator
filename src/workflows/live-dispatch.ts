import { createHash } from "node:crypto";

import { z } from "zod";

import {
  RepositoryAdapterConfigV1Schema,
  RepositoryNameSchema,
  type RepositoryAdapterConfigV1,
} from "../domain/sprint-delivery/v1/index.js";
import {
  CanonicalInstallationSchema,
  CanonicalIssueSchema,
  CanonicalPlanSchema,
  CanonicalRepositoryConfigurationSchema,
  GitHubExecutionIntentSchema,
  type GitHubExecutionIntent,
} from "../providers/v1/index.js";

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

export function adapterFingerprint(adapter: RepositoryAdapterConfigV1): string {
  return createHash("sha256").update(JSON.stringify(RepositoryAdapterConfigV1Schema.parse(adapter)), "utf8").digest("hex");
}
