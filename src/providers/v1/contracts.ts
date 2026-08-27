import { z } from "zod";

import { ConflictDomainSchema, DependencyEdgeSchema, RepositoryNameSchema, RiskAssessmentSchema } from "../../domain/sprint-delivery/v1/index.js";

export const PROVIDER_CONTRACT_VERSION = "providers/v1" as const;
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const repositoryIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/);

export const GitHubReadConfigV1Schema = z.object({
  version: z.literal("github-read/v1"),
  repository: RepositoryNameSchema,
  repositoryId: repositoryIdSchema,
  appId: repositoryIdSchema,
  installationId: repositoryIdSchema,
  installationAccount: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
  apiBaseUrl: z.literal("https://api.github.com"),
  apiVersion: z.literal("2022-11-28"),
  maxPages: z.number().int().min(1).max(20),
  maxItems: z.number().int().min(1).max(500),
  maxResponseBytes: z.number().int().min(1_024).max(5_000_000),
  timeoutMilliseconds: z.number().int().min(100).max(30_000),
  tokenTtlSeconds: z.number().int().min(60).max(3_600),
  requiredPermissions: z.object({
    actions: z.literal("read"),
    contents: z.literal("read"),
    issues: z.literal("read"),
    metadata: z.literal("read"),
    pull_requests: z.literal("read"),
  }).strict(),
}).strict();
export type GitHubReadConfigV1 = z.infer<typeof GitHubReadConfigV1Schema>;

export const GitHubReadEvidenceSchema = z.object({
  uri: z.string().min(1).max(2_000),
  observedAt: z.iso.datetime({ offset: true }),
  sha256: sha256Schema.optional(),
}).strict();
export type GitHubReadEvidence = z.infer<typeof GitHubReadEvidenceSchema>;

export const CanonicalPlanSchema = z.object({
  issueNumber: z.number().int().positive(),
  commentId: repositoryIdSchema,
  bodySha256: sha256Schema,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  evidence: GitHubReadEvidenceSchema,
}).strict();
export type CanonicalPlan = z.infer<typeof CanonicalPlanSchema>;

export const CanonicalCheckSchema = z.object({
  name: z.string().min(1).max(500),
  status: z.enum(["queued", "in_progress", "completed"]),
  conclusion: z.enum(["success", "failure", "cancelled", "skipped", "neutral", "timed_out", "action_required", "stale", "unknown"]).optional(),
  headSha: shaSchema,
  evidence: GitHubReadEvidenceSchema,
}).strict();
export type CanonicalCheck = z.infer<typeof CanonicalCheckSchema>;

const evidenceSchema = GitHubReadEvidenceSchema;
export const CanonicalDiffFileSchema = z.object({
  path: z.string().min(1).max(1_000),
  status: z.enum(["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"]),
  previousPath: z.string().min(1).max(1_000).optional(),
  patch: z.string().max(200_000).optional(),
}).strict();
export const CanonicalDiffSchema = z.object({
  repository: RepositoryNameSchema,
  baseSha: shaSchema,
  headSha: shaSchema,
  sha256: sha256Schema,
  files: z.array(CanonicalDiffFileSchema).max(500),
  evidence: evidenceSchema,
}).strict();
export type CanonicalDiff = z.infer<typeof CanonicalDiffSchema>;

export const CanonicalReviewSchema = z.object({
  id: repositoryIdSchema,
  pullRequestNumber: z.number().int().positive(),
  headSha: shaSchema,
  state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
  submittedAt: z.iso.datetime({ offset: true }).optional(),
  authorLogin: z.string().min(1).max(100),
  evidence: evidenceSchema,
}).strict();
export type CanonicalReview = z.infer<typeof CanonicalReviewSchema>;

export const CanonicalWorkflowRunSchema = z.object({
  id: repositoryIdSchema,
  workflowId: repositoryIdSchema,
  workflowPath: z.string().min(1).max(1_000),
  event: z.string().min(1).max(100),
  status: z.enum(["queued", "in_progress", "completed"]),
  conclusion: z.string().min(1).max(100).nullable(),
  headSha: shaSchema,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  evidence: evidenceSchema,
}).strict();
export type CanonicalWorkflowRun = z.infer<typeof CanonicalWorkflowRunSchema>;

