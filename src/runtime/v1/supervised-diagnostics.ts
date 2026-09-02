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

export const SupervisedFailureDiagnosticSchema = z.object({
  version: z.literal("supervised-runtime-diagnostic/v1"),
  event: z.literal("supervised_dispatch_failed"),
  stage: SupervisedFailureStageSchema,
  category: SupervisedFailureCategorySchema,
}).strict();
export type SupervisedFailureDiagnostic = z.infer<typeof SupervisedFailureDiagnosticSchema>;

export class SupervisedDiagnosticError extends Error {
  constructor(readonly stage: SupervisedFailureStage, readonly category: SupervisedFailureCategory) {
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
  });
}
