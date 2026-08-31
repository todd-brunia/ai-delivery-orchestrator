import { createHash } from "node:crypto";

import type { WorkItemEvent, WorkItemState } from "./contracts.js";

export const CALLBACK_POLICY_VERSION = "callback-policy/v1" as const;

export type CallbackRoute = "plan_authorization" | "workflow" | "pull_request" | "checks" | "review" | "installation" | "unsupported";
export type CallbackDisposition = "ready" | "ignored" | "blocked";

/** The only webhook event/actions this policy will consider. Everything else is an attributable no-op. */
export const CALLBACK_SUPPORT_MATRIX: Readonly<Record<string, ReadonlySet<string>>> = {
  issues: new Set(["labeled", "unlabeled", "edited", "closed", "reopened"]),
  workflow_run: new Set(["completed", "requested", "in_progress"]),
  pull_request: new Set(["opened", "reopened", "synchronize", "closed"]),
  check_run: new Set(["created", "completed", "rerequested"]),
  check_suite: new Set(["completed", "rerequested"]),
  pull_request_review: new Set(["submitted", "edited", "dismissed"]),
  installation: new Set(["created", "deleted", "suspend", "unsuspend"]),
  installation_repositories: new Set(["added", "removed"]),
};

export interface CallbackHint {
  readonly eventName: string;
  readonly action: string;
  readonly repository?: string;
  readonly hookId: number;
  readonly installationId: number;
}

export interface CallbackAuthorityBinding {
  readonly repository: string;
  readonly hookId: number;
  readonly installationId: number;
  readonly issueNodeId: string;
  readonly planningFingerprint: string;
  readonly automationMarker: string;
  readonly expectedBranch: string;
  readonly expectedBaseSha: string;
  readonly acceptedWorkflowRunId?: string;
  readonly pullRequestNodeId?: string;
  readonly pullRequestNumber?: number;
  readonly currentHeadSha?: string;
}

export interface CanonicalCallbackObservation {
  readonly repository: string;
  readonly hookId: number;
  readonly installationId: number;
  readonly issueNodeId: string;
  readonly planningFingerprint: string;
  readonly automationMarker: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly workflowRunId?: string;
  readonly workflowCompleted?: boolean;
  readonly pullRequestNodeId?: string;
  readonly pullRequestNumber?: number;
  readonly pullRequestOpen?: boolean;
  readonly headSha?: string;
  readonly requiredChecks?: Readonly<Record<string, "success" | "pending" | "failure" | "unknown">>;
  readonly reviewHeadSha?: string;
}

export interface CallbackDecision {
  readonly route: CallbackRoute;
  readonly disposition: CallbackDisposition;
  readonly reason: string;
  readonly events: readonly WorkItemEvent[];
  readonly semanticKeys: readonly string[];
}

export function callbackRoute(hint: CallbackHint): CallbackRoute {
  if (!CALLBACK_SUPPORT_MATRIX[hint.eventName]?.has(hint.action)) return "unsupported";
  if (hint.eventName === "issues") return "plan_authorization";
  if (hint.eventName === "workflow_run") return "workflow";
  if (hint.eventName === "pull_request") return "pull_request";
  if (hint.eventName === "check_run" || hint.eventName === "check_suite") return "checks";
  if (hint.eventName === "pull_request_review") return "review";
  return "installation";
}

/**
 * Produces forward-only catch-up transitions from canonical state. Webhook hints
 * select no identity, SHA, transition, or policy outcome by themselves.
 */
