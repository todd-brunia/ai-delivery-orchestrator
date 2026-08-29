import { z } from "zod";

import { FeasibilityResultSchema, type FeasibilityResult } from "../../../providers/v1/contracts.js";
import { planApprovalRequirement } from "./policy.js";

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Canonical, attributable evidence observed independently of the orchestrator. */
export const HumanBuildApprovalSchema = z.object({
  issueNumber: z.number().int().positive(),
  planSha256: fingerprintSchema,
  actor: z.object({ kind: z.literal("human"), id: z.string().trim().min(1).max(200) }).strict(),
  approvedAt: z.iso.datetime({ offset: true }),
  evidenceUri: z.string().min(1).max(2_000),
}).strict();
export type HumanBuildApproval = z.infer<typeof HumanBuildApprovalSchema>;

export function validateFeasibilityForRun(raw: unknown, issueNumbers: readonly number[]): FeasibilityResult {
  const result = FeasibilityResultSchema.parse(raw);
  const scope = new Set(issueNumbers);
  if (!result.feasible || result.unresolvedDecisions.length > 0) throw new Error("feasibility analysis did not authorize workflow progress");
  if (new Set(issueNumbers).size !== issueNumbers.length || issueNumbers.length === 0) throw new Error("run issue scope is invalid");
  const conflicts = result.conflicts.map(({ issueNumber }) => issueNumber);
  if (conflicts.length !== issueNumbers.length || new Set(conflicts).size !== conflicts.length || conflicts.some((issue) => !scope.has(issue))) throw new Error("conflict analysis must cover every workflow issue exactly once");
  if (result.dependencies.some((edge) => !scope.has(edge.prerequisiteIssueNumber) || !scope.has(edge.dependentIssueNumber))) throw new Error("feasibility dependencies must remain within the immutable issue scope");
  return result;
}

export function authorizeBuild(
  analysis: FeasibilityResult,
  issueNumber: number,
  planSha256: string,
  approvals: readonly HumanBuildApproval[],
): { readonly authorized: true } | { readonly authorized: false; readonly reason: "human_approval_required" | "approval_plan_drift" } {
  if (planApprovalRequirement(analysis.risk) === "policy_may_approve") return { authorized: true };
  const relevant = approvals.filter((approval) => approval.issueNumber === issueNumber).map((approval) => HumanBuildApprovalSchema.parse(approval));
  if (relevant.some((approval) => approval.planSha256 === planSha256)) return { authorized: true };
  return { authorized: false, reason: relevant.length > 0 ? "approval_plan_drift" : "human_approval_required" };
}
