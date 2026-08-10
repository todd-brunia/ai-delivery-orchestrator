import { createHash } from "node:crypto";

import { z } from "zod";

import {
  RUN_AUTHORIZATION_VERSION,
  RepositoryNameSchema,
  RunAuthorizationSchema,
  SUPPORTED_AUTOMATIC_MERGE_POLICY_VERSION,
  type RunAuthorization,
  type WorkItemState,
} from "./contracts.js";

const sha256Pattern = /^[a-f0-9]{64}$/;
const gitShaPattern = /^[a-f0-9]{40}$/;

export function canonicalAuthorizationJson(authorization: RunAuthorization): string {
  return JSON.stringify(RunAuthorizationSchema.parse(authorization));
}

export function fingerprintAuthorization(authorization: RunAuthorization): string {
  return createHash("sha256")
    .update(canonicalAuthorizationJson(authorization), "utf8")
    .digest("hex");
}

export const CanonicalAuthorizationObservationSchema = z
  .object({
    repository: RepositoryNameSchema,
    issueNumbers: z.array(z.number().int().positive()).min(1).max(100),
    plans: z
      .array(
        z
          .object({
            issueNumber: z.number().int().positive(),
            planSha256: z.string().regex(sha256Pattern),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    defaultBranchSha: z.string().regex(gitShaPattern),
    policy: z
      .object({
        version: z.string().trim().min(1).max(200),
        sha256: z.string().regex(sha256Pattern),
      })
      .strict(),
  })
  .strict();

export type AuthorizationDenialReason =
  | "unsupported_schema"
  | "unsupported_policy"
  | "invalid_evidence"
  | "repository_drift"
  | "scope_drift"
  | "plan_drift"
  | "default_branch_drift"
  | "policy_drift";

export type AuthorizationDecision =
  | { readonly authorized: true; readonly fingerprint: string }
  | { readonly authorized: false; readonly reasons: readonly AuthorizationDenialReason[] };

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function evaluateRunAuthorization(
  rawAuthorization: unknown,
  rawObservation: unknown,
): AuthorizationDecision {
  const authorization = RunAuthorizationSchema.safeParse(rawAuthorization);
  if (!authorization.success) {
    const object = rawAuthorization as { schemaVersion?: unknown; policy?: { version?: unknown } };
    const reasons: AuthorizationDenialReason[] = [];
    if (object?.schemaVersion !== RUN_AUTHORIZATION_VERSION) reasons.push("unsupported_schema");
    if (object?.policy?.version !== SUPPORTED_AUTOMATIC_MERGE_POLICY_VERSION) {
      reasons.push("unsupported_policy");
    }
    if (reasons.length === 0) reasons.push("invalid_evidence");
    return { authorized: false, reasons };
  }

  const observation = CanonicalAuthorizationObservationSchema.safeParse(rawObservation);
  if (!observation.success) return { authorized: false, reasons: ["invalid_evidence"] };
  const expected = authorization.data;
  const actual = observation.data;
  const reasons: AuthorizationDenialReason[] = [];
  if (expected.repository !== actual.repository) reasons.push("repository_drift");
  if (!sameNumbers(expected.issueNumbers, actual.issueNumbers)) reasons.push("scope_drift");
  if (JSON.stringify(expected.plans) !== JSON.stringify(actual.plans)) reasons.push("plan_drift");
  if (expected.defaultBranchSha !== actual.defaultBranchSha) reasons.push("default_branch_drift");
  if (actual.policy.version !== SUPPORTED_AUTOMATIC_MERGE_POLICY_VERSION) {
    reasons.push("unsupported_policy");
  } else if (expected.policy.sha256 !== actual.policy.sha256) {
    reasons.push("policy_drift");
  }
  return reasons.length > 0
    ? { authorized: false, reasons }
    : { authorized: true, fingerprint: fingerprintAuthorization(expected) };
}

export const AuthorizationBoundMergeEventSchema = z
  .object({
    type: z.enum([
      "capture_exact_head",
      "check_automatic_merge_policy",
      "authorize_merger",
      "request_exact_head_merge",
      "record_exact_head_merge",
    ]),
    authorizationFingerprint: z.string().regex(sha256Pattern),
    pullRequestHeadSha: z.string().regex(gitShaPattern),
  })
  .strict();

export type AuthorizationBoundMergeEvent = z.infer<
  typeof AuthorizationBoundMergeEventSchema
>;

const automaticTransitions: Partial<
  Record<WorkItemState, Partial<Record<AuthorizationBoundMergeEvent["type"], WorkItemState>>>
> = {
  ready_for_human_review: { capture_exact_head: "exact_head_captured" },
  exact_head_captured: { check_automatic_merge_policy: "automatic_merge_policy_check" },
  automatic_merge_policy_check: { authorize_merger: "ready_for_merger" },
  ready_for_merger: { request_exact_head_merge: "merge_requested" },
  merge_requested: { record_exact_head_merge: "merged" },
};

export function transitionAutomaticMerge(
  current: WorkItemState,
  rawEvent: unknown,
  binding: { readonly authorizationFingerprint: string; readonly pullRequestHeadSha: string },
): WorkItemState {
  const event = AuthorizationBoundMergeEventSchema.parse(rawEvent);
  if (
    event.authorizationFingerprint !== binding.authorizationFingerprint ||
    event.pullRequestHeadSha !== binding.pullRequestHeadSha
  ) {
    throw new Error("automatic merge evidence binding changed");
  }
  const next = automaticTransitions[current]?.[event.type];
  if (!next) throw new Error(`Invalid automatic merge transition: ${current} + ${event.type}`);
  return next;
}
