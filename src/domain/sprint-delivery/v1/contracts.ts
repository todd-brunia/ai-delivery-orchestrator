import { createHash } from "node:crypto";

import { z } from "zod";

export const WORKFLOW_VERSION = "sprint-delivery/v1" as const;

const repositoryNamePattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const gitShaPattern = /^[a-f0-9]{40}$/;

export const RepositoryNameSchema = z
  .string()
  .regex(repositoryNamePattern, "repository must use owner/name form");

export const IssueNumberSchema = z.number().int().positive();

export const SprintRunStateSchema = z.enum([
  "accepted",
  "collecting_plans",
  "analyzing",
  "active",
  "waiting_for_human",
  "paused",
  "completed",
  "blocked",
  "failed",
  "cancelled",
  "superseded",
]);

export type SprintRunState = z.infer<typeof SprintRunStateSchema>;

export const WorkItemStateSchema = z.enum([
  "discovered",
  "awaiting_plan",
  "feasibility_review",
  "human_plan_approval_required",
  "ready_to_build",
  "dispatch_queued",
  "build_dispatched",
  "building",
  "pr_open",
  "checks_pending",
  "reviewing",
  "fixing",
  "ready_for_human_review",
  "exact_head_captured",
  "automatic_merge_policy_check",
  "ready_for_merger",
  "merge_requested",
  "merged",
  "blocked",
  "failed",
  "cancelled",
  "superseded",
]);

export type WorkItemState = z.infer<typeof WorkItemStateSchema>;

export const MergePolicyModeSchema = z.enum(["human", "automatic"]);
export type MergePolicyMode = z.infer<typeof MergePolicyModeSchema>;

export const EnabledMergePolicySchema = z.literal("human");
export type EnabledMergePolicy = z.infer<typeof EnabledMergePolicySchema>;

export const RUN_AUTHORIZATION_VERSION = "run-authorization/v1" as const;
export const SUPPORTED_AUTOMATIC_MERGE_POLICY_VERSION =
  "automatic-merge/v1" as const;

export const PlanBindingSchema = z
  .object({
    issueNumber: IssueNumberSchema,
    planSha256: z.string().regex(sha256Pattern),
  })
  .strict();

export const RunAuthorizationSchema = z
  .object({
    schemaVersion: z.literal(RUN_AUTHORIZATION_VERSION),
    repository: RepositoryNameSchema,
    issueNumbers: z
      .array(IssueNumberSchema)
      .min(1)
      .max(100)
      .refine(
        (values) => new Set(values).size === values.length,
        "authorization issueNumbers must be unique",
      )
      .refine(
        (values) =>
          values.every(
            (value, index) => index === 0 || values[index - 1]! < value,
          ),
        "authorization issueNumbers must be sorted ascending",
      ),
    plans: z.array(PlanBindingSchema).min(1).max(100),
    defaultBranchSha: z.string().regex(gitShaPattern),
    policy: z
      .object({
        version: z.literal(SUPPORTED_AUTOMATIC_MERGE_POLICY_VERSION),
        sha256: z.string().regex(sha256Pattern),
      })
      .strict(),
    authorizedBy: z
      .object({
        provider: z.literal("github"),
        id: z.string().trim().min(1).max(200),
      })
      .strict(),
    authorizedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    const planIssues = value.plans.map((plan) => plan.issueNumber);
    if (new Set(planIssues).size !== planIssues.length) {
      context.addIssue({ code: "custom", message: "plan issueNumbers must be unique" });
    }
    if (
      planIssues.length !== value.issueNumbers.length ||
      planIssues.some(
        (issueNumber, index) => issueNumber !== value.issueNumbers[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "plans must be sorted and bind every authorized issue exactly once",
      });
    }
  });

export type RunAuthorization = z.infer<typeof RunAuthorizationSchema>;

const sprintRunIdentityFields = {
    workflowVersion: z.literal(WORKFLOW_VERSION),
    repository: RepositoryNameSchema,
    issueNumbers: z
      .array(IssueNumberSchema)
      .min(1)
      .max(100)
      .refine(
        (issueNumbers) => new Set(issueNumbers).size === issueNumbers.length,
        "issueNumbers must be unique",
      ),
};

const HumanSprintRunInputSchema = z
  .object({
    ...sprintRunIdentityFields,
    mergePolicy: z.literal("human"),
  })
  .strict();