export function decideCallback(
  hint: CallbackHint,
  binding: CallbackAuthorityBinding,
  observation: CanonicalCallbackObservation,
  currentState: WorkItemState,
): CallbackDecision {
  const route = callbackRoute(hint);
  if (route === "unsupported") return decision(route, "ignored", "unsupported_action", [], binding, observation);
  if (hint.repository !== undefined && hint.repository !== binding.repository) return decision(route, "blocked", "cross_repository_hint", [], binding, observation);
  if (!sameAuthority(binding, observation)) return decision(route, "blocked", "canonical_identity_mismatch", [], binding, observation);
  if (route === "installation") return decision(route, "blocked", "installation_reconciliation_required", [], binding, observation);
  if (!sameImmutableBinding(binding, observation)) return decision(route, "blocked", "immutable_binding_mismatch", [], binding, observation);

  const events = routeEvents(route, binding, observation, currentState);
  return events === undefined
    ? decision(route, "blocked", "canonical_state_incomplete_or_invalid", [], binding, observation)
    : decision(route, "ready", events.length === 0 ? "canonical_noop" : "canonical_catch_up", events, binding, observation);
}

function sameAuthority(binding: CallbackAuthorityBinding, observed: CanonicalCallbackObservation): boolean {
  return binding.repository === observed.repository && binding.hookId === observed.hookId && binding.installationId === observed.installationId;
}

function sameImmutableBinding(binding: CallbackAuthorityBinding, observed: CanonicalCallbackObservation): boolean {
  return binding.issueNodeId === observed.issueNodeId && binding.planningFingerprint === observed.planningFingerprint &&
    binding.automationMarker === observed.automationMarker && binding.expectedBranch === observed.branch && binding.expectedBaseSha === observed.baseSha;
}

function routeEvents(route: CallbackRoute, binding: CallbackAuthorityBinding, observed: CanonicalCallbackObservation, state: WorkItemState): readonly WorkItemEvent[] | undefined {
  if (route === "plan_authorization") return [];
  if (route === "workflow") {
    if (!binding.acceptedWorkflowRunId || observed.workflowRunId !== binding.acceptedWorkflowRunId) return undefined;
    return observed.workflowCompleted && state === "build_dispatched" ? ["build_started"] : [];
  }
  if (route === "pull_request") {
    if (!samePullRequest(binding, observed) || !observed.pullRequestOpen || observed.headSha !== binding.currentHeadSha) return undefined;
    return state === "building" ? ["pull_request_opened"] : [];
  }
  if (route === "checks") {
    if (!samePullRequest(binding, observed) || observed.headSha !== binding.currentHeadSha || !allChecksSuccessful(observed.requiredChecks)) return undefined;
    return state === "pr_open" ? ["checks_awaited"] : [];
  }
  if (route === "review") {
    if (!samePullRequest(binding, observed) || observed.reviewHeadSha !== binding.currentHeadSha) return undefined;
    return [];
  }
  return undefined;
}

function samePullRequest(binding: CallbackAuthorityBinding, observed: CanonicalCallbackObservation): boolean {
  return binding.pullRequestNodeId !== undefined && binding.pullRequestNodeId === observed.pullRequestNodeId &&
    binding.pullRequestNumber === observed.pullRequestNumber;
}

function allChecksSuccessful(checks: CanonicalCallbackObservation["requiredChecks"]): boolean {
  const values = checks ? Object.values(checks) : [];
  return values.length > 0 && values.every((value) => value === "success");
}

function decision(route: CallbackRoute, disposition: CallbackDisposition, reason: string, events: readonly WorkItemEvent[], binding: CallbackAuthorityBinding, observed: CanonicalCallbackObservation): CallbackDecision {
  const artifact = createHash("sha256").update(JSON.stringify({ repository: observed.repository, issueNodeId: observed.issueNodeId, planningFingerprint: observed.planningFingerprint, marker: observed.automationMarker, baseSha: observed.baseSha, headSha: observed.headSha ?? null, workflowRunId: observed.workflowRunId ?? null, pullRequestNodeId: observed.pullRequestNodeId ?? null, checks: observed.requiredChecks ?? null, reviewHeadSha: observed.reviewHeadSha ?? null }), "utf8").digest("hex");
  return { route, disposition, reason, events, semanticKeys: events.map((event) => `callback:${CALLBACK_POLICY_VERSION}:${binding.repository}:${binding.issueNodeId}:${event}:${artifact}`) };
}
