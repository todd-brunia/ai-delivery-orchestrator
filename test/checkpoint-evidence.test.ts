import { describe, expect, it } from "vitest";
import { buildCheckpointEvidence, checkpointDigest, ReceiptCountsSchema, revalidateCheckpointSnapshot, validateCheckpointEvidence } from "../src/domain/sprint-delivery/v1/checkpoint-evidence.js";
import { contentHash, prepareSupervisedArtifact } from "../src/providers/v1/supervised-analysis.js";

const repository = "todd-brunia/ai-consulting-client-portal";
const timestamp = "2026-09-12T16:00:00Z";
const now = new Date(timestamp);
const plan = "<!-- codex-implementation-plan -->\n\nFull plan stays present.";
const facts = { repository, repositoryId: "123", issueNumber: 142, issueNodeId: "I_142", issueUpdatedAt: timestamp, planCommentId: "456", planSha256: contentHash(plan), planUpdatedAt: timestamp, defaultBranchSha: "a".repeat(40), workflow: "implementation.yml", adapterFingerprint: "b".repeat(64), configurationFingerprint: "c".repeat(64), installationId: "789", appId: "123", permissionsFingerprint: "d".repeat(64) };
const approval = { issueNumber: 142, label: "approved-for-build", actorLogin: "todd-brunia", actorType: "User", occurredAt: timestamp, evidence: { uri: `github://issues/${repository}/142/events/1`, observedAt: timestamp } };
const counts = { work_items: "0", bindings: "0", dispatch_attempts: "0", accepted_dispatches: "0", outbox_intents: "0", mutation_receipts: "0" };
const receipts = { repository, issueNumber: 142, observedAt: timestamp, status: "clear_at_observation", counts };
const build = () => buildCheckpointEvidence(facts, [approval], receipts, now);

describe("checkpoint evidence", () => {
  it("records a descriptive route and requirements without granting authority", () => {
    const packet = build();
    expect(packet.publishingRoute).toEqual({ route: "local_operator", selection: "owner_selected", capability: "not_evaluated", creationAuthorized: false });
    expect(Object.values(packet.futureGates)).toEqual(Array(4).fill("not_authorized"));
    expect(validateCheckpointEvidence(packet, facts, now)).toEqual(packet);
  });
  it.each(Object.keys(counts))("blocks any existing %s", key => {
    expect(() => buildCheckpointEvidence(facts, [approval], { ...receipts, counts: { ...counts, [key]: "1" } }, now)).toThrow("acquisition failed");
  });
  it.each([
    { ...receipts, status: "not_observed", counts: null },
    { ...receipts, repository: "other/repository" },
    { ...receipts, issueNumber: 74 },
    { ...receipts, observedAt: "2026-09-12T15:54:59Z" },
    { ...receipts, observedAt: "2026-09-12T16:00:01Z" },
    { ...receipts, counts: { work_items: "0" } },
    { ...receipts, extra: "private-sentinel" },
  ])("rejects unavailable, partial, wrong-scope or stale observations", observation => {
    expect(() => buildCheckpointEvidence(facts, [approval], observation, now)).toThrow("acquisition failed");
  });
  it.each([
    [], [{ ...approval, actorType: "Bot" }], [{ ...approval, issueNumber: 74 }],
    [{ ...approval, occurredAt: "2026-09-12T15:59:59Z" }],
    [{ ...approval, occurredAt: "2026-09-12T16:00:01Z" }],
    [{ ...approval, evidence: { ...approval.evidence, observedAt: "2026-09-12T15:54:59Z" } }],
    [{ ...approval, evidence: { ...approval.evidence, uri: "github://issues/other/repository/142/events/1" } }],
  ].map(approvals => ({ approvals })))("requires fresh independently attributable human approval", ({ approvals }) => {
    expect(() => buildCheckpointEvidence(facts, approvals, receipts, now)).toThrow("acquisition failed");
  });
  it("reuses a digest only after fresh matching observations, within five minutes", () => {
    const prior = build();
    const later = new Date("2026-09-12T16:01:00Z");
    const fresh = buildCheckpointEvidence(facts, [{ ...approval, evidence: { ...approval.evidence, observedAt: later.toISOString() } }], { ...receipts, observedAt: later.toISOString() }, later);
    expect(checkpointDigest(fresh)).not.toBe(checkpointDigest(prior));
    expect(revalidateCheckpointSnapshot(prior, fresh, later)).toEqual(prior);
    expect(() => revalidateCheckpointSnapshot({ ...prior, facts: { ...facts, defaultBranchSha: "e".repeat(40) } }, fresh, later)).toThrow();
    expect(() => revalidateCheckpointSnapshot({ ...prior, approval: { ...prior.approval, actorLogin: "someone-else" } }, fresh, later)).toThrow("changed");
    expect(() => validateCheckpointEvidence(prior, facts, new Date("2026-09-12T16:05:00Z"))).toThrow("stale");
    expect(() => validateCheckpointEvidence({ ...prior, publishingRoute: { ...prior.publishingRoute, creationAuthorized: true } }, facts, now)).toThrow();
  });
  it("hashes the full packet into actual model input without replacing the full plan", () => {
    const bytes = JSON.stringify({ version: "model-artifact/v1", kind: "issue_bundle", repository, defaultBranchSha: facts.defaultBranchSha, issues: [{ number: 142, title: "Fixture", body: "Issue", labels: [], updatedAt: timestamp, plan: { commentId: facts.planCommentId, bodySha256: facts.planSha256, updatedAt: timestamp, body: plan } }] });
    const artifact = { kind: "issue_bundle" as const, bytes, sha256: contentHash(bytes) };
    const request = { version: "providers/v1" as const, repository, issueNumbers: [142], planFingerprints: { "142": facts.planSha256 }, defaultBranchSha: facts.defaultBranchSha };
    const legacy = prepareSupervisedArtifact(artifact, request);
    const augmented = prepareSupervisedArtifact(artifact, request, build());
    expect(augmented.provenance.inputArtifactSha256).not.toBe(legacy.provenance.inputArtifactSha256);
    expect(JSON.parse(augmented.artifact.bytes)).toMatchObject({ checkpointEvidence: build(), issues: [{ plan: { body: plan } }] });
    expect(() => prepareSupervisedArtifact(artifact, request, { ...build(), facts: { ...facts, planCommentId: "999" } })).toThrow();
    expect(ReceiptCountsSchema.safeParse({ ...counts, work_items: "-1" }).success).toBe(false);
  });
});
