import { z } from "zod";

import { GitHubReadError, OpenAiAnalysisError } from "../../providers/v1/index.js";

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

export const SupervisedFailureDiagnosticSchema = z.object({
  version: z.literal("supervised-runtime-diagnostic/v1"),
  event: z.literal("supervised_dispatch_failed"),
  stage: SupervisedFailureStageSchema,
  category: SupervisedFailureCategorySchema,
  operation: SupervisedCanonicalOperationSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.operation && value.stage !== "canonical_read") {
    context.addIssue({ code: "custom", path: ["operation"], message: "operation is limited to canonical-read failures" });
  }
});
export type SupervisedFailureDiagnostic = z.infer<typeof SupervisedFailureDiagnosticSchema>;

export class SupervisedDiagnosticError extends Error {
  constructor(readonly stage: SupervisedFailureStage, readonly category: SupervisedFailureCategory, readonly operation?: SupervisedCanonicalOperation) {
    super("supervised operation failed");
  }
}

function categoryFor(error: unknown): SupervisedFailureCategory {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return "invalid_input";
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

async function withinCanonicalOperation<T>(operation: SupervisedCanonicalOperation, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const normalized = supervisedFailure("canonical_read", error);
    if (normalized.stage !== "canonical_read" || normalized.operation) throw normalized;
    throw new SupervisedDiagnosticError(normalized.stage, normalized.category, operation);
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
