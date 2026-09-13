import { createHash } from "node:crypto";
import { z } from "zod";
import { RepositoryNameSchema } from "./contracts.js";
import { CanonicalHumanBuildApprovalSchema } from "../../../providers/v1/contracts.js";
import { RuntimeObservationSchema, type RuntimeObservation } from "./runtime-evidence.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true });
const count = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
export const ReceiptCountsSchema = z.object({ work_items: count, bindings: count, dispatch_attempts: count, accepted_dispatches: count, outbox_intents: count, mutation_receipts: count }).strict();
export const ReceiptObservationSchema = z.object({
  repository: RepositoryNameSchema, issueNumber: z.number().int().positive(), observedAt: instant,
  status: z.enum(["not_observed", "clear_at_observation", "records_present"]), counts: ReceiptCountsSchema.nullable(),
}).strict();
export type ReceiptObservation = z.infer<typeof ReceiptObservationSchema>;
export interface CheckpointReceiptPort { observe(repository: string, issueNumber: number): Promise<ReceiptObservation>; }
export const CheckpointFactsSchema = z.object({
  repository: RepositoryNameSchema, repositoryId: z.string().regex(/^[0-9]{1,20}$/), issueNumber: z.number().int().positive(),
  issueNodeId: z.string().min(1).max(200), issueUpdatedAt: instant,
  planCommentId: z.string().regex(/^[0-9]{1,20}$/), planSha256: hash, planUpdatedAt: instant,
  defaultBranchSha: z.string().regex(/^[a-f0-9]{40}$/), workflow: z.string().regex(/^[A-Za-z0-9_.-]+\.ya?ml$/),
  adapterFingerprint: hash, configurationFingerprint: hash, installationId: z.string().regex(/^[0-9]{1,20}$/), appId: z.string().regex(/^[0-9]{1,20}$/), permissionsFingerprint: hash,
}).strict();
export type CheckpointFacts = z.infer<typeof CheckpointFactsSchema>;
export const CHECKPOINT_FRESHNESS_MS = 5 * 60_000;
const CheckpointEvidenceV1Schema = z.object({
  version: z.literal("supervised-checkpoint-evidence/v1"), checkpoint: z.literal("implementation_dispatch_observation"),
  assessmentMode: z.literal("preflight"), assessmentExecutionEnabled: z.literal(false), observedAt: instant, expiresAt: instant,
  facts: CheckpointFactsSchema,
  approval: z.object({ actorLogin: z.string().regex(/^[A-Za-z0-9-]{1,100}$/), occurredAt: instant, evidenceUri: z.string().min(1).max(2000) }).strict(),
  receipts: ReceiptObservationSchema,
  publishingRoute: z.object({ route: z.literal("local_operator"), selection: z.literal("owner_selected"), capability: z.literal("not_evaluated"), creationAuthorized: z.literal(false) }).strict(),
  futureGates: z.object({ workflowDispatch: z.literal("not_authorized"), fixturePublication: z.literal("not_authorized"), awsMigrations: z.literal("not_authorized"), callbackEnablement: z.literal("not_authorized") }).strict(),
  acceptanceCriteria: z.tuple([z.literal("accepted_immutable_workflow_receipt"), z.literal("canonical_workflow_ref_attempt_correlation"), z.literal("successful_evidence_only_validation"), z.literal("preserved_sanitized_records")]),
}).strict();
export const CheckpointEvidenceSchema = z.discriminatedUnion("version", [
  CheckpointEvidenceV1Schema,
  CheckpointEvidenceV1Schema.extend({ version: z.literal("supervised-checkpoint-evidence/v2"), runtime: RuntimeObservationSchema }),
]);
export type CheckpointEvidence = z.infer<typeof CheckpointEvidenceSchema>;
export const checkpointDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

