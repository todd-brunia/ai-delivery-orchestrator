import type { z } from "zod";

import {
  AutomationIdentityContractSchema,
  AutomationOperationSchema,
  IdentityObservationSchema,
  ProtectionObservationSchema,
  type AutomationIdentityContract,
  type AutomationOperation,
} from "./contracts.js";

export type IdentityDenialReason =
  | "invalid_contract"
  | "unknown_operation"
  | "operation_forbidden"
  | "repository_mismatch"
  | "installation_mismatch"
  | "audience_mismatch"
  | "configuration_mismatch"
  | "canonical_data_unavailable"
  | "identity_mismatch"
  | "permission_elevation"
  | "protection_mismatch";

export type IdentityDecision =
  | { readonly authorized: true }
  | { readonly authorized: false; readonly reason: IdentityDenialReason };

export interface IdentityRequest {
  readonly operation: unknown;
  readonly repository: string;
  readonly repositoryId: string;
  readonly installationId: string;
  readonly installationAccount: string;
  readonly configurationRevision: string;
}

export function authorizeIdentityOperation(rawContract: unknown, request: IdentityRequest): IdentityDecision {
  const parsed = AutomationIdentityContractSchema.safeParse(rawContract);
  if (!parsed.success) return { authorized: false, reason: "invalid_contract" };
  const operation = AutomationOperationSchema.safeParse(request.operation);
  if (!operation.success) return { authorized: false, reason: "unknown_operation" };
  const contract = parsed.data;
  if (!contract.allowedOperations.includes(operation.data)) return { authorized: false, reason: "operation_forbidden" };
  if (!contract.tokenAudience.repositories.includes(request.repository as never) || !contract.tokenAudience.repositoryIds.includes(request.repositoryId)) return { authorized: false, reason: "repository_mismatch" };
  if (contract.installationId !== request.installationId) return { authorized: false, reason: "installation_mismatch" };
  if (contract.tokenAudience.installationAccount !== request.installationAccount) return { authorized: false, reason: "audience_mismatch" };
  if (contract.configurationRevision !== request.configurationRevision) return { authorized: false, reason: "configuration_mismatch" };
  return { authorized: true };
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function preflightIdentity(
  rawContract: unknown,
  rawIdentity: unknown,
  rawProtection: unknown,
): IdentityDecision {
  const contract = AutomationIdentityContractSchema.safeParse(rawContract);
  if (!contract.success) return { authorized: false, reason: "invalid_contract" };
  const identity = IdentityObservationSchema.safeParse(rawIdentity);
  const protection = ProtectionObservationSchema.safeParse(rawProtection);
  if (!identity.success || !protection.success) return { authorized: false, reason: "canonical_data_unavailable" };
  const expected = contract.data;
  const actual = identity.data;
  if (actual.appSlug !== expected.appSlug || actual.appId !== expected.appId || actual.installationId !== expected.installationId || actual.installationAccount !== expected.tokenAudience.installationAccount) return { authorized: false, reason: "identity_mismatch" };
  if (!sameValues(actual.repositoryIds, expected.tokenAudience.repositoryIds) || !sameValues(actual.repositories, expected.tokenAudience.repositories)) return { authorized: false, reason: "audience_mismatch" };
  if (actual.permissions.some((permission) => !expected.permissionCeiling.includes(permission))) return { authorized: false, reason: "permission_elevation" };
  if (protection.data.repositoryId !== expected.tokenAudience.repositoryIds[0]) return { authorized: false, reason: "protection_mismatch" };
  return { authorized: true };
}

export type ProtectionObservation = z.infer<typeof ProtectionObservationSchema>;
export type { AutomationIdentityContract, AutomationOperation };
