import { z } from "zod";

import { githubReadValidationFailure, githubRepositoryReadCheckpointFailure, GitHubReadError, OpenAiAnalysisError } from "../../providers/v1/index.js";

export const SupervisedFailureStageSchema = z.enum([
  "configuration",
  "secret_access",
  "canonical_read",
  "database",
  "model_analysis",
  "policy",
  "execution_gate",
  "unexpected",
]);
export type SupervisedFailureStage = z.infer<typeof SupervisedFailureStageSchema>;

export const SupervisedFailureCategorySchema = z.enum([
  "invalid_input",
  "authentication",
  "authorization",
  "rate_limited",
  "timeout",
  "transport",
  "invalid_response",
  "response_bounds",
  "not_found",
  "artifact_mismatch",
  "model_mismatch",
  "unexpected",
]);
export type SupervisedFailureCategory = z.infer<typeof SupervisedFailureCategorySchema>;

export const SupervisedCanonicalOperationSchema = z.enum([
  "default_branch_ref",
  "workflow_at_ref",
  "issue",
  "marked_plan",
  "repository_configuration",
  "installation",
  "human_approval",
]);
export type SupervisedCanonicalOperation = z.infer<typeof SupervisedCanonicalOperationSchema>;

export const SupervisedRepositoryConfigurationFieldSchema = z.enum([
  "repository",
  "repository_id",
  "default_branch",
  "visibility",
  "allow_squash_merge",
  "archive",
  "fingerprint",
  "evidence",
  "unknown_field",
]);
export type SupervisedRepositoryConfigurationField = z.infer<typeof SupervisedRepositoryConfigurationFieldSchema>;

export const SupervisedValidationReasonSchema = z.enum(["missing", "wrong_type", "invalid_value", "unknown_reason"]);
export type SupervisedValidationReason = z.infer<typeof SupervisedValidationReasonSchema>;

export const SupervisedRepositoryReadCheckpointSchema = z.enum(["response_read", "snapshot", "schema_validation", "failure_handoff", "unknown_checkpoint"]);
export type SupervisedRepositoryReadCheckpoint = z.infer<typeof SupervisedRepositoryReadCheckpointSchema>;

export const SupervisedFailureDiagnosticSchema = z.object({
  version: z.literal("supervised-runtime-diagnostic/v1"),
  event: z.literal("supervised_dispatch_failed"),
  stage: SupervisedFailureStageSchema,
  category: SupervisedFailureCategorySchema,
  operation: SupervisedCanonicalOperationSchema.optional(),
  field: SupervisedRepositoryConfigurationFieldSchema.optional(),
  reason: SupervisedValidationReasonSchema.optional(),
  checkpoint: SupervisedRepositoryReadCheckpointSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.operation && value.stage !== "canonical_read") {
    context.addIssue({ code: "custom", path: ["operation"], message: "operation is limited to canonical-read failures" });
  }
  if (value.field && (value.stage !== "canonical_read" || value.category !== "invalid_input" || value.operation !== "repository_configuration")) {
    context.addIssue({ code: "custom", path: ["field"], message: "field is limited to invalid repository-configuration reads" });
  }
  if (value.reason && (value.stage !== "canonical_read" || value.category !== "invalid_input" || value.operation !== "repository_configuration" || !value.field)) {
    context.addIssue({ code: "custom", path: ["reason"], message: "reason requires an invalid repository-configuration field" });
  }
  if (value.checkpoint && (value.stage !== "canonical_read" || value.category !== "unexpected" || value.operation !== "repository_configuration" || value.field || value.reason)) {
    context.addIssue({ code: "custom", path: ["checkpoint"], message: "checkpoint is limited to unexpected repository-configuration reads" });
  }
});
export type SupervisedFailureDiagnostic = z.infer<typeof SupervisedFailureDiagnosticSchema>;

export class SupervisedDiagnosticError extends Error {
  constructor(readonly stage: SupervisedFailureStage, readonly category: SupervisedFailureCategory, readonly operation?: SupervisedCanonicalOperation, readonly field?: SupervisedRepositoryConfigurationField, readonly reason?: SupervisedValidationReason, readonly checkpoint?: SupervisedRepositoryReadCheckpoint) {
    super("supervised operation failed");
  }
}

