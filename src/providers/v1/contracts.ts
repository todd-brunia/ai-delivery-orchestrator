import { z } from "zod";

import { ConflictDomainSchema, DependencyEdgeSchema, RepositoryNameSchema, RiskAssessmentSchema } from "../../domain/sprint-delivery/v1/index.js";

export const PROVIDER_CONTRACT_VERSION = "providers/v1" as const;
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);

export const CanonicalIssueSchema = z.object({ version: z.literal(PROVIDER_CONTRACT_VERSION), repository: RepositoryNameSchema, number: z.number().int().positive(), nodeId: z.string().min(1), title: z.string().max(1000), body: z.string().max(100_000), state: z.enum(["open", "closed"]), labels: z.array(z.string().min(1)).max(100), updatedAt: z.iso.datetime({ offset: true }) }).strict();
export type CanonicalIssue = z.infer<typeof CanonicalIssueSchema>;

export const CanonicalPullRequestSchema = z.object({ version: z.literal(PROVIDER_CONTRACT_VERSION), repository: RepositoryNameSchema, number: z.number().int().positive(), nodeId: z.string().min(1), issueNumber: z.number().int().positive(), state: z.enum(["open", "closed", "merged"]), draft: z.boolean(), baseSha: shaSchema, headSha: shaSchema, changedFiles: z.array(z.string().min(1)).max(3000), updatedAt: z.iso.datetime({ offset: true }) }).strict();
export type CanonicalPullRequest = z.infer<typeof CanonicalPullRequestSchema>;

export const GitHubMutationIntentSchema = z.object({ version: z.literal(PROVIDER_CONTRACT_VERSION), idempotencyKey: z.string().min(8).max(200), repository: RepositoryNameSchema, actorId: z.string().min(1), type: z.enum(["set_labels", "dispatch_workflow", "submit_review", "mark_ready_for_review"]), issueNumber: z.number().int().positive().optional(), pullRequestNumber: z.number().int().positive().optional(), expectedHeadSha: shaSchema.optional(), parameters: z.record(z.string(), z.unknown()) }).strict();
export type GitHubMutationIntent = z.infer<typeof GitHubMutationIntentSchema>;

const usageSchema = z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).strict();
const provenanceSchema = z.object({ model: z.string().min(1), modelVersion: z.string().min(1), policyVersion: z.string().min(1), artifactSha256: z.string().regex(/^[a-f0-9]{64}$/), usage: usageSchema }).strict();

export const FeasibilityRequestSchema = z.object({ version: z.literal(PROVIDER_CONTRACT_VERSION), repository: RepositoryNameSchema, issueNumbers: z.array(z.number().int().positive()).min(1), planFingerprints: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)), defaultBranchSha: shaSchema }).strict();
export const FeasibilityResultSchema = z.object({ feasible: z.boolean(), dependencies: z.array(DependencyEdgeSchema), conflicts: z.array(z.object({ issueNumber: z.number().int().positive(), domains: z.array(ConflictDomainSchema) }).strict()), risk: RiskAssessmentSchema, unresolvedDecisions: z.array(z.string().min(1).max(2000)), evidenceUris: z.array(z.string().min(1)), provenance: provenanceSchema }).strict();
export type FeasibilityRequest = z.infer<typeof FeasibilityRequestSchema>;
export type FeasibilityResult = z.infer<typeof FeasibilityResultSchema>;

export const PullRequestReviewRequestSchema = z.object({ version: z.literal(PROVIDER_CONTRACT_VERSION), repository: RepositoryNameSchema, pullRequestNumber: z.number().int().positive(), baseSha: shaSchema, headSha: shaSchema, diffSha256: z.string().regex(/^[a-f0-9]{64}$/), planFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const PullRequestReviewResultSchema = z.object({ verdict: z.enum(["pass", "request_changes", "blocked"]), findings: z.array(z.object({ path: z.string().min(1), line: z.number().int().positive().optional(), severity: z.enum(["low", "medium", "high", "critical"]), evidence: z.string().min(1).max(4000), recommendation: z.string().min(1).max(4000) }).strict()).max(100), evidenceUris: z.array(z.string().min(1)), provenance: provenanceSchema }).strict();
export type PullRequestReviewRequest = z.infer<typeof PullRequestReviewRequestSchema>;
export type PullRequestReviewResult = z.infer<typeof PullRequestReviewResultSchema>;
