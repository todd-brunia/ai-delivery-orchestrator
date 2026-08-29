import { describe, expect, it } from "vitest";

import { SchedulingDecisionSchema, scheduleDryRun } from "../src/domain/sprint-delivery/v1/index.js";

const runId = "c0a8013a-1b2c-4d5e-8f90-123456789abc";
const evidence = [{ kind: "issue" as const, uri: "github://issue/10" }];
const candidate = (issueNumber: number, value: string, confidence: "low" | "high" = "high") => ({
  issueNumber, state: "ready_to_build", conflictDomains: [{ kind: "path" as const, value, confidence }],
});

describe("dry-run scheduling", () => {
  it("selects at most two disjoint candidates in stable issue order", () => {
    const result = scheduleDryRun({ runId, candidates: [candidate(12, "c"), candidate(10, "a"), candidate(11, "b")], dependencies: [], mergedIssueNumbers: [], activeImplementationCount: 0, evidence });
    expect(result.selectedIssueNumbers).toEqual([10, 11]);
    expect(result.blockers).toEqual([{ issueNumber: 12, reasons: ["parallel_limit_reached"], relatedIssueNumbers: [10, 11] }]);
    expect(result.proposedActions).toHaveLength(4);
  });

  it("blocks unresolved prerequisites, conflict overlap, and low confidence", () => {
    const dependency = { prerequisiteIssueNumber: 9, dependentIssueNumber: 10, kind: "blocks" as const };
    const result = scheduleDryRun({ runId, candidates: [candidate(10, "a"), candidate(11, "src/auth"), candidate(12, "src/auth/file", "low")], dependencies: [dependency], mergedIssueNumbers: [], activeImplementationCount: 0, evidence });
    expect(result.selectedIssueNumbers).toEqual([11]);
    expect(result.blockers[0]).toMatchObject({ issueNumber: 10, reasons: ["unresolved_prerequisite"] });
    expect(result.blockers[1]).toMatchObject({ issueNumber: 12, reasons: ["low_confidence", "conflict_domain_overlap"] });
  });

  it("accounts for existing active capacity and rejects unsupported contracts", () => {
    const result = scheduleDryRun({ runId, candidates: [candidate(10, "a"), candidate(11, "b")], dependencies: [], mergedIssueNumbers: [], activeImplementationCount: 1, evidence });
    expect(result.selectedIssueNumbers).toEqual([10]);
    expect(result.blockers[0]?.reasons).toEqual(["parallel_limit_reached"]);
    expect(() => SchedulingDecisionSchema.parse({ ...result, version: "schedule-decision/v2" })).toThrow();
    expect(() => scheduleDryRun({ runId, candidates: [], dependencies: [], mergedIssueNumbers: [], activeImplementationCount: 3, evidence })).toThrow("between zero and two");
  });

  it("honors an adapter's lower parallel limit even when the global ceiling permits two", () => {
    const result = scheduleDryRun({ runId, candidates: [candidate(10, "a"), candidate(11, "b")], dependencies: [], mergedIssueNumbers: [], activeImplementationCount: 0, maximumConcurrentImplementations: 1, evidence });
    expect(result).toMatchObject({ maximumConcurrentImplementations: 1, selectedIssueNumbers: [10] });
    expect(result.blockers).toEqual([{ issueNumber: 11, reasons: ["parallel_limit_reached"], relatedIssueNumbers: [10] }]);
    expect(() => scheduleDryRun({ runId, candidates: [], dependencies: [], mergedIssueNumbers: [], activeImplementationCount: 2, maximumConcurrentImplementations: 1, evidence })).toThrow("between zero and two");
  });
});
