import { describe, expect, it } from "vitest";

import {
  DependencyEdgeSchema,
  InvalidTransitionError,
  MergePolicyModeSchema,
  RiskAssessmentSchema,
  SprintRunCommandSchema,
  SprintRunInputSchema,
  WorkItemEventSchema,
  assertAcyclicDependencies,
  decideParallelism,
  planApprovalRequirement,
  transitionSprintRun,
  transitionWorkItem,
} from "../src/domain/sprint-delivery/v1/index.js";

describe("sprint-delivery/v1 contracts", () => {
  it("accepts the explicit v1 input and rejects automatic merge", () => {
    expect(MergePolicyModeSchema.options).toEqual(["human", "automatic"]);
    expect(
      SprintRunInputSchema.parse({
        workflowVersion: "sprint-delivery/v1",
        repository: "todd-brunia/ai-consulting-client-portal",
        issueNumbers: [81, 82, 83],
        mergePolicy: "human",
      }),
    ).toBeDefined();

    expect(() =>
      SprintRunInputSchema.parse({
        workflowVersion: "sprint-delivery/v1",
        repository: "todd-brunia/ai-consulting-client-portal",
        issueNumbers: [81],
        mergePolicy: "automatic",
      }),
    ).toThrow();
  });

  it("rejects duplicate issues and unknown input fields", () => {
    const base = {
      workflowVersion: "sprint-delivery/v1",
      repository: "owner/repository",
      issueNumbers: [4, 4],
      mergePolicy: "human",
    };
    expect(() => SprintRunInputSchema.parse(base)).toThrow("issueNumbers must be unique");
    expect(() =>
      SprintRunInputSchema.parse({ ...base, issueNumbers: [4], surprise: true }),
    ).toThrow();
  });

  it("requires human approval for sensitive or low-confidence plans", () => {
    const ordinary = RiskAssessmentSchema.parse({
      categories: ["ordinary"],
      confidence: "high",
      rationale: "Bounded content change",
    });
    const security = RiskAssessmentSchema.parse({
      categories: ["security"],
      confidence: "high",
      rationale: "Changes an authorization boundary",
    });
    const uncertain = RiskAssessmentSchema.parse({
      categories: ["ordinary"],
      confidence: "low",
      rationale: "The affected boundary is unclear",
    });

    expect(planApprovalRequirement(ordinary)).toBe("policy_may_approve");
    expect(planApprovalRequirement(security)).toBe("human_required");
    expect(planApprovalRequirement(uncertain)).toBe("human_required");
  });

  it("rejects contradictory ordinary and sensitive risk", () => {
    expect(() =>
      RiskAssessmentSchema.parse({
        categories: ["ordinary", "infrastructure"],
        confidence: "high",
        rationale: "Contradictory",
      }),
    ).toThrow("ordinary cannot be combined");
  });

  it("rejects a self dependency", () => {
    expect(() =>
      DependencyEdgeSchema.parse({
        prerequisiteIssueNumber: 4,
        dependentIssueNumber: 4,
        kind: "blocks",
      }),
    ).toThrow("cannot depend on itself");
  });

  it("requires transition identity, concurrency, and evidence metadata", () => {
    const command = {
      type: "pause",
      metadata: {
        transitionId: "c0a8013a-1b2c-4d5e-8f90-123456789abc",
        aggregateId: "c0a8013a-1b2c-4d5e-8f90-123456789abd",
        expectedRevision: 3,
        idempotencyKey: "run:pause:3",
        occurredAt: "2026-07-31T20:00:00-05:00",
        actor: { kind: "human", id: "todd-brunia" },
        evidence: [
          {
            kind: "policy",
            uri: "policy://sprint-delivery/v1",
            sha256: "a".repeat(64),
          },
        ],
      },
    };
    expect(SprintRunCommandSchema.parse(command)).toEqual(command);
    expect(() =>
      SprintRunCommandSchema.parse({
        ...command,
        metadata: { ...command.metadata, idempotencyKey: "short" },
      }),
    ).toThrow();
  });

  it("rejects unknown work-item events", () => {
    expect(() => WorkItemEventSchema.parse("approve_and_merge")).toThrow();
  });
});