const AutomaticSprintRunInputSchema = z
  .object({
    ...sprintRunIdentityFields,
    mergePolicy: z.literal("automatic"),
    authorization: RunAuthorizationSchema,
    authorizationFingerprint: z.string().regex(sha256Pattern),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.repository !== value.authorization.repository) {
      context.addIssue({ code: "custom", message: "authorization repository mismatch" });
    }
    if (
      value.issueNumbers.length !== value.authorization.issueNumbers.length ||
      value.issueNumbers.some(
        (issueNumber, index) => issueNumber !== value.authorization.issueNumbers[index],
      )
    ) {
      context.addIssue({ code: "custom", message: "authorization issue scope mismatch" });
    }
    const expectedFingerprint = createHash("sha256")
      .update(JSON.stringify(value.authorization), "utf8")
      .digest("hex");
    if (value.authorizationFingerprint !== expectedFingerprint) {
      context.addIssue({ code: "custom", message: "authorization fingerprint mismatch" });
    }
  });

export const SprintRunInputSchema = z.discriminatedUnion("mergePolicy", [
  HumanSprintRunInputSchema,
  AutomaticSprintRunInputSchema,
]);

export type SprintRunInput = z.infer<typeof SprintRunInputSchema>;

export const RiskCategorySchema = z.enum([
  "ordinary",
  "security",
  "authentication",
  "secrets",
  "infrastructure",
  "destructive_data",
  "billing",
  "workflow_policy",
  "external_communication",
]);

export type RiskCategory = z.infer<typeof RiskCategorySchema>;

export const SensitiveRiskCategorySchema = RiskCategorySchema.exclude(["ordinary"]);
export type SensitiveRiskCategory = z.infer<typeof SensitiveRiskCategorySchema>;

export const RiskAssessmentSchema = z
  .object({
    categories: z
      .array(RiskCategorySchema)
      .min(1)
      .refine(
        (categories) => new Set(categories).size === categories.length,
        "risk categories must be unique",
      )
      .refine(
        (categories) =>
          !categories.includes("ordinary") || categories.length === 1,
        "ordinary cannot be combined with a sensitive category",
      ),
    confidence: z.enum(["low", "medium", "high"]),
    rationale: z.string().trim().min(1).max(4000),
  })
  .strict();

export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;

export const PlanApprovalRequirementSchema = z.enum([
  "policy_may_approve",
  "human_required",
]);

export type PlanApprovalRequirement = z.infer<
  typeof PlanApprovalRequirementSchema
>;

export const DependencyEdgeSchema = z
  .object({
    prerequisiteIssueNumber: IssueNumberSchema,
    dependentIssueNumber: IssueNumberSchema,
    kind: z.literal("blocks"),
  })
  .strict()
  .refine(
    (edge) => edge.prerequisiteIssueNumber !== edge.dependentIssueNumber,
    "an issue cannot depend on itself",
  );

export type DependencyEdge = z.infer<typeof DependencyEdgeSchema>;

export const ConflictDomainSchema = z
  .object({
    kind: z.enum(["path", "resource", "policy"]),
    value: z.string().trim().min(1).max(500),
    confidence: z.enum(["low", "medium", "high"]),
  })
  .strict();

export type ConflictDomain = z.infer<typeof ConflictDomainSchema>;

export const TransitionActorSchema = z
  .object({
    kind: z.enum(["human", "github_app", "system", "model"]),
    id: z.string().trim().min(1).max(200),
  })
  .strict();

export const EvidenceReferenceSchema = z
  .object({
    kind: z.enum([
      "issue",
      "plan",
      "commit",
      "workflow_run",
      "pull_request",
      "check",
      "review",
      "policy",
    ]),
    uri: z.string().trim().min(1).max(2000),
    sha256: z.string().regex(sha256Pattern).optional(),
  })
  .strict();

export const TransitionMetadataSchema = z
  .object({
    transitionId: z.uuid(),
    aggregateId: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: z.string().regex(idempotencyKeyPattern),
    occurredAt: z.iso.datetime({ offset: true }),
    actor: TransitionActorSchema,
    evidence: z.array(EvidenceReferenceSchema).min(1).max(50),
  })
  .strict();

export type TransitionMetadata = z.infer<typeof TransitionMetadataSchema>;

