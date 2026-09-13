import { createHash } from "node:crypto";
import { z } from "zod";
import { FeasibilityRequestSchema, FeasibilityResultSchema, ModelArtifactSchema, type FeasibilityRequest, type FeasibilityResult, type ModelArtifact } from "./contracts.js";
import { RepositoryNameSchema } from "../../domain/sprint-delivery/v1/contracts.js";
import { CheckpointEvidenceSchema, type CheckpointEvidence } from "../../domain/sprint-delivery/v1/checkpoint-evidence.js";
import { CHECKPOINT_ASSESSMENT_INSTRUCTIONS, CHECKPOINT_ASSESSMENT_POLICY_VERSION } from "./supervised-checkpoint-prompt.js";

export const DecisionCodeSchema = z.enum(["scope_boundary", "acceptance_evidence", "dependency_readiness", "fixture_publishing_path", "checkpoint_consumption", "operational_authorization", "runtime_readiness", "conflicting_evidence", "unclassified"]);
export const decisionPrompts: Readonly<Record<z.infer<typeof DecisionCodeSchema>, string>> = Object.freeze({
  scope_boundary: "Clarify the intended change and explicit exclusions.",
  acceptance_evidence: "Specify the evidence needed to accept this checkpoint.",
  dependency_readiness: "Verify the prerequisite and its completion evidence.",
  fixture_publishing_path: "Identify the existing authorized source/ref publishing path.",
  checkpoint_consumption: "Verify retained receipts before authorizing another dispatch.",
  operational_authorization: "Identify the separate operational approval being requested.",
  runtime_readiness: "Verify the exact runtime, migration, or callback prerequisites.",
  conflicting_evidence: "Reconcile conflicting issue and plan statements.",
  unclassified: "Review the bound issue and plan; this report cannot identify the decision precisely.",
});
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.string().regex(/^[IP][0-9]{4}$/);
export const SupervisedDecisionSchema = z.object({ code: DecisionCodeSchema.describe("An unresolved question for human review, not an authorization or an instruction to perform an action."), evidenceIds: z.array(idSchema).max(4).describe("References from the supplied evidenceManifest only; use an empty array if no supplied segment applies.") }).strict();
export const SupervisedAnalysisWireSchema = FeasibilityResultSchema.extend({
  version: z.literal("supervised-analysis/v2"),
  unresolvedDecisions: z.array(SupervisedDecisionSchema).max(16),
}).strict();
export const SupervisedInputProvenanceSchema = z.object({
  repository: RepositoryNameSchema, issueNumber: z.number().int().positive(),
  planCommentId: z.string().regex(/^[0-9]{1,20}$/), planSha256: hashSchema,
  issueBodySha256: hashSchema, defaultBranchSha: z.string().regex(/^[a-f0-9]{40}$/), inputArtifactSha256: hashSchema,
}).strict();
export const EvidenceSegmentSchema = z.object({ id: idSchema, source: z.enum(["issue", "plan"]), startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict();
export type EvidenceSegment = z.infer<typeof EvidenceSegmentSchema>;
export interface SupervisedAnalysisEnvelope {
  readonly version: "supervised-analysis-envelope/v1";
  readonly result: FeasibilityResult;
  readonly decisions: readonly z.infer<typeof SupervisedDecisionSchema>[];
  readonly provenance: z.infer<typeof SupervisedInputProvenanceSchema>;
  readonly manifest: readonly EvidenceSegment[];
}
export interface SupervisedAnalysisPort { analyzeSupervisedFeasibility(request: FeasibilityRequest, checkpoint?: CheckpointEvidence): Promise<SupervisedAnalysisEnvelope>; }
export const contentHash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Line ranges refer to the original text. Nothing is truncated or normalized for hashing. */
export function evidenceSegments(body: string, source: "issue" | "plan"): EvidenceSegment[] {
  if (Buffer.byteLength(body, "utf8") > 100_000) throw new Error("evidence content exceeds bounds");
  const lines = body.split(/\r\n|\n|\r/);
  const segments: EvidenceSegment[] = [];
  let start: number | undefined;
  for (let i = 0; i <= lines.length; i += 1) {
    if (i < lines.length && lines[i]!.trim()) { start ??= i + 1; continue; }
    if (start !== undefined) {
      if (segments.length >= 256) throw new Error("evidence segment count exceeds bounds");
      segments.push({ id: `${source === "issue" ? "I" : "P"}${String(segments.length + 1).padStart(4, "0")}`, source, startLine: start, endLine: i });
      start = undefined;
    }
  }
  return segments;
}

const bundleSchema = z.object({
  version: z.literal("model-artifact/v1"), kind: z.literal("issue_bundle"), repository: RepositoryNameSchema,
  defaultBranchSha: z.string().regex(/^[a-f0-9]{40}$/),
  issues: z.array(z.object({ number: z.number().int().positive(), title: z.string(), body: z.string(), labels: z.array(z.string()), updatedAt: z.string(),
    plan: z.object({ commentId: z.string(), bodySha256: hashSchema, updatedAt: z.string(), body: z.string() }).strict(),
  }).strict()).length(1),
}).strict();

export function prepareSupervisedArtifact(raw: ModelArtifact, rawRequest: FeasibilityRequest, checkpoint?: CheckpointEvidence): { artifact: ModelArtifact; provenance: z.infer<typeof SupervisedInputProvenanceSchema>; manifest: EvidenceSegment[] } {
  try {
    const request = FeasibilityRequestSchema.parse(rawRequest);
    const artifact = ModelArtifactSchema.parse(raw);
    if (artifact.kind !== "issue_bundle" || artifact.sha256 !== contentHash(artifact.bytes) || request.issueNumbers.length !== 1) throw new Error();
    const bundle = bundleSchema.parse(JSON.parse(artifact.bytes));
    const issue = bundle.issues[0]!;
    if (bundle.repository !== request.repository || bundle.defaultBranchSha !== request.defaultBranchSha || issue.number !== request.issueNumbers[0] || issue.plan.bodySha256 !== request.planFingerprints[String(issue.number)] || contentHash(issue.plan.body) !== issue.plan.bodySha256 || !issue.plan.body.includes("<!-- codex-implementation-plan -->")) throw new Error();
    const manifest = [...evidenceSegments(issue.body, "issue"), ...evidenceSegments(issue.plan.body, "plan")];
    const packet = checkpoint === undefined ? undefined : CheckpointEvidenceSchema.parse(checkpoint);
    if (packet && (packet.facts.repository !== request.repository || packet.facts.issueNumber !== issue.number || packet.facts.planCommentId !== issue.plan.commentId || packet.facts.planSha256 !== issue.plan.bodySha256 || packet.facts.defaultBranchSha !== request.defaultBranchSha || packet.facts.issueUpdatedAt !== issue.updatedAt || packet.facts.planUpdatedAt !== issue.plan.updatedAt)) throw new Error();
    const bytes = JSON.stringify({ ...bundle, evidenceManifest: { version: "supervised-evidence/v1", segments: manifest }, ...(packet ? { checkpointEvidence: packet, assessmentPolicy: { version: CHECKPOINT_ASSESSMENT_POLICY_VERSION, instructionsSha256: contentHash(CHECKPOINT_ASSESSMENT_INSTRUCTIONS) } } : {}) });
    if (Buffer.byteLength(bytes, "utf8") > 500_000) throw new Error();
    const inputArtifactSha256 = contentHash(bytes);
    const provenance = SupervisedInputProvenanceSchema.parse({ repository: bundle.repository, issueNumber: issue.number, planCommentId: issue.plan.commentId, planSha256: issue.plan.bodySha256, issueBodySha256: contentHash(issue.body), defaultBranchSha: bundle.defaultBranchSha, inputArtifactSha256 });
    return { artifact: { kind: "issue_bundle", bytes, sha256: inputArtifactSha256 }, provenance, manifest };
  } catch { throw new Error("supervised artifact validation failed"); }
}

export function normalizeSupervisedAnalysis(raw: unknown, prepared: ReturnType<typeof prepareSupervisedArtifact>): SupervisedAnalysisEnvelope {
  try {
    const wire = SupervisedAnalysisWireSchema.parse(raw);
    const ids = new Set(prepared.manifest.map(segment => segment.id));
    if (wire.unresolvedDecisions.some(decision => decision.evidenceIds.some(id => !ids.has(id)))) throw new Error();
    const fields = FeasibilityResultSchema.omit({ unresolvedDecisions: true }).parse(Object.fromEntries(Object.entries(wire).filter(([key]) => key !== "version" && key !== "unresolvedDecisions")));
    const result = FeasibilityResultSchema.parse({ ...fields, provenance: { ...fields.provenance, artifactSha256: prepared.provenance.inputArtifactSha256 }, unresolvedDecisions: wire.unresolvedDecisions.map(decision => decision.code) });
    return { version: "supervised-analysis-envelope/v1", result, decisions: wire.unresolvedDecisions, provenance: prepared.provenance, manifest: prepared.manifest };
  } catch { throw new Error("supervised response validation failed"); }
}
