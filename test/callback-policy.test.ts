import { describe, expect, it } from "vitest";

import { CALLBACK_SUPPORT_MATRIX, callbackRoute, decideCallback, type CallbackAuthorityBinding, type CanonicalCallbackObservation } from "../src/domain/sprint-delivery/v1/index.js";

const repository = "todd-brunia/ai-delivery-orchestrator";
const binding: CallbackAuthorityBinding = { repository, hookId: 8, installationId: 9, issueNodeId: "I_73", planningFingerprint: "a".repeat(64), automationMarker: "orchestrator:73:81", expectedBranch: "automation/81", expectedBaseSha: "b".repeat(40), acceptedWorkflowRunId: "workflow:81", pullRequestNodeId: "PR_81", pullRequestNumber: 81, currentHeadSha: "c".repeat(40) };
const observed: CanonicalCallbackObservation = { repository, hookId: 8, installationId: 9, issueNodeId: "I_73", planningFingerprint: binding.planningFingerprint, automationMarker: binding.automationMarker, branch: binding.expectedBranch, baseSha: binding.expectedBaseSha, workflowRunId: "workflow:81", workflowCompleted: true, pullRequestNodeId: "PR_81", pullRequestNumber: 81, pullRequestOpen: true, headSha: "c".repeat(40), requiredChecks: { lint: "success", tests: "success" }, reviewHeadSha: "c".repeat(40) };

describe("callback decision policy", () => {
  it("has an explicit support matrix and ignores unsupported actions after classification", () => {
    expect(CALLBACK_SUPPORT_MATRIX.workflow_run?.has("completed")).toBe(true);
    expect(callbackRoute({ eventName: "workflow_run", action: "deleted", repository, hookId: 8, installationId: 9 })).toBe("unsupported");
    expect(decideCallback({ eventName: "workflow_run", action: "deleted", repository, hookId: 8, installationId: 9 }, binding, observed, "build_dispatched")).toMatchObject({ disposition: "ignored", reason: "unsupported_action", events: [] });
  });

  it("uses canonical workflow evidence for build start and produces a stable semantic key", () => {
    const hint = { eventName: "workflow_run", action: "completed", repository, hookId: 8, installationId: 9 };
    const first = decideCallback(hint, binding, observed, "build_dispatched");
    expect(first).toMatchObject({ route: "workflow", disposition: "ready", events: ["build_started"] });
    expect(decideCallback({ ...hint, action: "requested" }, binding, observed, "build_dispatched").semanticKeys).toEqual(first.semanticKeys);
  });

  it("fails closed on identity, immutable binding, head, and required-check drift", () => {
    const hint = { eventName: "check_run", action: "completed", repository, hookId: 8, installationId: 9 };
    expect(decideCallback({ ...hint, repository: "other/repository" }, binding, observed, "pr_open")).toMatchObject({ disposition: "blocked", reason: "cross_repository_hint" });
    expect(decideCallback(hint, binding, { ...observed, planningFingerprint: "d".repeat(64) }, "pr_open")).toMatchObject({ disposition: "blocked", reason: "immutable_binding_mismatch" });
    expect(decideCallback(hint, binding, { ...observed, headSha: "d".repeat(40) }, "pr_open")).toMatchObject({ disposition: "blocked" });
    expect(decideCallback(hint, binding, { ...observed, requiredChecks: { lint: "success", tests: "pending" } }, "pr_open")).toMatchObject({ disposition: "blocked" });
  });

  it("does not move a later canonical state backward or let a stale review advance it", () => {
    expect(decideCallback({ eventName: "pull_request", action: "synchronize", repository, hookId: 8, installationId: 9 }, binding, observed, "checks_pending")).toMatchObject({ disposition: "ready", reason: "canonical_noop", events: [] });
    expect(decideCallback({ eventName: "pull_request_review", action: "submitted", repository, hookId: 8, installationId: 9 }, binding, { ...observed, reviewHeadSha: "d".repeat(40) }, "checks_pending")).toMatchObject({ disposition: "blocked" });
  });
});