describe("state transitions", () => {
  it("advances a sprint through its happy path", () => {
    let state = transitionSprintRun("accepted", { type: "plan_collection_started" });
    state = transitionSprintRun(state, { type: "analysis_started" });
    state = transitionSprintRun(state, { type: "activated" });
    state = transitionSprintRun(state, { type: "completed" });
    expect(state).toBe("completed");
  });

  it("pauses and resumes only to an explicit active state", () => {
    const paused = transitionSprintRun("active", { type: "paused" });
    expect(transitionSprintRun(paused, { type: "resumed", target: "active" })).toBe(
      "active",
    );
    expect(() =>
      transitionSprintRun("active", { type: "resumed", target: "analyzing" }),
    ).toThrow(InvalidTransitionError);
  });

  it("fails closed for invalid or terminal run transitions", () => {
    expect(() => transitionSprintRun("accepted", { type: "completed" })).toThrow(
      InvalidTransitionError,
    );
    expect(() => transitionSprintRun("completed", { type: "cancelled" })).toThrow(
      InvalidTransitionError,
    );
  });

  it("allows recovery outcomes but not progress from a blocked run", () => {
    expect(transitionSprintRun("analyzing", { type: "blocked" })).toBe("blocked");
    expect(transitionSprintRun("blocked", { type: "cancelled" })).toBe("cancelled");
    expect(() => transitionSprintRun("blocked", { type: "activated" })).toThrow(
      InvalidTransitionError,
    );
  });

  it("advances work through human approval and bounded repair", () => {
    let state = transitionWorkItem("discovered", "plan_available");
    state = transitionWorkItem(state, "human_plan_approval_required");
    state = transitionWorkItem(state, "build_authorized");
    state = transitionWorkItem(state, "build_dispatched");
    state = transitionWorkItem(state, "build_started");
    state = transitionWorkItem(state, "pull_request_opened");
    state = transitionWorkItem(state, "checks_awaited");
    state = transitionWorkItem(state, "review_started");
    state = transitionWorkItem(state, "repair_requested");
    state = transitionWorkItem(state, "checks_awaited");
    state = transitionWorkItem(state, "review_started");
    state = transitionWorkItem(state, "human_review_ready");
    state = transitionWorkItem(state, "merged");
    expect(state).toBe("merged");
  });

  it("prevents a work item from skipping required stages", () => {
    expect(() => transitionWorkItem("feasibility_review", "build_dispatched")).toThrow(
      InvalidTransitionError,
    );
    expect(() => transitionWorkItem("merged", "checks_awaited")).toThrow(
      InvalidTransitionError,
    );
  });
});

describe("parallelism policy", () => {
  const first = {
    issueNumber: 10,
    conflictDomains: [{ kind: "path", value: "src/auth", confidence: "high" }] as const,
  };
  const second = {
    issueNumber: 11,
    conflictDomains: [{ kind: "path", value: "src/content", confidence: "high" }] as const,
  };

  it("allows two independent, disjoint issues", () => {
    expect(decideParallelism(first, second, [], 0)).toEqual({
      allowed: true,
      reasons: [],
    });
  });

  it("denies direct or transitive dependency paths", () => {
    const edges = [
      { prerequisiteIssueNumber: 10, dependentIssueNumber: 12, kind: "blocks" },
      { prerequisiteIssueNumber: 12, dependentIssueNumber: 11, kind: "blocks" },
    ] as const;
    expect(decideParallelism(first, second, edges, 0)).toMatchObject({
      allowed: false,
      reasons: ["dependency_path"],
    });
  });

  it("denies overlapping paths, low confidence, and a third implementation", () => {
    const overlap = {
      issueNumber: 11,
      conflictDomains: [
        { kind: "path", value: "src/auth/session.ts", confidence: "low" },
      ] as const,
    };
    expect(decideParallelism(first, overlap, [], 2)).toEqual({
      allowed: false,
      reasons: [
        "parallel_limit_reached",
        "low_confidence",
        "conflict_domain_overlap",
      ],
    });
  });

  it("fails closed for an invalid active implementation count", () => {
    expect(() => decideParallelism(first, second, [], -1)).toThrow(
      "activeImplementationCount must be a nonnegative integer",
    );
  });
});

describe("dependency graph policy", () => {
  it("accepts an acyclic graph", () => {
    expect(() =>
      assertAcyclicDependencies(
        [10, 11, 12],
        [
          { prerequisiteIssueNumber: 10, dependentIssueNumber: 11, kind: "blocks" },
          { prerequisiteIssueNumber: 11, dependentIssueNumber: 12, kind: "blocks" },
        ],
      ),
    ).not.toThrow();
  });

  it("rejects cycles", () => {
    expect(() =>
      assertAcyclicDependencies(
        [10, 11, 12],
        [
          { prerequisiteIssueNumber: 10, dependentIssueNumber: 11, kind: "blocks" },
          { prerequisiteIssueNumber: 11, dependentIssueNumber: 12, kind: "blocks" },
          { prerequisiteIssueNumber: 12, dependentIssueNumber: 10, kind: "blocks" },
        ],
      ),
    ).toThrow("dependency graph contains a cycle");
  });

  it("rejects edges outside the immutable sprint list", () => {
    expect(() =>
      assertAcyclicDependencies(
        [10, 11],
        [{ prerequisiteIssueNumber: 10, dependentIssueNumber: 99, kind: "blocks" }],
      ),
    ).toThrow("outside the sprint");
  });
});
