import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AutomationIdentityContractSchema,
  AutomationIdentitySetSchema,
  authorizeIdentityOperation,
  preflightIdentity,
} from "../src/domain/automation-identities/v1/index.js";

const contract = {
  schemaVersion: "automation-identities/v1",
  configurationRevision: "a".repeat(64),
  role: "reviewer",
  appSlug: "todd-brunia-ai-delivery-reviewer",
  appId: "1001",
  installationId: "2001",
  tokenAudience: {
    installationAccount: "todd-brunia",
    repositoryIds: ["3001"],
    repositories: ["todd-brunia/ai-consulting-client-portal"],
  },
  permissionCeiling: ["metadata:read", "contents:read", "checks:read", "pull_requests:write"],
  allowedOperations: ["read_pull_request_evidence", "submit_exact_head_review"],
  forbiddenOperations: ["source_write", "ref_write", "merge", "settings_write", "review_dismissal"],
  secretContainerArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:ai-delivery-orchestrator/pilot/github-app-reviewer-private-key-Ab12Cd",
} as const;

const request = {
  operation: "submit_exact_head_review",
  repository: "todd-brunia/ai-consulting-client-portal",
  repositoryId: "3001",
  installationId: "2001",
  installationAccount: "todd-brunia",
  configurationRevision: "a".repeat(64),
};

describe("automation-identities/v1", () => {
  it("pins the provisioned reviewer and merger configuration", () => {
    const load = (role: "reviewer" | "merger") => JSON.parse(
      readFileSync(`config/automation-identities/v1/${role}.json`, "utf8"),
    ) as unknown;
    const reviewer = AutomationIdentityContractSchema.parse(load("reviewer"));
    const merger = AutomationIdentityContractSchema.parse(load("merger"));
    expect(reviewer).toMatchObject({ appId: "4545788", installationId: "152627422" });
    expect(merger).toMatchObject({ appId: "4545894", installationId: "152629499" });
    expect(reviewer.tokenAudience.repositoryIds).toEqual(["1308170964"]);
    expect(merger.tokenAudience.repositoryIds).toEqual(["1308170964"]);
    expect(reviewer.secretContainerArn).not.toBe(merger.secretContainerArn);
  });

  it("accepts a strict role-bound identity", () => {
    expect(AutomationIdentityContractSchema.parse(contract).role).toBe("reviewer");
    expect(() => AutomationIdentityContractSchema.parse({ ...contract, extra: true })).toThrow();
    expect(() => AutomationIdentityContractSchema.parse({ ...contract, appSlug: "generated-suffix" })).toThrow();
    expect(() => AutomationIdentityContractSchema.parse({ ...contract, tokenAudience: { ...contract.tokenAudience, repositories: ["*"] } })).toThrow();
    expect(() => AutomationIdentityContractSchema.parse({ ...contract, permissionCeiling: [...contract.permissionCeiling, "contents:write"] })).toThrow("permissionCeiling must exactly match role policy");
  });

  it("requires unique roles, app IDs, installations, and secret containers", () => {
    const builder = { ...contract, role: "builder", appSlug: "todd-brunia-ai-delivery-builder", appId: "1002", installationId: "2002", permissionCeiling: ["metadata:read", "contents:write", "pull_requests:write"], allowedOperations: ["publish_issue_branch", "open_issue_pull_request"], secretContainerArn: contract.secretContainerArn.replace("reviewer", "builder") };
    const merger = { ...contract, role: "merger", appSlug: "todd-brunia-ai-delivery-merger", appId: "1003", installationId: "2003", permissionCeiling: ["metadata:read", "contents:write"], allowedOperations: ["read_pull_request_evidence", "request_exact_head_squash_merge"], secretContainerArn: contract.secretContainerArn.replace("reviewer", "merger") };
    expect(AutomationIdentitySetSchema.parse([builder, contract, merger])).toHaveLength(3);
    expect(() => AutomationIdentitySetSchema.parse([builder, contract, { ...merger, appId: "1002" }])).toThrow("appId must be unique");
  });

  it("denies every cross-role operation with a stable reason", () => {
    for (const operation of ["publish_issue_branch", "open_issue_pull_request", "request_exact_head_squash_merge"]) {
      expect(authorizeIdentityOperation(contract, { ...request, operation })).toEqual({ authorized: false, reason: "operation_forbidden" });
    }
    expect(authorizeIdentityOperation(contract, request)).toEqual({ authorized: true });
    expect(authorizeIdentityOperation(contract, { ...request, operation: "change_settings" })).toEqual({ authorized: false, reason: "unknown_operation" });
    expect(authorizeIdentityOperation(contract, { ...request, repositoryId: "9999" })).toEqual({ authorized: false, reason: "repository_mismatch" });
  });

  it("fails preflight closed on unavailable, mismatched, or elevated canonical state", () => {
    const identity = { appSlug: contract.appSlug, appId: contract.appId, installationId: contract.installationId, installationAccount: "todd-brunia", repositoryIds: ["3001"], repositories: ["todd-brunia/ai-consulting-client-portal"], permissions: contract.permissionCeiling };
    const protection = { available: true, repositoryId: "3001", repository: "todd-brunia/ai-consulting-client-portal", visibility: "public", baseBranch: "main", requiredStatusCheck: "CI Gate", strictStatusChecks: true, requiredApprovals: 1, dismissStaleReviews: true, requireLastPushApproval: true, requireConversationResolution: true, enforceAdmins: true, requireLinearHistory: true, squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false, autoMergeAllowed: false };
    expect(preflightIdentity(contract, identity, protection)).toEqual({ authorized: true });
    expect(preflightIdentity(contract, identity, { available: false })).toEqual({ authorized: false, reason: "canonical_data_unavailable" });
    expect(preflightIdentity(contract, { ...identity, permissions: [...identity.permissions, "contents:write"] }, protection)).toEqual({ authorized: false, reason: "permission_elevation" });
  });
});
