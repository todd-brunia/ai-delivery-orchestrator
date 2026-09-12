import { z } from "zod";
import { FeasibilityResultSchema } from "../../providers/v1/contracts.js";
import { contentHash, decisionPrompts, evidenceSegments, EvidenceSegmentSchema, SupervisedDecisionSchema, SupervisedInputProvenanceSchema, type SupervisedAnalysisEnvelope } from "../../providers/v1/supervised-analysis.js";

const reportDecisionSchema = SupervisedDecisionSchema.extend({ reviewPrompt: z.string().max(150) }).strict()
  .refine(value => value.reviewPrompt === decisionPrompts[value.code], "review prompt must match the fixed template");
const payloadSchema = z.object({
  version: z.literal("supervised-decision-report/v1"), event: z.literal("supervised_decision_report"),
  authority: z.literal("model_reported_not_verified"), executionEnabled: z.boolean(),
  observedAt: z.iso.datetime({ offset: true }), provenance: SupervisedInputProvenanceSchema,
  unresolvedCount: z.number().int().min(1).max(16),
  decisions: z.array(reportDecisionSchema).min(1).max(16),
  evidence: z.array(EvidenceSegmentSchema).max(64),
}).strict();
export const SupervisedDecisionReportSchema = payloadSchema.extend({ reportSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().superRefine((value, context) => {
  const { reportSha256, ...payload } = value;
  const ids = new Set(value.evidence.map(segment => segment.id));
  if (contentHash(JSON.stringify(payload)) !== reportSha256 || value.decisions.length > value.unresolvedCount || ids.size !== value.evidence.length ||
      value.evidence.some(segment => segment.endLine < segment.startLine || !segment.id.startsWith(segment.source === "issue" ? "I" : "P")) ||
      value.decisions.some(decision => decision.evidenceIds.some(id => !ids.has(id)))) {
    context.addIssue({ code: "custom", message: "report integrity validation failed" });
  }
});
export type SupervisedDecisionReport = z.infer<typeof SupervisedDecisionReportSchema>;
const envelopeSchema = z.object({
  version: z.literal("supervised-analysis-envelope/v1"), result: FeasibilityResultSchema,
  decisions: z.array(SupervisedDecisionSchema).max(16), provenance: SupervisedInputProvenanceSchema,
  manifest: z.array(EvidenceSegmentSchema).max(512),
}).strict();

/** Revalidates the internal envelope against current canonical evidence, never model provenance. */
export function createSupervisedDecisionReport(raw: SupervisedAnalysisEnvelope, expected: {
  repository: string; issueNumber: number; planCommentId: string; planSha256: string; defaultBranchSha: string;
  observedAt: string; executionEnabled: boolean;
}): SupervisedDecisionReport | undefined {
  try {
    const envelope = envelopeSchema.parse(raw);
    const provenance = envelope.provenance;
    if (provenance.repository !== expected.repository || provenance.issueNumber !== expected.issueNumber || provenance.planCommentId !== expected.planCommentId || provenance.planSha256 !== expected.planSha256 || provenance.defaultBranchSha !== expected.defaultBranchSha ||
        envelope.result.provenance.artifactSha256 !== provenance.inputArtifactSha256 || JSON.stringify(envelope.result.unresolvedDecisions) !== JSON.stringify(envelope.decisions.map(decision => decision.code))) throw new Error();
    if (envelope.decisions.length === 0) return undefined;
    const unique = new Map<string, z.infer<typeof reportDecisionSchema>>();
    for (const decision of envelope.decisions) {
      const evidenceIds = [...new Set(decision.evidenceIds)].sort();
      const item = { code: decision.code, evidenceIds, reviewPrompt: decisionPrompts[decision.code] };
      unique.set(`${item.code}:${evidenceIds.join(",")}`, item);
    }
    const decisions = [...unique.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
    const referenced = new Set(decisions.flatMap(decision => decision.evidenceIds));
    const evidence = envelope.manifest.filter(segment => referenced.has(segment.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const payload = payloadSchema.parse({ version: "supervised-decision-report/v1", event: "supervised_decision_report", authority: "model_reported_not_verified", executionEnabled: expected.executionEnabled,
      observedAt: expected.observedAt, provenance, unresolvedCount: envelope.decisions.length, decisions, evidence });
    const report = SupervisedDecisionReportSchema.parse({ ...payload, reportSha256: contentHash(JSON.stringify(payload)) });
    if (Buffer.byteLength(JSON.stringify(report), "utf8") > 32_768) throw new Error();
    return report;
  } catch { throw new Error("supervised decision report validation failed"); }
}

/** Local review helper: returns line ranges, never source text or model-selected URLs. */
export function locateDecisionEvidence(raw: unknown, id: string, body: string): { source: "issue" | "plan"; startLine: number; endLine: number } {
  try {
    const report = SupervisedDecisionReportSchema.parse(raw);
    const segment = report.evidence.find(value => value.id === id);
    if (!segment || contentHash(body) !== (segment.source === "issue" ? report.provenance.issueBodySha256 : report.provenance.planSha256)) throw new Error();
    const current = evidenceSegments(body, segment.source).find(value => value.id === id);
    if (!current || JSON.stringify(current) !== JSON.stringify(segment)) throw new Error();
    return { source: segment.source, startLine: segment.startLine, endLine: segment.endLine };
  } catch { throw new Error("decision evidence is unavailable or has changed"); }
}