export const CanonicalRepositoryConfigurationSchema = z.object({
  repository: RepositoryNameSchema,
  repositoryId: repositoryIdSchema,
  defaultBranch: z.string().min(1).max(255),
  visibility: z.enum(["public", "private", "internal"]),
  allowSquashMerge: z.boolean(),
  archive: z.boolean(),
  configurationSha256: sha256Schema,
  evidence: evidenceSchema,
}).strict();
export type CanonicalRepositoryConfiguration = z.infer<typeof CanonicalRepositoryConfigurationSchema>;

export const CanonicalInstallationSchema = z.object({
  appId: repositoryIdSchema,
  installationId: repositoryIdSchema,
  accountLogin: z.string().min(1).max(100),
  repositoryId: repositoryIdSchema,
  repository: RepositoryNameSchema,
  permissions: z.record(z.string().min(1).max(100), z.string().min(1).max(100)),
  evidence: evidenceSchema,
}).strict();
export type CanonicalInstallation = z.infer<typeof CanonicalInstallationSchema>;

export const OpenAiAnalysisConfigV1Schema = z.object({
  version: z.literal("openai-analysis/v1"),
  projectId: z.string().regex(/^proj_[A-Za-z0-9_-]{8,100}$/),
  credentialReference: z.string().regex(/^ai-delivery-orchestrator\/pilot\/(portal|orchestrator)-openai-(builder|reviewer)-api-key$/),
  timeoutMilliseconds: z.number().int().min(100).max(30_000),
  maxRetries: z.number().int().min(0).max(3),
  maxOutputTokens: z.number().int().min(64).max(16_384),
}).strict();
export type OpenAiAnalysisConfigV1 = z.infer<typeof OpenAiAnalysisConfigV1Schema>;

export const ModelArtifactSchema = z.object({
  kind: z.enum(["issue_bundle", "exact_pull_request_diff"]),
  sha256: sha256Schema,
  bytes: z.string().min(1).max(500_000),
}).strict();
export type ModelArtifact = z.infer<typeof ModelArtifactSchema>;

const mutationBase = {
  version: z.literal("github-mutation/v1"),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/),
  repository: RepositoryNameSchema,
  repositoryId: repositoryIdSchema,
  actorRole: z.enum(["builder", "reviewer"]),
  issueNumber: z.number().int().positive().optional(),
  pullRequestNumber: z.number().int().positive().optional(),
  expectedHeadSha: shaSchema.optional(),
  expectedStateSha256: sha256Schema,
  expiresAt: z.iso.datetime({ offset: true }),
};
export const GitHubExecutionIntentSchema = z.discriminatedUnion("type", [
  z.object({ ...mutationBase, type: z.literal("set_labels"), actorRole: z.literal("builder"), issueNumber: z.number().int().positive(), labels: z.array(z.string().min(1).max(50)).min(1).max(8) }).strict(),
  z.object({ ...mutationBase, type: z.literal("dispatch_workflow"), actorRole: z.literal("builder"), issueNumber: z.number().int().positive(), workflow: z.string().regex(/^[A-Za-z0-9_.-]+\.ya?ml$/), ref: shaSchema, inputs: z.record(z.string(), z.string().max(500)) }).strict(),
  z.object({ ...mutationBase, type: z.literal("submit_review"), actorRole: z.literal("reviewer"), pullRequestNumber: z.number().int().positive(), expectedHeadSha: shaSchema, event: z.enum(["COMMENT", "REQUEST_CHANGES"]), body: z.string().min(1).max(20_000) }).strict(),
  z.object({ ...mutationBase, type: z.literal("mark_ready_for_review"), actorRole: z.literal("builder"), pullRequestNumber: z.number().int().positive(), expectedHeadSha: shaSchema }).strict(),
]);
export type GitHubExecutionIntent = z.infer<typeof GitHubExecutionIntentSchema>;

export const GitHubMutationPolicyV1Schema = z.object({
  version: z.literal("github-mutation-policy/v1"),
  repository: RepositoryNameSchema,
  repositoryId: repositoryIdSchema,
  appId: repositoryIdSchema,
  installationId: repositoryIdSchema,
  enabledOperations: z.array(z.enum(["set_labels", "dispatch_workflow", "submit_review", "mark_ready_for_review"])) .max(4),
  workflowLabels: z.array(z.string().min(1).max(50)).max(20),
  workflows: z.array(z.string().regex(/^[A-Za-z0-9_.-]+\.ya?ml$/)).max(20),
}).strict();
export type GitHubMutationPolicyV1 = z.infer<typeof GitHubMutationPolicyV1Schema>;

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
