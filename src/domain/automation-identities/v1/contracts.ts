import { z } from "zod";

export const AUTOMATION_IDENTITY_CONTRACT_VERSION = "automation-identities/v1" as const;

export const AutomationRoleSchema = z.enum(["builder", "reviewer", "merger"]);
export type AutomationRole = z.infer<typeof AutomationRoleSchema>;

export const AutomationOperationSchema = z.enum([
  "set_workflow_labels",
  "dispatch_allowlisted_workflow",
  "mark_exact_head_ready_for_review",
  "read_pull_request_evidence",
  "submit_exact_head_review",
  "request_exact_head_squash_merge",
]);
export type AutomationOperation = z.infer<typeof AutomationOperationSchema>;

export const GitHubPermissionSchema = z.enum([
  "metadata:read",
  "contents:read",
  "contents:write",
  "checks:read",
  "issues:write",
  "actions:write",
  "pull_requests:read",
  "pull_requests:write",
]);

const positiveId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const repositoryName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const secretContainerName = z
  .string()
  .regex(/^ai-delivery-orchestrator\/pilot\/github-app-(builder|reviewer|merger)-private-key$/);

export const TokenAudienceSchema = z
  .object({
    installationAccount: z.literal("todd-brunia"),
    repositoryIds: z.array(positiveId).length(1),
    repositories: z.array(z.literal("todd-brunia/ai-consulting-client-portal")).length(1),
  })
  .strict();

export const AutomationIdentityContractSchema = z
  .object({
    schemaVersion: z.literal(AUTOMATION_IDENTITY_CONTRACT_VERSION),
    configurationRevision: z.string().regex(/^[a-f0-9]{64}$/),
    role: AutomationRoleSchema,
    appSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    appId: positiveId,
    installationId: positiveId,
    tokenAudience: TokenAudienceSchema,
    permissionCeiling: z.array(GitHubPermissionSchema).min(1),
    allowedOperations: z.array(AutomationOperationSchema).min(1),
    forbiddenOperations: z.array(z.string().min(1).max(100)).min(1),
    secretContainerName,
  })
  .strict()
  .superRefine((identity, context) => {
    const rolePolicy = {
      builder: {
        permissions: ["metadata:read", "contents:write", "issues:write", "actions:write", "pull_requests:write"],
        operations: ["set_workflow_labels", "dispatch_allowlisted_workflow", "mark_exact_head_ready_for_review"],
      },
      reviewer: {
        permissions: ["metadata:read", "contents:read", "checks:read", "pull_requests:write"],
        operations: ["read_pull_request_evidence", "submit_exact_head_review"],
      },
      merger: {
        permissions: ["metadata:read", "contents:write"],
        operations: ["read_pull_request_evidence", "request_exact_head_squash_merge"],
      },
    } as const;
    const expectedSlug = `todd-brunia-ai-delivery-${identity.role}`;
    if (identity.appSlug !== expectedSlug) {
      context.addIssue({ code: "custom", message: `appSlug must be ${expectedSlug}` });
    }
    if (new Set(identity.permissionCeiling).size !== identity.permissionCeiling.length) {
      context.addIssue({ code: "custom", message: "permissionCeiling must be unique" });
    }
    if (new Set(identity.allowedOperations).size !== identity.allowedOperations.length) {
      context.addIssue({ code: "custom", message: "allowedOperations must be unique" });
    }
    const expected = rolePolicy[identity.role];
    if (JSON.stringify(identity.permissionCeiling) !== JSON.stringify(expected.permissions)) {
      context.addIssue({ code: "custom", message: "permissionCeiling must exactly match role policy" });
    }
    if (JSON.stringify(identity.allowedOperations) !== JSON.stringify(expected.operations)) {
      context.addIssue({ code: "custom", message: "allowedOperations must exactly match role policy" });
    }
    if (identity.forbiddenOperations.some((value) => /private.?key|token|credential/i.test(value))) {
      context.addIssue({ code: "custom", message: "forbiddenOperations must not contain credential-shaped values" });
    }
    if (!identity.secretContainerName.endsWith(`github-app-${identity.role}-private-key`)) {
      context.addIssue({ code: "custom", message: "secret container must match role" });
    }
  });

export type AutomationIdentityContract = z.infer<typeof AutomationIdentityContractSchema>;

export const AutomationIdentitySetSchema = z
  .array(AutomationIdentityContractSchema)
  .length(3)
  .superRefine((identities, context) => {
    for (const key of ["role", "appId", "installationId", "secretContainerName"] as const) {
      if (new Set(identities.map((identity) => identity[key])).size !== identities.length) {
        context.addIssue({ code: "custom", message: `${key} must be unique across identities` });
      }
    }
  });

export const ProtectionObservationSchema = z
  .object({
    available: z.literal(true),
    repositoryId: positiveId,
    repository: z.literal("todd-brunia/ai-consulting-client-portal"),
    visibility: z.literal("public"),
    baseBranch: z.literal("main"),
    requiredStatusCheck: z.literal("CI Gate"),
    strictStatusChecks: z.literal(true),
    requiredApprovals: z.number().int().min(1),
    dismissStaleReviews: z.literal(true),
    requireLastPushApproval: z.literal(true),
    requireConversationResolution: z.literal(true),
    enforceAdmins: z.literal(true),
    requireLinearHistory: z.literal(true),
    squashMergeAllowed: z.literal(true),
    mergeCommitAllowed: z.literal(false),
    rebaseMergeAllowed: z.literal(false),
    autoMergeAllowed: z.literal(false),
  })
  .strict();

export const IdentityObservationSchema = z
  .object({
    appSlug: z.string(),
    appId: positiveId,
    installationId: positiveId,
    installationAccount: z.string(),
    repositoryIds: z.array(positiveId),
    repositories: z.array(repositoryName),
    permissions: z.array(GitHubPermissionSchema),
  })
  .strict();
