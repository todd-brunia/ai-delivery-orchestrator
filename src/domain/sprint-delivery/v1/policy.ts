import type {
  PlanApprovalRequirement,
  RiskAssessment,
  SensitiveRiskCategory,
} from "./contracts.js";

export const DEFAULT_HUMAN_APPROVAL_CATEGORIES = new Set<SensitiveRiskCategory>([
  "security",
  "authentication",
  "secrets",
  "infrastructure",
  "destructive_data",
  "billing",
  "workflow_policy",
  "external_communication",
]);

export function planApprovalRequirement(
  assessment: RiskAssessment,
  humanApprovalCategories: ReadonlySet<SensitiveRiskCategory> =
    DEFAULT_HUMAN_APPROVAL_CATEGORIES,
): PlanApprovalRequirement {
  if (assessment.confidence === "low") return "human_required";

  return assessment.categories.some(
    (category) => category !== "ordinary" && humanApprovalCategories.has(category),
  )
    ? "human_required"
    : "policy_may_approve";
}
