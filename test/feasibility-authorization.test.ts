import { describe, expect, it } from "vitest";

import { authorizeBuild, validateFeasibilityForRun } from "../src/domain/sprint-delivery/v1/index.js";

const fingerprint = "a".repeat(64);
const feasible = { feasible: true, dependencies: [], conflicts: [{ issueNumber: 81, domains: [] }], risk: { categories: ["security"], confidence: "high", rationale: "fixture" }, unresolvedDecisions: [], evidenceUris: ["issue://81"], provenance: { model: "stub", modelVersion: "v1", policyVersion: "v1", artifactSha256: fingerprint, usage: { inputTokens: 0, outputTokens: 0 } } };

describe("feasibility and build authorization", () => {
  it("rejects incomplete feasibility coverage and external dependencies", () => {
    expect(() => validateFeasibilityForRun({ ...feasible, conflicts: [] }, [81])).toThrow("cover every");
    expect(() => validateFeasibilityForRun({ ...feasible, dependencies: [{ prerequisiteIssueNumber: 82, dependentIssueNumber: 81, kind: "blocks" }] }, [81])).toThrow("immutable issue scope");
  });

  it("requires fresh attributable approval for sensitive work and binds it to the plan", () => {
    const analysis = validateFeasibilityForRun(feasible, [81]);
    expect(authorizeBuild(analysis, 81, fingerprint, [])).toEqual({ authorized: false, reason: "human_approval_required" });
    expect(authorizeBuild(analysis, 81, fingerprint, [{ issueNumber: 81, planSha256: "b".repeat(64), actor: { kind: "human", id: "maintainer" }, approvedAt: "2026-08-29T20:00:00Z", evidenceUri: "github://review/1" }])).toEqual({ authorized: false, reason: "approval_plan_drift" });
    expect(authorizeBuild(analysis, 81, fingerprint, [{ issueNumber: 81, planSha256: fingerprint, actor: { kind: "human", id: "maintainer" }, approvedAt: "2026-08-29T20:00:00Z", evidenceUri: "github://review/1" }])).toEqual({ authorized: true });
  });
});
