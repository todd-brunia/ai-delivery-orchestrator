import { createHash } from "node:crypto";

import { z } from "zod";

import {
  EvidenceReferenceSchema,
  IssueNumberSchema,
  WORKFLOW_VERSION,
  type ConflictDomain,
  type DependencyEdge,
} from "./contracts.js";
import { decideParallelism } from "./dependencies.js";

export const SCHEDULING_POLICY_VERSION = "dry-run-scheduling/v1" as const;
const PROVIDER_CONTRACT_VERSION = "providers/v1" as const;

export const ScheduleBlockerSchema = z.object({
  issueNumber: IssueNumberSchema,
  reasons: z.array(z.enum([
    "unresolved_prerequisite", "dependency_path", "parallel_limit_reached",
    "low_confidence", "conflict_domain_overlap", "active_capacity_exhausted",
  ])).min(1),
  relatedIssueNumbers: z.array(IssueNumberSchema),
}).strict();

export const ProposedActionSchema = z.object({
  idempotencyKey: z.string().min(8).max(200),
  type: z.enum(["set_labels", "dispatch_workflow"]),
  issueNumber: IssueNumberSchema,
  parameters: z.record(z.string(), z.unknown()),
}).strict();

export const SchedulingDecisionSchema = z.object({
  version: z.literal("schedule-decision/v1"),
  workflowVersion: z.literal(WORKFLOW_VERSION),
  providerContractVersion: z.literal(PROVIDER_CONTRACT_VERSION),
  policyVersion: z.literal(SCHEDULING_POLICY_VERSION),
  runId: z.uuid(),
  activeImplementationCount: z.number().int().min(0).max(2),
  maximumConcurrentImplementations: z.number().int().min(1).max(2),
  selectedIssueNumbers: z.array(IssueNumberSchema).max(2),
  blockers: z.array(ScheduleBlockerSchema),
  proposedActions: z.array(ProposedActionSchema),
  evidence: z.array(EvidenceReferenceSchema).min(1),
}).strict();
export type SchedulingDecision = z.infer<typeof SchedulingDecisionSchema>;

export const DriftObservationSchema = z.object({
  issueNumber: IssueNumberSchema,
  field: z.enum(["identity", "state", "labels", "updated_at", "plan_fingerprint"]),
  severity: z.enum(["informational", "invalidating"]),
  expected: z.string(),
  observed: z.string(),
}).strict();

export const ReconciliationReportSchema = z.object({
  version: z.literal("reconciliation-report/v1"),
  workflowVersion: z.literal(WORKFLOW_VERSION),
  providerContractVersion: z.literal(PROVIDER_CONTRACT_VERSION),
  policyVersion: z.literal(SCHEDULING_POLICY_VERSION),
  runId: z.uuid(),
  reconciledAt: z.iso.datetime({ offset: true }),
  drift: z.array(DriftObservationSchema),
  valid: z.boolean(),
  evidence: z.array(EvidenceReferenceSchema).min(1),
}).strict();
export type ReconciliationReport = z.infer<typeof ReconciliationReportSchema>;

export interface SchedulingCandidate {
  readonly issueNumber: number;
  readonly state: string;
  readonly conflictDomains: readonly ConflictDomain[];
}

export function scheduleDryRun(input: {
  runId: string;
  candidates: readonly SchedulingCandidate[];
  dependencies: readonly DependencyEdge[];
  mergedIssueNumbers: readonly number[];
  activeImplementationCount: number;
  /** Adapter-constrained capacity; repository policy may never exceed two. */
  maximumConcurrentImplementations?: 1 | 2;
  evidence: SchedulingDecision["evidence"];
}): SchedulingDecision {
  const maximumConcurrentImplementations = input.maximumConcurrentImplementations ?? 2;
  if (!Number.isInteger(input.activeImplementationCount) || input.activeImplementationCount < 0 || input.activeImplementationCount > maximumConcurrentImplementations) {
    throw new Error("activeImplementationCount must be an integer between zero and two");
  }
  const merged = new Set(input.mergedIssueNumbers);
  const selected: SchedulingCandidate[] = [];
  const blockers: z.infer<typeof ScheduleBlockerSchema>[] = [];
  const capacity = maximumConcurrentImplementations - input.activeImplementationCount;
  for (const candidate of [...input.candidates].sort((a, b) => a.issueNumber - b.issueNumber)) {
    const prerequisites = input.dependencies
      .filter((edge) => edge.dependentIssueNumber === candidate.issueNumber && !merged.has(edge.prerequisiteIssueNumber))
      .map((edge) => edge.prerequisiteIssueNumber).sort((a, b) => a - b);
    if (prerequisites.length > 0) {
      blockers.push({ issueNumber: candidate.issueNumber, reasons: ["unresolved_prerequisite"], relatedIssueNumbers: prerequisites });
      continue;
    }
    if (selected.length >= capacity) {
      blockers.push({ issueNumber: candidate.issueNumber, reasons: [capacity === 0 ? "active_capacity_exhausted" : "parallel_limit_reached"], relatedIssueNumbers: selected.map((item) => item.issueNumber) });
      continue;
    }
    const incompatible = selected.flatMap((other) => {
      const decision = decideParallelism(
        { issueNumber: other.issueNumber, conflictDomains: other.conflictDomains },
        { issueNumber: candidate.issueNumber, conflictDomains: candidate.conflictDomains },
        input.dependencies,
        input.activeImplementationCount + selected.length - 1,
      );
      return decision.allowed ? [] : [{ other, reasons: decision.reasons }];
    });
    if (incompatible.length > 0) {
      blockers.push(ScheduleBlockerSchema.parse({ issueNumber: candidate.issueNumber, reasons: [...new Set(incompatible.flatMap(({ reasons }) => reasons))], relatedIssueNumbers: incompatible.map(({ other }) => other.issueNumber) }));
      continue;
    }
    selected.push(candidate);
  }
  const proposedActions = selected.flatMap((item) => (["set_labels", "dispatch_workflow"] as const).map((type) => ({
    idempotencyKey: `schedule:${input.runId}:issue:${item.issueNumber}:${type}`,
    type,
    issueNumber: item.issueNumber,
    parameters: type === "set_labels" ? { labels: ["implementation-proposed"] } : { workflow: "implementation", dryRun: true },
  })));
  return SchedulingDecisionSchema.parse({
    version: "schedule-decision/v1", workflowVersion: WORKFLOW_VERSION,
    providerContractVersion: PROVIDER_CONTRACT_VERSION, policyVersion: SCHEDULING_POLICY_VERSION,
    runId: input.runId, activeImplementationCount: input.activeImplementationCount,
    maximumConcurrentImplementations, selectedIssueNumbers: selected.map((item) => item.issueNumber),
    blockers, proposedActions, evidence: input.evidence,
  });
}

export function planFingerprint(title: string, body: string): string {
  return createHash("sha256").update(JSON.stringify({ title, body })).digest("hex");
}