function categoryFor(error: unknown): SupervisedFailureCategory {
  if (error instanceof z.ZodError || error instanceof SyntaxError || githubReadValidationFailure(error)) return "invalid_input";
  if (error instanceof OpenAiAnalysisError || error instanceof GitHubReadError) return error.code;
  return "unexpected";
}

export function supervisedFailure(stage: SupervisedFailureStage, error: unknown): SupervisedDiagnosticError {
  return error instanceof SupervisedDiagnosticError ? error : new SupervisedDiagnosticError(stage, categoryFor(error));
}

export async function withinSupervisedStage<T>(stage: SupervisedFailureStage, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw supervisedFailure(stage, error);
  }
}

export function withinSupervisedStageSync<T>(stage: SupervisedFailureStage, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw supervisedFailure(stage, error);
  }
}

export function supervisedFailureDiagnostic(error: unknown): SupervisedFailureDiagnostic {
  const normalized = error instanceof SupervisedDiagnosticError
    ? error
    : new SupervisedDiagnosticError("unexpected", "unexpected");
  return SupervisedFailureDiagnosticSchema.parse({
    version: "supervised-runtime-diagnostic/v1",
    event: "supervised_dispatch_failed",
    stage: normalized.stage,
    category: normalized.category,
    ...(normalized.stage === "canonical_read" && normalized.operation ? { operation: normalized.operation } : {}),
    ...(normalized.stage === "canonical_read" && normalized.category === "invalid_input" && normalized.operation === "repository_configuration" && normalized.field ? { field: normalized.field } : {}),
    ...(normalized.stage === "canonical_read" && normalized.category === "invalid_input" && normalized.operation === "repository_configuration" && normalized.field && normalized.reason ? { reason: normalized.reason } : {}),
    ...(normalized.stage === "canonical_read" && normalized.category === "unexpected" && normalized.operation === "repository_configuration" && normalized.checkpoint ? { checkpoint: normalized.checkpoint } : {}),
  });
}

const canonicalMethodOperations: Readonly<Record<string, SupervisedCanonicalOperation>> = {
  getDefaultBranchHead: "default_branch_ref",
  assertWorkflowAtRef: "workflow_at_ref",
  getIssue: "issue",
  getMarkedPlan: "marked_plan",
  getRepositoryConfiguration: "repository_configuration",
  getInstallation: "installation",
  getHumanBuildApprovals: "human_approval",
};

const repositoryConfigurationFields: Readonly<Record<string, SupervisedRepositoryConfigurationField>> = {
  repository: "repository",
  repositoryId: "repository_id",
  defaultBranch: "default_branch",
  visibility: "visibility",
  allowSquashMerge: "allow_squash_merge",
  archive: "archive",
  configurationSha256: "fingerprint",
  evidence: "evidence",
};

function repositoryConfigurationField(error: unknown): SupervisedRepositoryConfigurationField | undefined {
  const failure = githubReadValidationFailure(error);
  const segment = failure?.field ?? (error instanceof z.ZodError ? error.issues[0]?.path[0] : undefined);
  if (!failure && !(error instanceof z.ZodError)) return undefined;
  return typeof segment === "string" ? repositoryConfigurationFields[segment] ?? "unknown_field" : "unknown_field";
}

async function withinCanonicalOperation<T>(operation: SupervisedCanonicalOperation, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const normalized = supervisedFailure("canonical_read", error);
    if (normalized.stage !== "canonical_read" || normalized.operation) throw normalized;
    const field = operation === "repository_configuration" && normalized.category === "invalid_input"
      ? repositoryConfigurationField(error)
      : undefined;
    const reason = githubReadValidationFailure(error)?.reason ?? (field ? "unknown_reason" : undefined);
    const checkpoint = operation === "repository_configuration" && normalized.category === "unexpected"
      ? githubRepositoryReadCheckpointFailure(error)?.checkpoint
      : undefined;
    throw new SupervisedDiagnosticError(normalized.stage, normalized.category, operation, field, reason, checkpoint);
  }
}

/** Decorates only named canonical reads; arbitrary method names cannot become diagnostic values. */
export function instrumentSupervisedCanonicalReads<T extends object>(source: T): T {
  return new Proxy(source, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const operation = typeof property === "string" ? canonicalMethodOperations[property] : undefined;
      if (!operation) return value.bind(target) as unknown;
      return ((...args: readonly unknown[]) => withinCanonicalOperation(operation, () => Reflect.apply(value, receiver, args) as Promise<unknown>)) as unknown;
    },
  });
}
