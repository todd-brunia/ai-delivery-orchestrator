import { z } from "zod";

import {
  RepositoryNameSchema,
  SensitiveRiskCategorySchema,
} from "./contracts.js";

const nonemptyUniqueStrings = z
  .array(z.string().trim().min(1).max(500))
  .refine((values) => new Set(values).size === values.length, "values must be unique");

const workflowFileSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\.ya?ml$/, "workflow must be a YAML file name");

export const RepositoryAdapterConfigV1Schema = z
  .object({
    version: z.literal(1),
    repository: RepositoryNameSchema,
    defaultBranch: z.string().regex(/^[A-Za-z0-9._/-]+$/),
    enabled: z.boolean(),
    orchestratorAppSlug: z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/),
    workflows: z
      .object({
        implementation: workflowFileSchema,
        repair: workflowFileSchema,
        sync: workflowFileSchema,
      })
      .strict(),
    labels: z
      .object({
        needsPlanning: z.string().trim().min(1).max(50),
        planReady: z.string().trim().min(1).max(50),
        approvedForBuild: z.string().trim().min(1).max(50),
        approvedForAiBuild: z.string().trim().min(1).max(50),
        inProgress: z.string().trim().min(1).max(50),
        previewReady: z.string().trim().min(1).max(50),
        needsDecision: z.string().trim().min(1).max(50),
        blocked: z.string().trim().min(1).max(50),
      })
      .strict()
      .refine(
        (labels) => new Set(Object.values(labels)).size === Object.values(labels).length,
        "workflow labels must be unique",
      ),
    requiredChecks: nonemptyUniqueStrings.min(1).max(50),
    maxParallelImplementations: z.number().int().min(1).max(2),
    risk: z
      .object({
        humanApprovalCategories: z
          .array(SensitiveRiskCategorySchema)
          .min(1)
          .refine(
            (categories) => new Set(categories).size === categories.length,
            "human approval categories must be unique",
          ),
        humanApprovalLabels: nonemptyUniqueStrings.max(100),
        humanApprovalPathPatterns: nonemptyUniqueStrings.max(100),
      })
      .strict(),
  })
  .strict();

export type RepositoryAdapterConfigV1 = z.infer<
  typeof RepositoryAdapterConfigV1Schema
>;

export function parseRepositoryAdapterConfigV1(
  input: unknown,
): RepositoryAdapterConfigV1 {
  return RepositoryAdapterConfigV1Schema.parse(input);
}
