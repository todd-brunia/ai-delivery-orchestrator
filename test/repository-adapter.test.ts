import { describe, expect, it } from "vitest";

import { parseRepositoryAdapterConfigV1 } from "../src/domain/sprint-delivery/v1/index.js";

const validConfig = {
  version: 1,
  repository: "todd-brunia/ai-consulting-client-portal",
  defaultBranch: "main",
  enabled: true,
  orchestratorAppSlug: "ai-delivery-orchestrator",
  workflows: {
    implementation: "codex-label-automation.yml",
    repair: "codex-repair.yml",
    sync: "codex-sync.yml",
  },
  labels: {
    needsPlanning: "needs-planning",
    planReady: "plan-ready",
    approvedForBuild: "approved-for-build",
    approvedForAiBuild: "approved-for-ai-build",
    inProgress: "in-progress",
    previewReady: "preview-ready",
    needsDecision: "needs-decision",
    blocked: "blocked",
  },
  requiredChecks: ["CI Gate"],
  maxParallelImplementations: 2,
  risk: {
    humanApprovalCategories: [
      "security",
      "authentication",
      "secrets",
      "infrastructure",
      "destructive_data",
      "billing",
      "workflow_policy",
      "external_communication",
    ],
    humanApprovalLabels: ["security", "devops", "workflow"],
    humanApprovalPathPatterns: [".github/**", "supabase/migrations/**"],
  },
} as const;

describe("RepositoryAdapterConfigV1Schema", () => {
  it("accepts the strict initial repository contract", () => {
    expect(parseRepositoryAdapterConfigV1(validConfig)).toEqual(validConfig);
  });

  it("rejects unknown fields", () => {
    expect(() =>
      parseRepositoryAdapterConfigV1({ ...validConfig, arbitraryCode: true }),
    ).toThrow();
  });

  it("rejects parallelism above the v1 safety limit", () => {
    expect(() =>
      parseRepositoryAdapterConfigV1({
        ...validConfig,
        maxParallelImplementations: 3,
      }),
    ).toThrow();
  });

  it("rejects duplicate labels and checks", () => {
    expect(() =>
      parseRepositoryAdapterConfigV1({
        ...validConfig,
        labels: { ...validConfig.labels, blocked: "in-progress" },
      }),
    ).toThrow("workflow labels must be unique");
    expect(() =>
      parseRepositoryAdapterConfigV1({
        ...validConfig,
        requiredChecks: ["validate", "validate"],
      }),
    ).toThrow("values must be unique");
  });
});