const commandMetadata = { metadata: TransitionMetadataSchema };

export const SprintRunCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("collect_plans"), ...commandMetadata }).strict(),
  z.object({ type: z.literal("analyze"), ...commandMetadata }).strict(),
  z.object({ type: z.literal("activate"), ...commandMetadata }).strict(),
  z.object({ type: z.literal("wait_for_human"), ...commandMetadata }).strict(),
  z.object({ type: z.literal("pause"), ...commandMetadata }).strict(),
  z
    .object({
      type: z.literal("resume"),
      target: z.enum([
        "collecting_plans",
        "analyzing",
        "active",
        "waiting_for_human",
      ]),
      ...commandMetadata,
    })
    .strict(),
  z.object({ type: z.literal("complete"), ...commandMetadata }).strict(),
  z.object({ type: z.literal("block"), ...commandMetadata }).strict(),
  z.object({ type: z.literal("fail"), ...commandMetadata }).strict(),
  z.object({ type: z.literal("cancel"), ...commandMetadata }).strict(),
  z.object({ type: z.literal("supersede"), ...commandMetadata }).strict(),
  z.object({ type: z.literal("reconcile"), ...commandMetadata }).strict(),
]);

export type SprintRunCommand = z.infer<typeof SprintRunCommandSchema>;

export const WorkItemCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("request_plan"), ...commandMetadata }).strict(),
  z.object({ type: z.literal("review_feasibility"), ...commandMetadata }).strict(),
  z
    .object({ type: z.literal("require_human_approval"), ...commandMetadata })
    .strict(),
  z.object({ type: z.literal("authorize_build"), ...commandMetadata }).strict(),
  z.object({ type: z.literal("dispatch_build"), ...commandMetadata }).strict(),
  z.object({ type: z.literal("record_build_started"), ...commandMetadata }).strict(),
  z.object({ type: z.literal("record_pr_opened"), ...commandMetadata }).strict(),
  z.object({ type: z.literal("wait_for_checks"), ...commandMetadata }).strict(),
  z.object({ type: z.literal("start_review"), ...commandMetadata }).strict(),
  z.object({ type: z.literal("request_repair"), ...commandMetadata }).strict(),
  z
    .object({ type: z.literal("mark_ready_for_human"), ...commandMetadata })
    .strict(),
  z.object({ type: z.literal("record_merge"), ...commandMetadata }).strict(),
  z.object({ type: z.literal("block"), ...commandMetadata }).strict(),
  z.object({ type: z.literal("fail"), ...commandMetadata }).strict(),
  z.object({ type: z.literal("cancel"), ...commandMetadata }).strict(),
  z.object({ type: z.literal("supersede"), ...commandMetadata }).strict(),
]);

export type WorkItemCommand = z.infer<typeof WorkItemCommandSchema>;

export const SprintRunEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("plan_collection_started") }).strict(),
  z.object({ type: z.literal("analysis_started") }).strict(),
  z.object({ type: z.literal("activated") }).strict(),
  z.object({ type: z.literal("human_attention_required") }).strict(),
  z.object({ type: z.literal("paused") }).strict(),
  z
    .object({
      type: z.literal("resumed"),
      target: z.enum([
        "collecting_plans",
        "analyzing",
        "active",
        "waiting_for_human",
      ]),
    })
    .strict(),
  z.object({ type: z.literal("completed") }).strict(),
  z.object({ type: z.literal("blocked") }).strict(),
  z.object({ type: z.literal("failed") }).strict(),
  z.object({ type: z.literal("cancelled") }).strict(),
  z.object({ type: z.literal("superseded") }).strict(),
  z.object({ type: z.literal("reconciled") }).strict(),
]);

export type SprintRunEvent = z.infer<typeof SprintRunEventSchema>;

export const WorkItemEventSchema = z.enum([
  "plan_requested",
  "plan_available",
  "human_plan_approval_required",
  "build_authorized",
  "dispatch_queued",
  "build_dispatched",
  "build_started",
  "pull_request_opened",
  "checks_awaited",
  "review_started",
  "repair_requested",
  "human_review_ready",
  "merged",
  "blocked",
  "failed",
  "cancelled",
  "superseded",
]);

export type WorkItemEvent = z.infer<typeof WorkItemEventSchema>;
