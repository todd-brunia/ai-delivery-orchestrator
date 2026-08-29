import { CanonicalCheckSchema, CanonicalHumanBuildApprovalSchema, CanonicalIssueSchema, CanonicalPlanSchema, CanonicalPullRequestSchema, FeasibilityRequestSchema, FeasibilityResultSchema, GitHubMutationIntentSchema, PullRequestReviewRequestSchema, PullRequestReviewResultSchema, type CanonicalCheck, type CanonicalHumanBuildApproval, type CanonicalIssue, type CanonicalPlan, type CanonicalPullRequest, type FeasibilityResult, type GitHubMutationIntent, type PullRequestReviewResult } from "./contracts.js";
import type { GitHubMutationPort, GitHubReadPort, ModelAnalysisPort } from "./ports.js";

const clone = <T>(value: T): T => structuredClone(value);
const key = (repository: string, number: number) => `${repository}#${number}`;

export class StubGitHubReadAdapter implements GitHubReadPort {
  private readonly issues = new Map<string, CanonicalIssue>(); private readonly pullRequests = new Map<string, CanonicalPullRequest>(); private readonly plans = new Map<string, CanonicalPlan>(); private readonly approvals = new Map<string, readonly CanonicalHumanBuildApproval[]>(); private readonly checks = new Map<string, readonly CanonicalCheck[]>();
  registerIssue(value: unknown): void { const issue = CanonicalIssueSchema.parse(value); this.issues.set(key(issue.repository, issue.number), clone(issue)); }
  registerPullRequest(value: unknown): void { const pullRequest = CanonicalPullRequestSchema.parse(value); this.pullRequests.set(key(pullRequest.repository, pullRequest.number), clone(pullRequest)); }
  registerMarkedPlan(value: unknown): void { const plan = CanonicalPlanSchema.parse(value); this.plans.set(String(plan.issueNumber), clone(plan)); }
  registerHumanBuildApprovals(repository: string, number: number, value: unknown): void { this.approvals.set(key(repository, number), clone(CanonicalHumanBuildApprovalSchema.array().parse(value))); }
  registerChecks(repository: string, headSha: string, value: unknown): void { const checks = CanonicalCheckSchema.array().max(500).parse(value); this.checks.set(`${repository}@${headSha}`, clone(checks)); }
  async getIssue(repository: string, number: number): Promise<CanonicalIssue> { await Promise.resolve(); const value = this.issues.get(key(repository, number)); if (!value) throw new Error("missing stub issue fixture"); return clone(value); }
  async getPullRequest(repository: string, number: number): Promise<CanonicalPullRequest> { await Promise.resolve(); const value = this.pullRequests.get(key(repository, number)); if (!value) throw new Error("missing stub pull request fixture"); return clone(value); }
  async getMarkedPlan(_repository: string, number: number): Promise<CanonicalPlan> { await Promise.resolve(); const value = this.plans.get(String(number)); if (!value) throw new Error("missing stub plan fixture"); return clone(value); }
  async getHumanBuildApprovals(repository: string, number: number): Promise<readonly CanonicalHumanBuildApproval[]> { await Promise.resolve(); return clone(this.approvals.get(key(repository, number)) ?? []); }
  async getChecks(repository: string, headSha: string): Promise<readonly CanonicalCheck[]> { await Promise.resolve(); const value = this.checks.get(`${repository}@${headSha}`); if (!value) throw new Error("missing stub check fixture"); return clone(value); }
  async getExactDiff(): Promise<never> { await Promise.resolve(); throw new Error("missing stub exact diff fixture"); }
  async getReviews(): Promise<never> { await Promise.resolve(); throw new Error("missing stub review fixture"); }
  async getWorkflowRuns(): Promise<never> { await Promise.resolve(); throw new Error("missing stub workflow run fixture"); }
  async getRepositoryConfiguration(): Promise<never> { await Promise.resolve(); throw new Error("missing stub repository configuration fixture"); }
  async getInstallation(): Promise<never> { await Promise.resolve(); throw new Error("missing stub installation fixture"); }
}

export class StubGitHubMutationAdapter implements GitHubMutationPort {
  private readonly captured: GitHubMutationIntent[] = [];
  async propose(raw: GitHubMutationIntent) { await Promise.resolve(); const intent = GitHubMutationIntentSchema.parse(raw); this.captured.push(clone(intent)); return { accepted: true as const, intentId: intent.idempotencyKey }; }
  invocations(): readonly GitHubMutationIntent[] { return clone(this.captured); }
}

export class StubModelAnalysisAdapter implements ModelAnalysisPort {
  private readonly feasibility = new Map<string, FeasibilityResult>(); private readonly reviews = new Map<string, PullRequestReviewResult>(); private readonly captured: unknown[] = [];
  registerFeasibility(fingerprint: string, value: unknown): void { this.feasibility.set(fingerprint, FeasibilityResultSchema.parse(value)); }
  registerReview(diffSha256: string, value: unknown): void { this.reviews.set(diffSha256, PullRequestReviewResultSchema.parse(value)); }
  async analyzeFeasibility(raw: Parameters<ModelAnalysisPort["analyzeFeasibility"]>[0]): Promise<FeasibilityResult> { await Promise.resolve(); const request = FeasibilityRequestSchema.parse(raw); this.captured.push(clone(request)); const fingerprint = Object.values(request.planFingerprints).sort().join(":"); const result = this.feasibility.get(fingerprint); if (!result) throw new Error("missing stub feasibility fixture"); return clone(result); }
  async reviewPullRequest(raw: Parameters<ModelAnalysisPort["reviewPullRequest"]>[0]): Promise<PullRequestReviewResult> { await Promise.resolve(); const request = PullRequestReviewRequestSchema.parse(raw); this.captured.push(clone(request)); const result = this.reviews.get(request.diffSha256); if (!result) throw new Error("missing stub review fixture"); return clone(result); }
  invocations(): readonly unknown[] { return clone(this.captured); }
}