/** Validates descriptive evidence only. It grants no mutation authority. */
export function validateCheckpointEvidence(raw: unknown, expected: CheckpointFacts, now: Date): CheckpointEvidence {
  try {
    const packet = CheckpointEvidenceSchema.parse(raw);
    const facts = CheckpointFactsSchema.parse(expected);
    const time = now.getTime();
    const observed = Date.parse(packet.observedAt), expires = Date.parse(packet.expiresAt), receiptTime = Date.parse(packet.receipts.observedAt);
    if (packet.version === "supervised-checkpoint-evidence/v2" && (packet.runtime.constraints.repository !== facts.repository ||
        packet.runtime.mode !== "preflight" || packet.runtime.executionEnabled || Date.parse(packet.runtime.observedAt) > observed ||
        time - Date.parse(packet.runtime.observedAt) >= CHECKPOINT_FRESHNESS_MS)) throw new Error();
    if (!Number.isFinite(time) || checkpointDigest(packet.facts) !== checkpointDigest(facts) || observed > time || time >= expires || expires - observed !== CHECKPOINT_FRESHNESS_MS ||
        receiptTime > observed || observed - receiptTime > CHECKPOINT_FRESHNESS_MS || time - receiptTime > CHECKPOINT_FRESHNESS_MS ||
        Date.parse(facts.planUpdatedAt) > observed || Date.parse(facts.issueUpdatedAt) > observed || Date.parse(packet.approval.occurredAt) < Date.parse(facts.planUpdatedAt) || Date.parse(packet.approval.occurredAt) > observed ||
        packet.receipts.repository !== facts.repository || packet.receipts.issueNumber !== facts.issueNumber || packet.receipts.status !== "clear_at_observation" ||
        !packet.receipts.counts || Object.values(packet.receipts.counts).some(value => value !== "0") ||
        !packet.approval.evidenceUri.startsWith(`github://issues/${facts.repository}/${facts.issueNumber}/events/`) || !/^[0-9]+$/.test(packet.approval.evidenceUri.slice(`github://issues/${facts.repository}/${facts.issueNumber}/events/`.length))) throw new Error();
    return packet;
  } catch { throw new Error("checkpoint evidence is invalid, stale, or blocked"); }
}

export function buildCheckpointEvidence(rawFacts: CheckpointFacts, rawApprovals: unknown, rawReceipts: unknown, now: Date, runtime?: RuntimeObservation): CheckpointEvidence {
  try {
    const facts = CheckpointFactsSchema.parse(rawFacts);
    const approvals = CanonicalHumanBuildApprovalSchema.array().max(1000).parse(rawApprovals);
    if (approvals.some(value => value.issueNumber !== facts.issueNumber || Date.parse(value.occurredAt) > now.getTime() || Date.parse(value.evidence.observedAt) > now.getTime() || now.getTime() - Date.parse(value.evidence.observedAt) > CHECKPOINT_FRESHNESS_MS)) throw new Error();
    const current = approvals.filter(value => value.issueNumber === facts.issueNumber && Date.parse(value.occurredAt) >= Date.parse(facts.planUpdatedAt) && Date.parse(value.occurredAt) <= now.getTime())
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || a.evidence.uri.localeCompare(b.evidence.uri))[0];
    if (!current || Date.parse(current.evidence.observedAt) > now.getTime() || now.getTime() - Date.parse(current.evidence.observedAt) > CHECKPOINT_FRESHNESS_MS) throw new Error();
    return validateCheckpointEvidence({ version: runtime ? "supervised-checkpoint-evidence/v2" : "supervised-checkpoint-evidence/v1", ...(runtime ? { runtime } : {}), checkpoint: "implementation_dispatch_observation", assessmentMode: "preflight", assessmentExecutionEnabled: false,
      observedAt: now.toISOString(), expiresAt: new Date(now.getTime() + CHECKPOINT_FRESHNESS_MS).toISOString(), facts,
      approval: { actorLogin: current.actorLogin, occurredAt: current.occurredAt, evidenceUri: current.evidence.uri }, receipts: rawReceipts,
      publishingRoute: { route: "local_operator", selection: "owner_selected", capability: "not_evaluated", creationAuthorized: false },
      futureGates: { workflowDispatch: "not_authorized", fixturePublication: "not_authorized", awsMigrations: "not_authorized", callbackEnablement: "not_authorized" },
      acceptanceCriteria: ["accepted_immutable_workflow_receipt", "canonical_workflow_ref_attempt_correlation", "successful_evidence_only_validation", "preserved_sanitized_records"],
    }, facts, now);
  } catch { throw new Error("checkpoint evidence acquisition failed"); }
}

/** Reuse original timestamps only after a fresh independent acquisition matches its facts. */
export function revalidateCheckpointSnapshot(raw: unknown, fresh: CheckpointEvidence, now: Date): CheckpointEvidence {
  const current = validateCheckpointEvidence(fresh, fresh.facts, now);
  const prior = validateCheckpointEvidence(raw, current.facts, now);
  if (prior.version !== current.version || (prior.version === "supervised-checkpoint-evidence/v2" && current.version === "supervised-checkpoint-evidence/v2" && checkpointDigest(prior.runtime) !== checkpointDigest(current.runtime))) throw new Error("checkpoint runtime observations changed");
  if (checkpointDigest(prior.approval) !== checkpointDigest(current.approval) || checkpointDigest(prior.receipts.counts) !== checkpointDigest(current.receipts.counts)) throw new Error("checkpoint observations changed");
  return prior;
}
