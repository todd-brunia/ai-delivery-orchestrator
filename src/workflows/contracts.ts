import { z } from "zod";

import { ReconciliationReportSchema, SchedulingDecisionSchema, WORKFLOW_VERSION } from "../domain/sprint-delivery/v1/index.js";
import { FeasibilityResultSchema, PROVIDER_CONTRACT_VERSION } from "../providers/v1/index.js";

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const DryRunWorkflowRequestSchema = z.object({
  workflowVersion: z.literal(WORKFLOW_VERSION),
  providerMode: z.literal("stub"),
  runId: z.uuid(),
  threadId: z.string().min(1).max(200),
  defaultBranchSha: shaSchema,
  planFingerprints: z.record(z.string().regex(/^[1-9][0-9]*$/), fingerprintSchema),
  occurredAt: z.iso.datetime({ offset: true }),
}).strict();

export type DryRunWorkflowRequest = z.infer<typeof DryRunWorkflowRequestSchema>;

export const DryRunWorkflowResultSchema = z.object({
  workflowVersion: z.literal(WORKFLOW_VERSION),
  providerContractVersion: z.literal(PROVIDER_CONTRACT_VERSION),
  runId: z.uuid(),
  threadId: z.string().min(1),
  status: z.enum(["active", "waiting_for_human"]),
  issueNumbers: z.array(z.number().int().positive()).min(1),
  analysis: FeasibilityResultSchema,
  schedule: SchedulingDecisionSchema,
  reconciliation: ReconciliationReportSchema,
}).strict();

export type DryRunWorkflowResult = z.infer<typeof DryRunWorkflowResultSchema>;

export interface DryRunWorkflowRuntime {
  execute(request: DryRunWorkflowRequest): Promise<DryRunWorkflowResult>;
  resume(threadId: string): Promise<DryRunWorkflowResult>;
}
